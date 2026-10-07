// The public API under /api (ADR 0009). Imports core/ only, never redirect/ (ADR 0001, ADR 0007).

import { Hono } from "hono";
import { auth } from "./auth.ts";
import type { ApiEnv } from "./context.ts";
import { notFound } from "./errors.ts";
import { authenticate } from "./session.ts";

const v1 = new Hono<ApiEnv>();
v1.use(authenticate);
v1.use(async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
});
v1.route("/auth", auth);

export const api = new Hono<ApiEnv>();
api.route("/v1", v1);
api.all("*", () => notFound());
