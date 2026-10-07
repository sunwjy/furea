// Browser sessions and caller resolution (ADR 0003): the session cookie, the D1 row behind it, and the Origin
// check that refuses cookie-authenticated mutating requests from anywhere but the instance itself.

import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { randomToken, sha256Hex } from "../core/crypto.ts";
import { findSession, insertSession, purgeExpiredSessions } from "../core/db/sessions.ts";
import type { ApiEnv } from "./context.ts";
import { apiError, unauthorized } from "./errors.ts";

export const SESSION_COOKIE = "__Host-furea_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SESSION_ID_BYTES = 32;
/** Added to every failed password attempt, on top of the rate limiters (ADR 0003, *Brute force*). */
export const FAILED_LOGIN_DELAY_MS = 500;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Creates a session row (purging expired ones first) and returns the Set-Cookie value that carries its id. */
export async function startSession(db: D1Database, now = new Date()): Promise<{ id: string; setCookie: string }> {
  const id = randomToken(SESSION_ID_BYTES);
  await purgeExpiredSessions(db, now);
  await insertSession(db, {
    idHash: await sha256Hex(id),
    now,
    expiresAt: new Date(now.getTime() + SESSION_SECONDS * 1000),
  });
  return { id, setCookie: sessionCookie(id, SESSION_SECONDS) };
}

export const clearedSessionCookie = () => sessionCookie("", 0);

function sessionCookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/** Sets `caller` for every API request; refuses a cookie-authenticated mutating request without a matching Origin. */
export const authenticate = createMiddleware<ApiEnv>(async (c, next) => {
  c.set("caller", null);
  const id = getCookie(c, SESSION_COOKIE);
  if (id) {
    const idHash = await sha256Hex(id);
    if ((await findSession(c.env.DB, idHash, new Date())) !== null) {
      if (!SAFE_METHODS.has(c.req.method) && c.req.header("origin") !== new URL(c.req.url).origin) {
        return apiError(403, "forbidden", "Origin does not match this instance.");
      }
      c.set("caller", { kind: "session", scope: "write", sessionIdHash: idHash });
    }
  }
  await next();
});

export const requireCaller = createMiddleware<ApiEnv>(async (c, next) => {
  if (c.var.caller === null) return unauthorized();
  await next();
});

/** Session-only endpoints: an API key can never change authentication (ADR 0009). */
export const requireSession = createMiddleware<ApiEnv>(async (c, next) => {
  if (c.var.caller === null) return unauthorized();
  if (c.var.caller.kind !== "session") return apiError(403, "forbidden", "Session required.");
  await next();
});
