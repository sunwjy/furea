import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Assets-first routing itself is Cloudflare's (wrangler.jsonc, checked in manifest.test.ts); test fetches reach
// the Worker directly, so these tests read the assets binding to check what sits where in the assets root.
describe("the Static Assets root", () => {
  it("holds favicon.ico at the root", async () => {
    const res = await env.ASSETS.fetch("https://s.example.com/favicon.ico");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/vnd.microsoft.icon");
  });

  it("holds the admin shell under /admin/", async () => {
    const res = await env.ASSETS.fetch("https://s.example.com/admin/index.html");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('src="/admin/assets/');
  });

  it("has no SPA fallback, so a slug path misses the assets and reaches the Worker", async () => {
    const res = await env.ASSETS.fetch("https://s.example.com/abc123");
    expect(res.status).toBe(404);
  });
});
