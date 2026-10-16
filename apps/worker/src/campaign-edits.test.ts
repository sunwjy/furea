// Campaign edits that rewrite their links (ADR 0012 *Rewrites*, ADR 0014), a campaign link's own UTM edits, and
// disable all / enable all, through the public API. Sync pending runs the Worker with the fault-injecting KV wrapper
// (docs/testing.md).

import { Campaign, CampaignLinks, CreatedApiKey, Link, UpdatedCampaign, UpdatedCampaignLinks } from "@furea/shared";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { doh } from "../test/doh.ts";
import { insertLink } from "./core/db/links.ts";
import { repairSyncPending } from "./core/sync.ts";
import { createWorker } from "./index.ts";
import { SESSION_COOKIE, startSession } from "./api/session.ts";

const ORIGIN = "https://s.example.com";

let cookie: string;
let writeKey: string;

beforeAll(async () => {
  const { id } = await startSession(env.DB);
  cookie = `${SESSION_COOKIE}=${id}`;
  const res = await api("POST", "/api-keys", { name: "campaign edits write", scope: "write" });
  writeKey = CreatedApiKey.parse(await res.json()).key;
});

beforeEach(() => {
  doh.reset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function request(method: string, path: string, body?: unknown, bearer?: string): Request {
  const headers = new Headers({ origin: ORIGIN });
  if (bearer === undefined) headers.set("cookie", cookie);
  else headers.set("authorization", `Bearer ${bearer}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${ORIGIN}/api/v1${path}`, {
    method,
    headers,
    redirect: "manual",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const api = (method: string, path: string, body?: unknown, bearer?: string) =>
  exports.default.fetch(request(method, path, body, bearer));

async function errorOf(res: Response, status: number) {
  expect(res.status).toBe(status);
  return ((await res.json()) as { error: { code: string; details?: Record<string, unknown>[] } }).error;
}

async function campaignWith(name: string, links: unknown[], extra: Record<string, unknown> = {}) {
  const res = await api("POST", "/campaigns", { name, baseUrl: "https://shop.example/spring?ref=a#top", ...extra });
  expect(res.status).toBe(201);
  const campaign = Campaign.parse(await res.json());
  if (links.length === 0) return { campaign, links: [] };
  const added = await api("POST", `/campaigns/${campaign.id}/links`, { items: links });
  expect(added.status, JSON.stringify(await added.clone().json())).toBe(201);
  return { campaign, links: CampaignLinks.parse(await added.json()).items };
}

const linkOf = async (slug: string) => Link.parse(await (await api("GET", `/links/${slug}`)).json());

async function visit(slug: string) {
  return exports.default.fetch(new Request(`${ORIGIN}/${slug}`, { redirect: "manual" }));
}

describe("PATCH /api/v1/campaigns/:id rewriting fields", () => {
  it("rewrites every member's destination, disabled ones included, and writes each through", async () => {
    const { campaign } = await campaignWith("Rewrite base", [
      { utm: { source: "news", medium: "email" }, slug: "rw-news" },
      { utm: { source: "ig", medium: "social", content: "story a" }, slug: "rw-ig" },
    ]);
    await api("PATCH", "/links/rw-ig", { enabled: false });

    const res = await api("PATCH", `/campaigns/${campaign.id}`, { baseUrl: "https://shop.example/autumn#sale" });
    expect(res.status).toBe(200);
    expect(UpdatedCampaign.parse(await res.json())).toMatchObject({
      baseUrl: "https://shop.example/autumn#sale",
      linkCount: 2,
      syncPendingLinkCount: 0,
      rewrittenLinkCount: 2,
    });

    const news = await linkOf("rw-news");
    expect(news.destination).toBe(
      "https://shop.example/autumn?utm_source=news&utm_medium=email&utm_campaign=Rewrite%20base#sale",
    );
    const ig = await linkOf("rw-ig");
    expect(ig).toMatchObject({
      destination:
        "https://shop.example/autumn?utm_source=ig&utm_medium=social&utm_campaign=Rewrite%20base" +
        "&utm_content=story%20a#sale",
      enabled: false,
      utm: { source: "ig", medium: "social", content: "story a", term: null },
    });
    expect(await env.KV.get("rw-ig", "json")).toEqual({ to: ig.destination, disabled: true });
    expect((await visit("rw-news")).headers.get("location")).toBe(news.destination);
  });

  it("rewrites on a UTM campaign or utm_id change, and a utm_id of null removes it", async () => {
    const { campaign } = await campaignWith("Rewrite utm", [{ utm: { source: "a", medium: "m" }, slug: "rw-utm" }], {
      utmId: "q2",
    });

    const renamed = await api("PATCH", `/campaigns/${campaign.id}`, { utmCampaign: "autumn", utmId: "q3" });
    expect(UpdatedCampaign.parse(await renamed.json())).toMatchObject({
      utmCampaign: "autumn",
      utmId: "q3",
      rewrittenLinkCount: 1,
    });
    expect((await linkOf("rw-utm")).destination).toBe(
      "https://shop.example/spring?ref=a&utm_id=q3&utm_source=a&utm_medium=m&utm_campaign=autumn#top",
    );

    await api("PATCH", `/campaigns/${campaign.id}`, { utmId: null });
    expect((await linkOf("rw-utm")).destination).toBe(
      "https://shop.example/spring?ref=a&utm_source=a&utm_medium=m&utm_campaign=autumn#top",
    );
  });

  it("rewrites nothing for a rename alone or for the values the campaign already has", async () => {
    const { campaign } = await campaignWith("Rewrite same", [{ utm: { source: "a", medium: "m" }, slug: "rw-same" }]);
    const before = await linkOf("rw-same");

    const res = await api("PATCH", `/campaigns/${campaign.id}`, {
      name: "Rewrite same renamed",
      baseUrl: campaign.baseUrl,
      utmCampaign: campaign.utmCampaign,
    });
    expect(UpdatedCampaign.parse(await res.json())).toMatchObject({ name: "Rewrite same renamed", rewrittenLinkCount: 0 });
    const after = await linkOf("rw-same");
    expect({ destination: after.destination, updatedAt: after.updatedAt }).toEqual({
      destination: before.destination,
      updatedAt: before.updatedAt,
    });
  });

  it("writes nothing when the rewrite would push any member past 2048 characters, naming each offending slug", async () => {
    const { campaign } = await campaignWith("Rewrite long", [
      { utm: { source: "s".repeat(900), medium: "m" }, slug: "rw-long-a" },
      { utm: { source: "short", medium: "m" }, slug: "rw-long-ok" },
      { utm: { source: "t".repeat(900), medium: "m" }, slug: "rw-long-b" },
    ]);
    const before = await linkOf("rw-long-a");

    const error = await errorOf(
      await api("PATCH", `/campaigns/${campaign.id}`, {
        name: "Rewrite long renamed",
        baseUrl: `https://shop.example/${"p".repeat(1100)}`,
      }),
      400,
    );
    expect(error.code).toBe("validation_failed");
    expect(error.details?.map(({ field, code, slug }) => ({ field, code, slug }))).toEqual([
      { field: "baseUrl", code: "rewrite_too_long", slug: "rw-long-a" },
      { field: "baseUrl", code: "rewrite_too_long", slug: "rw-long-b" },
    ]);
    expect(Campaign.parse(await (await api("GET", `/campaigns/${campaign.id}`)).json())).toMatchObject({
      name: "Rewrite long",
      baseUrl: campaign.baseUrl,
    });
    expect(await linkOf("rw-long-a")).toEqual(before);
  });

  it("screens the new base URL once: a flagged host writes nothing, a session may override it, an API key may not", async () => {
    const { campaign } = await campaignWith("Rewrite screened", [
      { utm: { source: "a", medium: "m" }, slug: "rw-scr-a" },
      { utm: { source: "b", medium: "m" }, slug: "rw-scr-b" },
    ]);
    doh.reset();
    doh.flag("bad.example");
    const body = { baseUrl: "https://bad.example/" };

    const refused = await errorOf(await api("PATCH", `/campaigns/${campaign.id}`, body), 422);
    expect(refused.code).toBe("destination_flagged");
    expect(refused.details).toMatchObject([{ field: "baseUrl", host: "bad.example" }]);
    expect(doh.lookups).toEqual(["bad.example"]);
    expect((await linkOf("rw-scr-a")).destination).toMatch(/^https:\/\/shop\.example\//);

    const skip = { ...body, screening: "skip" };
    expect((await api("PATCH", `/campaigns/${campaign.id}`, skip, writeKey)).status).toBe(403);
    expect((await api("PATCH", `/campaigns/${campaign.id}`, skip)).status).toBe(200);
    expect((await linkOf("rw-scr-b")).destination).toMatch(/^https:\/\/bad\.example\/\?utm_source=b/);
  });

  it("marks exactly the links whose KV write fails sync pending, and the repair loop fixes them", async () => {
    const { campaign } = await campaignWith("Rewrite faulty", [
      { utm: { source: "a", medium: "m" }, slug: "rw-kv-a" },
      { utm: { source: "b", medium: "m" }, slug: "rw-kv-b" },
      { utm: { source: "c", medium: "m" }, slug: "rw-kv-c" },
    ]);
    await env.DB.exec("UPDATE links SET cache_synced = 1");
    const failing = new Set(["rw-kv-b"]);
    const kv = new Proxy(env.KV, {
      get(target, property) {
        if (property === "put") {
          return (key: string, ...rest: unknown[]) =>
            failing.has(key)
              ? Promise.reject(new Error("injected KV failure"))
              : (target.put as (key: string, ...rest: unknown[]) => Promise<void>)(key, ...rest);
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const ctx = createExecutionContext();
    const res = await createWorker({ fetch }).fetch(
      request("PATCH", `/campaigns/${campaign.id}`, { baseUrl: "https://shop.example/faulty" }),
      { ...env, KV: kv },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(UpdatedCampaign.parse(await res.json())).toMatchObject({ rewrittenLinkCount: 3, syncPendingLinkCount: 1 });
    expect((await linkOf("rw-kv-b")).cacheSynced).toBe(false);
    expect((await linkOf("rw-kv-a")).cacheSynced).toBe(true);
    expect((await linkOf("rw-kv-c")).cacheSynced).toBe(true);

    await repairSyncPending(env.DB, env.KV, { retryDelaysMs: [0, 0] });
    const b = await linkOf("rw-kv-b");
    expect(b.cacheSynced).toBe(true);
    expect(await env.KV.get("rw-kv-b", "json")).toEqual({ to: b.destination, disabled: false });
    expect(Campaign.parse(await (await api("GET", `/campaigns/${campaign.id}`)).json()).syncPendingLinkCount).toBe(0);
  });
});

describe("PATCH /api/v1/links/:slug with utm", () => {
  it("merge-patches a campaign link's own values and recomposes its destination, without screening", async () => {
    await campaignWith("Own utm", [{ utm: { source: "news", medium: "email", term: "shoes" }, slug: "own-a" }]);
    doh.reset();
    doh.flag("shop.example");

    const res = await api("PATCH", "/links/own-a", { utm: { source: " Newsletter ", content: "hero", term: null } });
    expect(res.status).toBe(200);
    const link = Link.parse(await res.json());
    expect(link).toMatchObject({
      destination:
        "https://shop.example/spring?ref=a&utm_source=Newsletter&utm_medium=email&utm_campaign=Own%20utm" +
        "&utm_content=hero#top",
      utm: { source: "Newsletter", medium: "email", content: "hero", term: null },
    });
    expect(doh.lookups).toEqual([]);
    expect(await env.KV.get("own-a", "json")).toEqual({ to: link.destination, disabled: false });
  });

  it("refuses a combination another member holds, ignoring case, and frees the old one", async () => {
    await campaignWith("Own taken", [
      { utm: { source: "news", medium: "email" }, slug: "own-t1" },
      { utm: { source: "ig", medium: "social" }, slug: "own-t2" },
    ]);
    const before = await linkOf("own-t2");

    const taken = await errorOf(await api("PATCH", "/links/own-t2", { utm: { source: "NEWS", medium: "Email" } }), 409);
    expect(taken.code).toBe("utm_combination_taken");
    expect(taken.details).toMatchObject([{ field: "utm", conflictsWith: { slug: "own-t1" } }]);
    expect(await linkOf("own-t2")).toEqual(before);

    expect((await api("PATCH", "/links/own-t1", { utm: { source: "mail" } })).status).toBe(200);
    expect((await api("PATCH", "/links/own-t2", { utm: { source: "news", medium: "email" } })).status).toBe(200);
  });

  it("refuses utm on a plain link and a recomposed destination over 2048 characters", async () => {
    await insertLink(env.DB, { slug: "own-plain", destination: "https://example.com/plain" });
    const plain = await errorOf(await api("PATCH", "/links/own-plain", { utm: { source: "x" } }), 400);
    expect(plain.details).toMatchObject([{ field: "utm", code: "utm_requires_campaign" }]);

    await campaignWith("Own long", [{ utm: { source: "a", medium: "m" }, slug: "own-long" }]);
    const long = await errorOf(await api("PATCH", "/links/own-long", { utm: { content: "c".repeat(2048) } }), 400);
    expect(long.details).toMatchObject([{ field: "utm", code: "destination_invalid" }]);
    expect((await api("PATCH", "/links/noSuchLink", { utm: { source: "x" } })).status).toBe(404);
  });
});

describe("PATCH /api/v1/campaigns/:id/links", () => {
  it("disables and enables every member, writing each through", async () => {
    const { campaign, links } = await campaignWith("Bulk toggle", [
      { utm: { source: "a", medium: "m" }, slug: "tg-a" },
      { utm: { source: "b", medium: "m" }, slug: "tg-b" },
    ]);
    await api("PATCH", "/links/tg-b", { enabled: false });

    const off = await api("PATCH", `/campaigns/${campaign.id}/links`, { enabled: false });
    expect(off.status).toBe(200);
    expect(UpdatedCampaignLinks.parse(await off.json())).toEqual({ updated: 2 });
    expect(await env.KV.get("tg-a", "json")).toEqual({ to: links[0]?.destination, disabled: true });
    expect((await visit("tg-a")).status).toBe(404);

    const on = await api("PATCH", `/campaigns/${campaign.id}/links`, { enabled: true });
    expect(UpdatedCampaignLinks.parse(await on.json())).toEqual({ updated: 2 });
    expect(Campaign.parse(await (await api("GET", `/campaigns/${campaign.id}`)).json())).toMatchObject({
      enabledLinkCount: 2,
    });
    expect((await visit("tg-b")).status).toBe(302);
  });

  it("refuses a body without enabled, and answers 404 for an unknown campaign", async () => {
    const { campaign } = await campaignWith("Bulk toggle refused", []);
    const error = await errorOf(await api("PATCH", `/campaigns/${campaign.id}/links`, {}), 400);
    expect(error.details).toMatchObject([{ field: "enabled" }]);
    expect((await api("PATCH", "/campaigns/noSuchCampgn/links", { enabled: true })).status).toBe(404);
  });
});
