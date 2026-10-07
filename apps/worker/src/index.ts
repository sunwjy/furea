import { Hono } from "hono";
import { admin } from "./admin/index.ts";
import { api } from "./api/index.ts";
import { apiError } from "./api/errors.ts";
import { log, routeKindOf } from "./core/log.ts";
import type { Env } from "./core/env.ts";
import { redirect } from "./redirect/index.ts";

const app = new Hono<{ Bindings: Env }>();

app.route("/api", api);
app.route("/admin", admin);
app.route("/", redirect);

app.onError((err, c) => {
  const route = routeKindOf(c.req.path);
  log({ event: "unhandled_error", route, message: err.message, ...(err.stack ? { stack: err.stack } : {}) });
  if (route === "api") return apiError(500, "internal", "Internal error.");
  return new Response("Internal Server Error", {
    status: 500,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
});

export default app satisfies ExportedHandler<Env>;
