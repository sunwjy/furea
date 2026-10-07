import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { insertLink } from "../core/db/links.ts";

function get(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`https://s.example.com${path}`, init));
}

describe("a navigation into the admin SPA that misses the assets", () => {
  it.each(["/admin", "/admin/", "/admin/login", "/admin/campaigns", "/admin/links/Ab3xYz"])(
    "answers %s with the shell from the assets binding",
    async (path) => {
      const res = await get(path, { headers: { "sec-fetch-mode": "navigate" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain('src="/admin/assets/');
    },
  );

  it("answers a missing file under /admin/ with 404, not the shell", async () => {
    const res = await get("/admin/assets/missing-abc123.js");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("<html");
  });
});

describe("slug paths next to the admin routes", () => {
  it("still reach the redirect path", async () => {
    await insertLink(env.DB, { slug: "adminish", destination: "https://example.com/adminish" });
    const res = await get("/adminish", { headers: { "sec-fetch-mode": "navigate" }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/adminish");
  });

  it("leave other methods on /admin/* to the 405 answer", async () => {
    expect((await get("/admin/login", { method: "POST" })).status).toBe(405);
  });
});
