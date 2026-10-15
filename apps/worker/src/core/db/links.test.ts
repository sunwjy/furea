import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteLink,
  getLink,
  insertLink,
  listLinks,
  listSyncPending,
  markCacheSynced,
  markSyncPending,
  updateLink,
} from "./links.ts";

describe("links", () => {
  it("inserts a link with the schema defaults and reads it back by slug", async () => {
    await insertLink(env.DB, {
      slug: "Db-1",
      destination: "https://example.com/a",
      now: new Date("2026-10-04T01:02:03.004Z"),
    });
    expect(await getLink(env.DB, "Db-1")).toEqual({
      slug: "Db-1",
      destination: "https://example.com/a",
      title: null,
      enabled: 1,
      click_count: 0,
      cache_synced: 1,
      created_at: "2026-10-04T01:02:03.004Z",
      updated_at: "2026-10-04T01:02:03.004Z",
    });
  });

  it("stores the title and the enabled flag", async () => {
    await insertLink(env.DB, { slug: "Db-2", destination: "https://example.com/b", title: "B", enabled: false });
    expect(await getLink(env.DB, "Db-2")).toMatchObject({ title: "B", enabled: 0 });
  });

  it("looks slugs up byte for byte", async () => {
    await insertLink(env.DB, { slug: "Db-Case", destination: "https://example.com/c" });
    expect(await getLink(env.DB, "db-case")).toBeNull();
    expect(await getLink(env.DB, "DB-CASE")).toBeNull();
    expect(await getLink(env.DB, "Db-Case")).not.toBeNull();
  });

  it("reports whether it inserted, and never overwrites a taken slug", async () => {
    expect(await insertLink(env.DB, { slug: "Db-3", destination: "https://example.com/d" })).toBe(true);
    expect(await insertLink(env.DB, { slug: "Db-3", destination: "https://example.com/e" })).toBe(false);
    expect(await getLink(env.DB, "Db-3")).toMatchObject({ destination: "https://example.com/d" });
  });

  it("returns null for an unknown slug", async () => {
    expect(await getLink(env.DB, "nope")).toBeNull();
  });
});

describe("deleteLink", () => {
  it("hard-deletes a link and frees its slug", async () => {
    await insertLink(env.DB, { slug: "Del-1", destination: "https://example.com/old" });
    expect(await deleteLink(env.DB, "Del-1")).toBe(true);
    expect(await getLink(env.DB, "Del-1")).toBeNull();
    expect(await insertLink(env.DB, { slug: "Del-1", destination: "https://example.com/new" })).toBe(true);
  });

  it("reports an unknown slug, matched byte for byte", async () => {
    await insertLink(env.DB, { slug: "Del-2", destination: "https://example.com" });
    expect(await deleteLink(env.DB, "del-2")).toBe(false);
    expect(await getLink(env.DB, "Del-2")).not.toBeNull();
  });
});

describe("updateLink", () => {
  const created = new Date("2026-10-01T00:00:00.000Z");
  const edited = new Date("2026-10-02T00:00:00.000Z");

  it("changes only the given fields, bumps updated_at and returns the row", async () => {
    await insertLink(env.DB, { slug: "Up-1", destination: "https://example.com/a", title: "A", now: created });

    const row = await updateLink(env.DB, "Up-1", { destination: "https://example.com/b", enabled: false }, edited);

    expect(row).toEqual({
      slug: "Up-1",
      destination: "https://example.com/b",
      title: "A",
      enabled: 0,
      click_count: 0,
      cache_synced: 1,
      created_at: created.toISOString(),
      updated_at: edited.toISOString(),
    });
    expect(await getLink(env.DB, "Up-1")).toEqual(row);
  });

  it("clears the title with null and enables a disabled link", async () => {
    await insertLink(env.DB, { slug: "Up-2", destination: "https://example.com", title: "T", enabled: false });
    expect(await updateLink(env.DB, "Up-2", { title: null, enabled: true })).toMatchObject({ title: null, enabled: 1 });
  });

  it("returns the row untouched for an empty change", async () => {
    await insertLink(env.DB, { slug: "Up-3", destination: "https://example.com", now: created });
    expect(await updateLink(env.DB, "Up-3", {}, edited)).toMatchObject({ updated_at: created.toISOString() });
  });

  it("returns null for an unknown slug, matched byte for byte", async () => {
    await insertLink(env.DB, { slug: "Up-4", destination: "https://example.com/4" });
    expect(await updateLink(env.DB, "up-4", { title: "x" })).toBeNull();
    expect(await updateLink(env.DB, "up-4", {})).toBeNull();
    expect(await getLink(env.DB, "Up-4")).toMatchObject({ title: null });
  });
});

describe("cache_synced (ADR 0004)", () => {
  beforeEach(async () => {
    await env.DB.exec("UPDATE links SET cache_synced = 1");
  });

  it("marks a link sync pending and lists pending links, least recently changed first", async () => {
    await insertLink(env.DB, { slug: "Sp-new", destination: "https://example.com", now: new Date("2026-10-03") });
    await insertLink(env.DB, { slug: "Sp-old", destination: "https://example.com", now: new Date("2026-10-01") });
    await insertLink(env.DB, { slug: "Sp-ok", destination: "https://example.com" });
    await markSyncPending(env.DB, "Sp-new");
    await markSyncPending(env.DB, "Sp-old");

    expect((await getLink(env.DB, "Sp-new"))?.cache_synced).toBe(0);
    expect((await listSyncPending(env.DB)).map((r) => r.slug)).toEqual(["Sp-old", "Sp-new"]);
    expect((await listSyncPending(env.DB, 1)).map((r) => r.slug)).toEqual(["Sp-old"]);
  });

  it("clears sync pending only for the version of the row that was written to the cache", async () => {
    await insertLink(env.DB, { slug: "Sp-race", destination: "https://example.com/1", now: new Date("2026-10-01") });
    await markSyncPending(env.DB, "Sp-race");
    const written = (await getLink(env.DB, "Sp-race"))!;
    // A later edit lands while the earlier version's cache write is in flight.
    await updateLink(env.DB, "Sp-race", { destination: "https://example.com/2" }, new Date("2026-10-02"));

    await markCacheSynced(env.DB, written);
    expect((await getLink(env.DB, "Sp-race"))?.cache_synced).toBe(0);

    await markCacheSynced(env.DB, (await getLink(env.DB, "Sp-race"))!);
    expect((await getLink(env.DB, "Sp-race"))?.cache_synced).toBe(1);
  });
});

describe("listLinks", () => {
  // Far-future timestamps put these rows ahead of every other link in the table, so the first page is theirs.
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM links WHERE created_at LIKE '2099-%'");
    const at = (minute: number) => new Date(Date.UTC(2099, 0, 1, 0, minute));
    await insertLink(env.DB, { slug: "a1", destination: "https://example.com/apple", now: at(1) });
    await insertLink(env.DB, { slug: "b2", destination: "https://example.com/b", title: "Banana 100%", now: at(2) });
    // Same instant: ties are ordered by slug, descending and case-sensitively (binary).
    await insertLink(env.DB, { slug: "C3", destination: "https://example.com/c", now: at(3) });
    await insertLink(env.DB, { slug: "c3", destination: "https://example.com/c_d", now: at(3) });
    await insertLink(env.DB, { slug: "d4", destination: "https://shop.example/d", now: at(4) });
  });

  const slugs = (rows: { slug: string }[]) => rows.map((r) => r.slug);

  it("lists newest first, ties broken by slug descending", async () => {
    expect(slugs(await listLinks(env.DB, { limit: 5 }))).toEqual(["d4", "c3", "C3", "b2", "a1"]);
  });

  it("continues after a (createdAt, slug) position without skipping or repeating", async () => {
    const first = await listLinks(env.DB, { limit: 2 });
    expect(slugs(first)).toEqual(["d4", "c3"]);
    const last = first.at(-1)!;
    const rest = await listLinks(env.DB, { limit: 3, after: { createdAt: last.created_at, slug: last.slug } });
    expect(slugs(rest)).toEqual(["C3", "b2", "a1"]);
  });

  it("matches q as a plain substring of slug, title or destination", async () => {
    expect(slugs(await listLinks(env.DB, { limit: 10, q: "shop" }))).toEqual(["d4"]);
    expect(slugs(await listLinks(env.DB, { limit: 10, q: "banana" }))).toEqual(["b2"]);
    expect(slugs(await listLinks(env.DB, { limit: 10, q: "a1" }))).toEqual(["a1"]);
  });

  it("treats % and _ in q as literal characters", async () => {
    expect(slugs(await listLinks(env.DB, { limit: 10, q: "100%" }))).toEqual(["b2"]);
    expect(slugs(await listLinks(env.DB, { limit: 10, q: "c_" }))).toEqual(["c3"]);
  });
});
