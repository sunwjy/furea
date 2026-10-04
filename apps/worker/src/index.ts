import { Hono } from "hono";
import { log, routeKindOf } from "./core/log.ts";
import type { Env } from "./core/env.ts";
import { redirect } from "./redirect/index.ts";

const app = new Hono<{ Bindings: Env }>();

app.route("/", redirect);

app.onError((err, c) => {
  log({ event: "unhandled_error", route: routeKindOf(c.req.path), message: err.message, ...(err.stack ? { stack: err.stack } : {}) });
  return new Response("Internal Server Error", {
    status: 500,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
});

export default app satisfies ExportedHandler<Env>;
