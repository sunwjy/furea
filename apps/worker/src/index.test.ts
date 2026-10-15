import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLink, insertLink, markSyncPending } from "./core/db/links.ts";
import worker from "./index.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("ALTER TABLE links_gone RENAME TO links").catch(() => {});
});

describe("an exception escaping a handler", () => {
  it("is logged as unhandled_error with its route kind and answered with an uncached 500", async () => {
    await insertLink(env.DB, { slug: "boom", destination: "https://example.com/?token=secret" });
    await env.DB.exec("ALTER TABLE links RENAME TO links_gone");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await exports.default.fetch(
      new Request("https://s.example.com/boom", { headers: { "user-agent": "agent-007" } }),
    );

    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({ event: "unhandled_error", route: "redirect", message: expect.any(String) });
    expect(Object.keys(JSON.parse(line)).sort()).toEqual(["event", "message", "route", "stack"]);
    expect(line).not.toContain("secret");
    expect(line).not.toContain("agent-007");
  });
});

describe("the Cron Trigger", () => {
  async function runCron() {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/5 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
  }

  it("repairs every sync-pending link and logs the pass", async () => {
    // More than the handful a write request's tail takes.
    const slugs = Array.from({ length: 8 }, (_, i) => `cron-${i}`);
    for (const slug of slugs) {
      await insertLink(env.DB, { slug, destination: `https://example.com/${slug}` });
      await markSyncPending(env.DB, slug);
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runCron();

    for (const slug of slugs) {
      expect(await env.KV.get(slug, "json")).toEqual({ to: `https://example.com/${slug}`, disabled: false });
      expect((await getLink(env.DB, slug))?.cache_synced).toBe(1);
    }
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { event: "cache_repair", repaired: 8, failed: 0 },
    ]);
  });

  it("logs nothing when nothing is pending", async () => {
    const spies = (["log", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await runCron();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("logs a failing pass as unhandled_error with the cron route kind", async () => {
    await env.DB.exec("ALTER TABLE links RENAME TO links_gone");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await runCron().catch(() => {});

    expect(error.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      expect.objectContaining({ event: "unhandled_error", route: "cron" }),
    ]);
  });
});
