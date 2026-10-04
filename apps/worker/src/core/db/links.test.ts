import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getLink, insertLink } from "./links.ts";

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

  it("refuses a second link with the same slug", async () => {
    await insertLink(env.DB, { slug: "Db-3", destination: "https://example.com/d" });
    await expect(insertLink(env.DB, { slug: "Db-3", destination: "https://example.com/e" })).rejects.toThrow(
      /UNIQUE|PRIMARY KEY/,
    );
  });

  it("returns null for an unknown slug", async () => {
    expect(await getLink(env.DB, "nope")).toBeNull();
  });
});
