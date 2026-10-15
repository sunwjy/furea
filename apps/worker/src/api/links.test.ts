import { GENERATED_SLUG_ALPHABET, Link, LinkPage } from "@furea/shared";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getLink, insertLink, markSyncPending } from "../core/db/links.ts";
import { SESSION_COOKIE, startSession } from "./session.ts";

const ORIGIN = "https://s.example.com";
const GENERATED = new RegExp(`^[${GENERATED_SLUG_ALPHABET}]{6}$`);

let cookie: string;

beforeAll(async () => {
  const { id } = await startSession(env.DB);
  cookie = `${SESSION_COOKIE}=${id}`;
});

function api(path: string, init: RequestInit & { origin?: string; anonymous?: boolean } = {}): Promise<Response> {
  const origin = init.origin ?? ORIGIN;
  const headers = new Headers(init.headers);
  if (!init.anonymous) headers.set("cookie", cookie);
  headers.set("origin", origin);
  return exports.default.fetch(new Request(`${origin}/api/v1${path}`, { ...init, headers, redirect: "manual" }));
}

function create(body: unknown, init: { origin?: string; anonymous?: boolean } = {}): Promise<Response> {
  return api("/links", {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function created(body: unknown): Promise<Link> {
  const res = await create(body);
  expect(res.status).toBe(201);
  return Link.parse(await res.json());
}

function patch(slug: string, body: unknown, init: { anonymous?: boolean } = {}): Promise<Response> {
  return api(`/links/${slug}`, {
    ...init,
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patched(slug: string, body: unknown): Promise<Link> {
  const res = await patch(slug, body);
  expect(res.status).toBe(200);
  return Link.parse(await res.json());
}

function visit(slug: string): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}/${slug}`, { redirect: "manual" }));
}

describe("POST /api/v1/links", () => {
  it("creates a link with a generated slug, writes its cache entry and redirects to it", async () => {
    const res = await create({ destination: "https://example.com/generated" });

    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const link = Link.parse(await res.json());
    expect(link.slug).toMatch(GENERATED);
    expect(link).toEqual({
      slug: link.slug,
      shortUrl: `${ORIGIN}/${link.slug}`,
      destination: "https://example.com/generated",
      title: null,
      enabled: true,
      clickCount: 0,
      cacheSynced: true,
      campaign: null,
      utm: null,
      createdAt: expect.any(String),
      updatedAt: link.createdAt,
    });
    expect(await env.KV.get(link.slug, "json")).toEqual({ to: "https://example.com/generated", disabled: false });
    expect((await visit(link.slug)).headers.get("location")).toBe("https://example.com/generated");
  });

  it("creates a link with a custom slug, kept byte for byte, and a trimmed title", async () => {
    const link = await created({ destination: "https://example.com/c", slug: "Custom_Slug-1", title: "  Launch  " });
    expect(link).toMatchObject({ slug: "Custom_Slug-1", title: "Launch" });
    expect((await api("/links/Custom_Slug-1")).status).toBe(200);
    expect((await api("/links/custom_slug-1")).status).toBe(404);
  });

  it("stores an empty title as null", async () => {
    expect((await created({ destination: "https://example.com", title: "  " })).title).toBeNull();
  });

  it("derives shortUrl from the request's host", async () => {
    const res = await create({ destination: "https://example.com/host" }, { origin: "https://furea.acme.workers.dev" });
    const link = Link.parse(await res.json());
    expect(link.shortUrl).toBe(`https://furea.acme.workers.dev/${link.slug}`);
  });

  it("answers 409 slug_taken for a taken custom slug and leaves the link alone", async () => {
    await created({ destination: "https://example.com/first", slug: "taken" });

    const res = await create({ destination: "https://example.com/second", slug: "taken" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "slug_taken", message: expect.any(String) } });
    expect(await env.KV.get("taken", "json")).toEqual({ to: "https://example.com/first", disabled: false });
  });

  it("reports every failing field in one validation_failed, the instance's own host included", async () => {
    const res = await create({ destination: "https://S.EXAMPLE.COM/loop", slug: "Admin", title: "t".repeat(201), x: 1 });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { field: string; code: string }[] } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details.map(({ field, code }) => ({ field, code }))).toEqual([
      { field: "destination", code: "destination_self" },
      { field: "slug", code: "slug_reserved" },
      { field: "title", code: "title_too_long" },
      { field: "x", code: "unknown_field" },
    ]);
  });

  it.each([
    ["destination_invalid", { destination: "ftp://example.com" }],
    ["slug_invalid", { destination: "https://example.com", slug: "a/b" }],
    ["invalid", {}],
  ])("reports %s", async (code, body) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "validation_failed", details: [{ code }] } });
  });

  it("treats the instance's host written as an absolute name (trailing dot) as itself", async () => {
    const res = await create({ destination: "https://s.example.com./loop" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { details: [{ field: "destination", code: "destination_self" }] } });
  });

  it("accepts a destination on another host of the same domain", async () => {
    expect((await create({ destination: "https://www.s.example.com/" })).status).toBe(201);
  });

  it("refuses bodies that are not JSON, malformed or too large", async () => {
    const form = await api("/links", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "https://example.com",
    });
    expect(form.status).toBe(415);
    expect(await form.json()).toMatchObject({ error: { code: "unsupported_media_type" } });

    const broken = await api("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ error: { code: "invalid_json" } });

    const large = await create({ destination: "https://example.com", title: "t".repeat(65 * 1024) });
    expect(large.status).toBe(413);
    expect(await large.json()).toMatchObject({ error: { code: "payload_too_large" } });
  });

  it("answers 401 without a session", async () => {
    const res = await create({ destination: "https://example.com" }, { anonymous: true });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });
});

describe("GET /api/v1/links", () => {
  // Far-future rows with a marker only they carry, so other tests' links never appear in these pages.
  beforeAll(async () => {
    const at = (minute: number) => new Date(Date.UTC(2098, 0, 1, 0, minute));
    await insertLink(env.DB, { slug: "page-a", destination: "https://example.com/zq-marker/a", now: at(1) });
    await insertLink(env.DB, { slug: "page-b", destination: "https://example.com/b", title: "zq-marker", now: at(2) });
    await insertLink(env.DB, { slug: "page-c", destination: "https://example.com/c", title: "zq-marker", now: at(3) });
  });

  async function page(query: string): Promise<LinkPage> {
    const res = await api(`/links?${query}`);
    expect(res.status).toBe(200);
    return LinkPage.parse(await res.json());
  }

  it("walks the pages newest first with an opaque cursor", async () => {
    const first = await page("q=zq-marker&limit=2");
    expect(first.items.map((l) => l.slug)).toEqual(["page-c", "page-b"]);
    expect(first.items[0]?.shortUrl).toBe(`${ORIGIN}/page-c`);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const second = await page(`q=zq-marker&limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((l) => l.slug)).toEqual(["page-a"]);
    expect(second.nextCursor).toBeNull();
  });

  it("ends with a null cursor when the last page is exactly full", async () => {
    const all = await page("q=zq-marker&limit=3");
    expect(all.items).toHaveLength(3);
    expect(all.nextCursor).toBeNull();
  });

  it("defaults to 50 items", async () => {
    for (let i = 0; i < 51; i++) {
      await insertLink(env.DB, { slug: `many-${i}`, destination: "https://example.com/many-marker" });
    }
    const first = await page("q=many-marker");
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
  });

  it.each([
    ["not base64url", "!!!"],
    ["no separator", btoa("2098-01-01T00:01:00.000Z").replace(/=+$/, "")],
    ["not a timestamp", btoa("yesterday|page-a").replace(/=+$/, "")],
    ["not a slug", btoa("2098-01-01T00:01:00.000Z|a b").replace(/=+$/, "")],
  ])("answers 400 cursor_invalid for a cursor that is %s", async (_, cursor) => {
    const res = await api(`/links?cursor=${encodeURIComponent(cursor)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "cursor_invalid", message: expect.any(String) } });
  });

  it.each(["0", "201", "x"])("refuses limit=%s with validation_failed", async (limit) => {
    const res = await api(`/links?limit=${limit}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "validation_failed", details: [{ field: "limit" }] } });
  });

  it("answers 401 without a session", async () => {
    expect((await api("/links", { anonymous: true })).status).toBe(401);
  });
});

describe("GET /api/v1/links/:slug", () => {
  it("reads one link", async () => {
    await created({ destination: "https://example.com/one", slug: "read-one", title: "One" });
    const res = await api("/links/read-one");
    expect(res.status).toBe(200);
    expect(Link.parse(await res.json())).toMatchObject({ slug: "read-one", title: "One", shortUrl: `${ORIGIN}/read-one` });
  });

  it("answers 404 not_found for an unknown slug", async () => {
    const res = await api("/links/nope-nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("DELETE /api/v1/links/:slug", () => {
  it("hard-deletes the link, removes its cache entry and frees the slug", async () => {
    await created({ destination: "https://example.com/old", slug: "short-lived" });
    expect((await visit("short-lived")).status).toBe(302);

    const res = await api("/links/short-lived", { method: "DELETE" });

    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
    expect(await env.KV.get("short-lived")).toBeNull();
    expect((await visit("short-lived")).status).toBe(404);
    expect((await api("/links/short-lived")).status).toBe(404);
    expect((await created({ destination: "https://example.com/new", slug: "short-lived" })).destination).toBe(
      "https://example.com/new",
    );
  });

  it("removes a leftover cache entry even when the link is already gone, so a retried delete repairs the cache", async () => {
    await env.KV.put("half-deleted", JSON.stringify({ to: "https://example.com/stale", disabled: false }));

    const res = await api("/links/half-deleted", { method: "DELETE" });

    expect(res.status).toBe(404);
    expect(await env.KV.get("half-deleted")).toBeNull();
  });

  it("answers 404 for an unknown slug", async () => {
    const res = await api("/links/never-existed", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("answers 401 without a session", async () => {
    expect((await api("/links/whatever", { method: "DELETE", anonymous: true })).status).toBe(401);
  });
});

describe("PATCH /api/v1/links/:slug", () => {
  it("edits the destination and title, rewrites the cache entry and redirects to the new destination", async () => {
    const before = await created({ destination: "https://example.com/v1", slug: "edit-me", title: "Old" });

    const link = await patched("edit-me", { destination: "https://example.com/v2", title: "  New  " });

    expect(link).toEqual({
      ...before,
      destination: "https://example.com/v2",
      title: "New",
      updatedAt: expect.any(String),
    });
    expect(link.updatedAt > before.updatedAt).toBe(true);
    expect(await env.KV.get("edit-me", "json")).toEqual({ to: "https://example.com/v2", disabled: false });
    expect((await visit("edit-me")).headers.get("location")).toBe("https://example.com/v2");
  });

  it("is a merge-patch: absent fields stay, a null title clears it", async () => {
    await created({ destination: "https://example.com/keep", slug: "merge-me", title: "Keep" });

    expect(await patched("merge-me", { enabled: false })).toMatchObject({
      destination: "https://example.com/keep",
      title: "Keep",
      enabled: false,
    });
    expect(await patched("merge-me", { title: null })).toMatchObject({ title: null, enabled: false });
  });

  it("disables a link: the cache entry says disabled and the redirect path answers the unknown-slug response from KV", async () => {
    await created({ destination: "https://example.com/on", slug: "switch-me" });
    const unknown = await (await visit("no-such-link")).text();

    expect((await patched("switch-me", { enabled: false })).enabled).toBe(false);

    expect(await env.KV.get("switch-me", "json")).toEqual({ to: "https://example.com/on", disabled: true });
    // Re-enable the row behind the cache's back: a D1 lookup would now redirect, the cache entry must not.
    await env.DB.prepare("UPDATE links SET enabled = 1 WHERE slug = 'switch-me'").run();
    const res = await visit("switch-me");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(unknown);
  });

  it("re-enables a disabled link", async () => {
    await created({ destination: "https://example.com/back", slug: "re-enable" });
    await patched("re-enable", { enabled: false });

    expect((await patched("re-enable", { enabled: true })).enabled).toBe(true);

    expect(await env.KV.get("re-enable", "json")).toEqual({ to: "https://example.com/back", disabled: false });
    expect((await visit("re-enable")).headers.get("location")).toBe("https://example.com/back");
  });

  it("answers an empty patch with 200 and rewrites the cache entry, which repairs a lost one", async () => {
    const before = await created({ destination: "https://example.com/empty", slug: "empty-patch" });
    await env.KV.delete("empty-patch");
    await markSyncPending(env.DB, "empty-patch");

    const link = await patched("empty-patch", {});

    expect(link).toEqual({ ...before, cacheSynced: true });
    expect(await env.KV.get("empty-patch", "json")).toEqual({ to: "https://example.com/empty", disabled: false });
    expect((await getLink(env.DB, "empty-patch"))?.cache_synced).toBe(1);
  });

  it("refuses a slug as slug_immutable, together with every other failing field", async () => {
    await created({ destination: "https://example.com/fixed", slug: "fixed-slug" });

    const res = await patch("fixed-slug", { slug: "other", destination: "https://s.example.com/loop", extra: true });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { field: string; code: string }[] } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details.map(({ field, code }) => ({ field, code }))).toEqual([
      { field: "destination", code: "destination_self" },
      { field: "slug", code: "slug_immutable" },
      { field: "extra", code: "unknown_field" },
    ]);
    expect(await getLink(env.DB, "fixed-slug")).toMatchObject({ destination: "https://example.com/fixed" });
  });

  it("answers 404 for an unknown slug, matched byte for byte, without writing the cache", async () => {
    await created({ destination: "https://example.com/case", slug: "Case-Edit" });

    const res = await patch("case-edit", { title: "x" });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    expect(await env.KV.get("case-edit")).toBeNull();
    expect(await getLink(env.DB, "Case-Edit")).toMatchObject({ title: null });
  });

  it("answers 401 without a session", async () => {
    expect((await patch("whatever", {}, { anonymous: true })).status).toBe(401);
  });
});

describe("the tail of a write request", () => {
  it("repairs sync-pending links after the response", async () => {
    // A link whose cache entry never made it to KV.
    await insertLink(env.DB, { slug: "left-behind", destination: "https://example.com/behind" });
    await markSyncPending(env.DB, "left-behind");
    await created({ destination: "https://example.com/trigger", slug: "tail-trigger" });

    expect((await patch("tail-trigger", { title: "Any write" })).status).toBe(200);

    await vi.waitFor(async () => {
      expect(await env.KV.get("left-behind", "json")).toEqual({ to: "https://example.com/behind", disabled: false });
      expect((await getLink(env.DB, "left-behind"))?.cache_synced).toBe(1);
    });
  });

  it("does not run for a read", async () => {
    await insertLink(env.DB, { slug: "read-only-tail", destination: "https://example.com/read" });
    await markSyncPending(env.DB, "read-only-tail");

    expect((await api("/links/read-only-tail")).status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await env.KV.get("read-only-tail")).toBeNull();
    await env.DB.prepare("UPDATE links SET cache_synced = 1 WHERE slug = 'read-only-tail'").run();
  });
});
