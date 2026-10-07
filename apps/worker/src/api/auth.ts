// Authentication endpoints (ADR 0009, *Authentication endpoints*; ADR 0003).

import { LoginRequest, verifyPassword, type LoginMethodResponse, type SessionResponse } from "@furea/shared";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { randomToken, sha256Hex } from "../core/crypto.ts";
import { deleteSession } from "../core/db/sessions.ts";
import { getOrCreateSetting, getSetting } from "../core/db/settings.ts";
import { log } from "../core/log.ts";
import type { ApiEnv } from "./context.ts";
import { apiError } from "./errors.ts";
import {
  clearedSessionCookie,
  FAILED_LOGIN_DELAY_MS,
  requireCaller,
  requireSession,
  startSession,
} from "./session.ts";
import { jsonBody } from "./validate.ts";

export const auth = new Hono<ApiEnv>();

/** Both limiters use a 60-second period (manifest), so a denied client may retry after at most that. */
const RETRY_AFTER_SECONDS = "60";
const GLOBAL_LIMITER_KEY = "login";

auth.get("/login", (c) => c.json({ method: "password" } satisfies LoginMethodResponse));

/**
 * The login brake (ADR 0003, *Brute force*): a per-client limiter keyed by a salted hash of the IP, then an
 * instance-wide one. It runs before the body is read, so malformed attempts count too. The per-client limiter
 * goes first so one client cannot spend the instance-wide budget once it is braked.
 */
const loginBrake = createMiddleware<ApiEnv>(async (c, next) => {
  const salt = await getOrCreateSetting(c.env.DB, "login_ip_salt", () => randomToken(16));
  const clientKey = await sha256Hex(`${salt}:${c.req.header("cf-connecting-ip") ?? ""}`);
  if (!(await c.env.LOGIN_IP_LIMITER.limit({ key: clientKey })).success) return rateLimited("per_client");
  if (!(await c.env.LOGIN_GLOBAL_LIMITER.limit({ key: GLOBAL_LIMITER_KEY })).success) return rateLimited("global");
  await next();
});

function rateLimited(limiter: "per_client" | "global"): Response {
  log({ event: "login_rate_limited", limiter });
  return apiError(429, "rate_limited", "Too many login attempts. Try again later.", {
    headers: { "Retry-After": RETRY_AFTER_SECONDS },
  });
}

auth.post("/login", loginBrake, jsonBody(LoginRequest), async (c) => {
  const stored = await getSetting(c.env.DB, "operator_password_hash");
  // verifyPassword compares digests in constant time; a missing hash fails the same way as a wrong password.
  if (stored === null || !(await verifyPassword(c.var.body.password, stored))) {
    await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
    return apiError(401, "invalid_password", "The password is not correct.");
  }
  const { setCookie } = await startSession(c.env.DB);
  return new Response(null, { status: 204, headers: { "Set-Cookie": setCookie, "Cache-Control": "no-store" } });
});

auth.post("/logout", requireSession, async (c) => {
  if (c.var.caller?.kind === "session") await deleteSession(c.env.DB, c.var.caller.sessionIdHash);
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": clearedSessionCookie(), "Cache-Control": "no-store" },
  });
});

auth.get("/session", requireCaller, (c) => {
  const caller = c.var.caller;
  if (caller === null) throw new Error("requireCaller let an anonymous request through");
  return c.json({ kind: caller.kind, scope: caller.scope, apiKey: null } satisfies SessionResponse);
});
