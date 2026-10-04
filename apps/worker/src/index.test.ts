import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertLink } from "./core/db/links.ts";

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
