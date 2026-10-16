// Deep links into the admin SPA (ADR 0001). Static Assets answer every existing file under /admin/ before the
// Worker runs and have no SPA fallback, so a client-side route such as /admin/campaigns reaches the Worker,
// which answers with the shell from the assets binding. In Access mode (ADR 0003) the Worker answers those only to a
// valid Access JWT, as it does /api/*.

import { Hono } from "hono";
import { accessVerdict, accessVerifier } from "../core/access.ts";
import type { Env } from "../core/env.ts";

export const admin = new Hono<{ Bindings: Env }>();

admin.get("*", async (c) => {
  const url = new URL(c.req.url);
  const access = await accessVerdict(c.env.DB, c.req.raw, accessVerifier);
  if (access.on && access.identity === null) {
    return new Response("Sign in through Cloudflare Access.", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  // Client routes never contain a dot (slugs cannot, ADR 0002), so a dotted path is a missing file, not a route.
  if (url.pathname.slice(url.pathname.lastIndexOf("/")).includes(".")) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  // `/admin/`, not `/admin/index.html`: the default html_handling redirects the latter to the former.
  return c.env.ASSETS.fetch(new Request(new URL("/admin/", url), c.req.raw));
});
