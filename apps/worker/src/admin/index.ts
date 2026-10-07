// Deep links into the admin SPA (ADR 0001). Static Assets answer every existing file under /admin/ before the
// Worker runs and have no SPA fallback, so a client-side route such as /admin/campaigns reaches the Worker,
// which answers with the shell from the assets binding.

import { Hono } from "hono";
import type { Env } from "../core/env.ts";

export const admin = new Hono<{ Bindings: Env }>();

admin.get("*", (c) => {
  const url = new URL(c.req.url);
  // Client routes never contain a dot (slugs cannot, ADR 0002), so a dotted path is a missing file, not a route.
  if (url.pathname.slice(url.pathname.lastIndexOf("/")).includes(".")) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  // `/admin/`, not `/admin/index.html`: the default html_handling redirects the latter to the former.
  return c.env.ASSETS.fetch(new Request(new URL("/admin/", url), c.req.raw));
});
