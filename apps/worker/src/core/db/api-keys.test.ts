import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { deleteApiKey, findApiKeyByHash, insertApiKey, listApiKeys, touchApiKey } from "./api-keys.ts";

const NOW = new Date("2026-10-15T00:00:00.000Z");

function key(id: string, now = NOW) {
  return { id, keyHash: `hash-${id}`, prefix: id.slice(0, 8), name: `key ${id}`, scope: "read" as const, now };
}

describe("api_keys", () => {
  it("stores a key and finds it by the hash of its secret", async () => {
    await insertApiKey(env.DB, key("findMe000001"));
    expect(await findApiKeyByHash(env.DB, "hash-findMe000001")).toEqual({
      id: "findMe000001",
      prefix: "findMe00",
      name: "key findMe000001",
      scope: "read",
      created_at: "2026-10-15T00:00:00.000Z",
      last_used_at: null,
    });
    expect(await findApiKeyByHash(env.DB, "findMe000001")).toBeNull();
  });

  it("lists every key, newest first, without the hash", async () => {
    await insertApiKey(env.DB, key("listOld00001", new Date("2020-01-01T00:00:00.000Z")));
    await insertApiKey(env.DB, key("listNew00001", new Date("2030-01-01T00:00:00.000Z")));
    const ids = (await listApiKeys(env.DB)).map((row) => row.id);
    expect(ids[0]).toBe("listNew00001");
    expect(ids.at(-1)).toBe("listOld00001");
    expect(Object.keys((await listApiKeys(env.DB))[0] ?? {})).not.toContain("key_hash");
  });

  it("deletes a key and reports whether it existed", async () => {
    await insertApiKey(env.DB, key("deleteMe0001"));
    expect(await deleteApiKey(env.DB, "deleteMe0001")).toBe(true);
    expect(await deleteApiKey(env.DB, "deleteMe0001")).toBe(false);
    expect(await findApiKeyByHash(env.DB, "hash-deleteMe0001")).toBeNull();
  });

  it("writes last_used_at at most once per day", async () => {
    await insertApiKey(env.DB, key("touchMe00001"));
    const first = new Date("2026-10-15T08:00:00.000Z");
    expect(await touchApiKey(env.DB, "touchMe00001", first)).toBe(true);
    expect(await touchApiKey(env.DB, "touchMe00001", new Date("2026-10-16T07:59:59.999Z"))).toBe(false);
    expect((await findApiKeyByHash(env.DB, "hash-touchMe00001"))?.last_used_at).toBe(first.toISOString());
    expect(await touchApiKey(env.DB, "touchMe00001", new Date("2026-10-16T08:00:00.000Z"))).toBe(true);
    expect((await findApiKeyByHash(env.DB, "hash-touchMe00001"))?.last_used_at).toBe("2026-10-16T08:00:00.000Z");
  });
});
