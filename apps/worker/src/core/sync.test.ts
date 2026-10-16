import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { getLink, insertLink, markSyncPending, updateLink } from "./db/links.ts";
import { isRootSyncPending, markRootSyncPending, setRootDestination } from "./db/settings.ts";
import { repairSyncPending, writeRootThrough, writeThrough } from "./sync.ts";

/**
 * The real KV binding, except that `put` and `delete` fail for chosen keys: `Infinity` times, or the first n attempts
 * (docs/testing.md: fault injection is the one allowed wrapper; a fake store is not).
 */
function failingPuts(failures: Record<string, number>): { kv: KVNamespace; attempts: Map<string, number> } {
  const attempts = new Map<string, number>();
  const kv = new Proxy(env.KV, {
    get(target, property) {
      if (property === "put" || property === "delete") {
        return (key: string, ...rest: unknown[]) => {
          const attempt = (attempts.get(key) ?? 0) + 1;
          attempts.set(key, attempt);
          if (attempt <= (failures[key] ?? 0)) return Promise.reject(new Error("injected KV failure"));
          return (target[property] as (key: string, ...rest: unknown[]) => Promise<void>)(key, ...rest);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { kv, attempts };
}

const NO_DELAY = { retryDelaysMs: [0, 0] };

type ConsoleSpy = MockInstance<Console["error"]>;

let errors: ConsoleSpy;
let warnings: ConsoleSpy;

beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  // Each test starts with nothing pending, so a repair pass only sees the links the test made pending.
  await env.DB.exec("UPDATE links SET cache_synced = 1");
  await env.DB.exec("DELETE FROM settings WHERE key IN ('root_destination', 'root_destination_sync_pending')");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const logged = (spy: ConsoleSpy): unknown[] => spy.mock.calls.map(([line]) => JSON.parse(String(line)));

async function link(slug: string, destination = `https://example.com/${slug}`) {
  await insertLink(env.DB, { slug, destination });
  return (await getLink(env.DB, slug))!;
}

describe("writeThrough", () => {
  it("writes the cache entry and reports the link synced", async () => {
    const row = await link("Wt-ok");

    const written = await writeThrough(env.DB, env.KV, row, NO_DELAY);

    expect(written.cache_synced).toBe(1);
    expect(await env.KV.get("Wt-ok", "json")).toEqual({ to: "https://example.com/Wt-ok", disabled: false });
    expect(errors).not.toHaveBeenCalled();
  });

  it("writes a disabled link's entry with disabled: true", async () => {
    await link("Wt-off");
    const row = (await updateLink(env.DB, "Wt-off", { enabled: false }))!;

    await writeThrough(env.DB, env.KV, row, NO_DELAY);

    expect(await env.KV.get("Wt-off", "json")).toEqual({ to: "https://example.com/Wt-off", disabled: true });
  });

  it("gives up after three attempts, marks the link sync pending and logs cache_sync_failed", async () => {
    const row = await link("Wt-fail");
    const { kv, attempts } = failingPuts({ "Wt-fail": Infinity });

    const written = await writeThrough(env.DB, kv, row, NO_DELAY);

    expect(attempts.get("Wt-fail")).toBe(3);
    expect(written.cache_synced).toBe(0);
    expect((await getLink(env.DB, "Wt-fail"))?.cache_synced).toBe(0);
    expect(logged(errors)).toEqual([{ event: "cache_sync_failed", slug: "Wt-fail" }]);
  });

  it("succeeds on a later attempt without marking anything", async () => {
    const row = await link("Wt-flaky");
    const { kv, attempts } = failingPuts({ "Wt-flaky": 1 });

    const written = await writeThrough(env.DB, kv, row, NO_DELAY);

    expect(attempts.get("Wt-flaky")).toBe(2);
    expect(written.cache_synced).toBe(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("clears sync pending once a later write reaches the cache", async () => {
    await link("Wt-heal");
    await markSyncPending(env.DB, "Wt-heal");

    const written = await writeThrough(env.DB, env.KV, (await getLink(env.DB, "Wt-heal"))!, NO_DELAY);

    expect(written.cache_synced).toBe(1);
    expect((await getLink(env.DB, "Wt-heal"))?.cache_synced).toBe(1);
  });
});

describe("writeRootThrough", () => {
  it("writes the root destination from D1 under the reserved key", async () => {
    await setRootDestination(env.DB, "https://example.com/home");

    expect(await writeRootThrough(env.DB, env.KV, NO_DELAY)).toBe(true);

    expect(await env.KV.get("_", "json")).toEqual({ to: "https://example.com/home", disabled: false });
    expect(errors).not.toHaveBeenCalled();
  });

  it("deletes the reserved key once the root destination is unset", async () => {
    await env.KV.put("_", JSON.stringify({ to: "https://example.com/old", disabled: false }));
    await setRootDestination(env.DB, null);

    expect(await writeRootThrough(env.DB, env.KV, NO_DELAY)).toBe(true);

    expect(await env.KV.get("_")).toBeNull();
  });

  it.each([
    ["a write", "https://example.com/home"],
    ["an unset", null],
  ])("gives up on %s after three attempts, marks the root sync pending and logs cache_sync_failed", async (_, value) => {
    await setRootDestination(env.DB, value);
    const { kv, attempts } = failingPuts({ _: Infinity });

    expect(await writeRootThrough(env.DB, kv, NO_DELAY)).toBe(false);

    expect(attempts.get("_")).toBe(3);
    expect(await isRootSyncPending(env.DB)).toBe(true);
    expect(logged(errors)).toEqual([{ event: "cache_sync_failed", slug: "_" }]);
  });

  it("clears sync pending once a later write reaches the cache", async () => {
    await setRootDestination(env.DB, "https://example.com/home");
    await markRootSyncPending(env.DB);

    expect(await writeRootThrough(env.DB, env.KV, NO_DELAY)).toBe(true);

    expect(await isRootSyncPending(env.DB)).toBe(false);
  });
});

describe("repairSyncPending", () => {
  it("rewrites every pending link's entry, clears the state and logs the counts", async () => {
    await link("Rp-1");
    await link("Rp-2");
    await link("Rp-3");
    // The cache lags D1: an edit whose KV write failed.
    await env.KV.put("Rp-1", JSON.stringify({ to: "https://example.com/stale", disabled: false }));
    await updateLink(env.DB, "Rp-1", { enabled: false });
    for (const slug of ["Rp-1", "Rp-2", "Rp-3"]) await markSyncPending(env.DB, slug);
    const { kv } = failingPuts({ "Rp-3": Infinity });

    expect(await repairSyncPending(env.DB, kv, NO_DELAY)).toEqual({ repaired: 2, failed: 1 });

    expect(await env.KV.get("Rp-1", "json")).toEqual({ to: "https://example.com/Rp-1", disabled: true });
    expect((await getLink(env.DB, "Rp-1"))?.cache_synced).toBe(1);
    expect((await getLink(env.DB, "Rp-2"))?.cache_synced).toBe(1);
    expect((await getLink(env.DB, "Rp-3"))?.cache_synced).toBe(0);
    expect([...logged(errors), ...logged(warnings)]).toEqual([{ event: "cache_repair", repaired: 2, failed: 1 }]);
  });

  it("repairs at most `limit` links, least recently changed first", async () => {
    for (const slug of ["Rl-1", "Rl-2", "Rl-3"]) {
      await link(slug);
      await markSyncPending(env.DB, slug);
    }

    expect(await repairSyncPending(env.DB, env.KV, { ...NO_DELAY, limit: 2 })).toEqual({ repaired: 2, failed: 0 });
    expect((await getLink(env.DB, "Rl-3"))?.cache_synced).toBe(0);
  });

  it("repairs a sync-pending root destination alongside the links", async () => {
    await setRootDestination(env.DB, "https://example.com/home");
    await markRootSyncPending(env.DB);

    expect(await repairSyncPending(env.DB, env.KV, NO_DELAY)).toEqual({ repaired: 1, failed: 0 });

    expect(await env.KV.get("_", "json")).toEqual({ to: "https://example.com/home", disabled: false });
    expect(await isRootSyncPending(env.DB)).toBe(false);
  });

  it("logs nothing when there is nothing to repair", async () => {
    expect(await repairSyncPending(env.DB, env.KV, NO_DELAY)).toEqual({ repaired: 0, failed: 0 });
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });
});
