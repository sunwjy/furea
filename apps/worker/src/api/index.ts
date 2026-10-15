// The public API under /api (ADR 0009). Imports core/ only, never redirect/ (ADR 0001, ADR 0007).

import { Hono } from "hono";
import { auth } from "./auth.ts";
import type { ApiEnv } from "./context.ts";
import { logUnhandled } from "../core/log.ts";
import { repairSyncPending } from "../core/sync.ts";
import { notFound } from "./errors.ts";
import { links } from "./links.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import { authenticate, SAFE_METHODS } from "./session.ts";

const TAIL_REPAIR_LIMIT = 5;

const v1 = new Hono<ApiEnv>();
v1.use(authenticate);
v1.use(async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
});
// The tail of every write request resyncs a handful of sync-pending links after the response (ADR 0004); the Cron
// Trigger repairs the rest. Only callers allowed to write trigger it, so strangers cannot spend KV writes.
v1.use(async (c, next) => {
  await next();
  if (SAFE_METHODS.has(c.req.method) || c.var.caller?.scope !== "write") return;
  c.executionCtx.waitUntil(
    repairSyncPending(c.env.DB, c.env.KV, { limit: TAIL_REPAIR_LIMIT }).catch((err: unknown) => logUnhandled("api", err)),
  );
});
v1.route("/auth", auth);
v1.route("/links", links);
v1.get("/openapi.json", (c) => c.json(buildOpenApiDocument(c.env.FUREA_VERSION)));

export const api = new Hono<ApiEnv>();
api.route("/v1", v1);
api.all("*", () => notFound());
