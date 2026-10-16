import { Hono } from "hono";
import { admin } from "./admin/index.ts";
import { api } from "./api/index.ts";
import { apiError } from "./api/errors.ts";
import { logUnhandled, routeKindOf } from "./core/log.ts";
import { repairSyncPending } from "./core/sync.ts";
import type { Env } from "./core/env.ts";
import { redirect } from "./redirect/index.ts";

export interface WorkerDeps {
  /** What the Analytics Engine SQL client calls; tests pass one that answers canned SQL API responses. */
  fetch: typeof globalThis.fetch;
}

export function createWorker(deps: WorkerDeps) {
  const app = new Hono<{ Bindings: Env; Variables: { sqlFetch: typeof globalThis.fetch } }>();

  app.use(async (c, next) => {
    c.set("sqlFetch", deps.fetch);
    await next();
  });
  app.route("/api", api);
  app.route("/admin", admin);
  app.route("/", redirect);

  app.onError((err, c) => {
    const route = routeKindOf(c.req.path);
    logUnhandled(route, err);
    if (route === "api") return apiError(500, "internal", "Internal error.");
    return new Response("Internal Server Error", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  });

  return {
    fetch: app.fetch,
    // The Cron Trigger (`*/5 * * * *`, ADR 0004): the safety net that repairs every sync-pending link.
    async scheduled(_controller, env, ctx) {
      ctx.waitUntil(repairSyncPending(env.DB, env.KV).catch((err: unknown) => logUnhandled("cron", err)));
    },
  } satisfies ExportedHandler<Env>;
}

export default createWorker({ fetch: (input, init) => fetch(input, init) });
