// Browser sessions and caller resolution (ADR 0003): the session cookie, the D1 row behind it, the Origin check
// that refuses cookie-authenticated mutating requests from anywhere but the instance itself, and API keys.

import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { accessVerdict, accessVerifier } from "../core/access.ts";
import { API_KEY_PREFIX, randomToken, sha256Hex } from "../core/crypto.ts";
import { findApiKeyByHash, isUseDue, touchApiKey } from "../core/db/api-keys.ts";
import { findSession, insertSession, purgeExpiredSessions } from "../core/db/sessions.ts";
import type { ApiEnv } from "./context.ts";
import { apiError, unauthorized } from "./errors.ts";

export const SESSION_COOKIE = "__Host-furea_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SESSION_ID_BYTES = 32;
/** Added to every failed password attempt, on top of the rate limiters (ADR 0003, *Brute force*). */
export const FAILED_LOGIN_DELAY_MS = 500;

export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

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

/**
 * Sets `caller` for every API request. A bearer `Authorization` header, when present, decides alone: a key that does
 * not match leaves the request anonymous rather than falling back to a cookie sent with it. Keys are looked up in D1 on
 * every request, with no cache, so a revocation takes effect on the next one (ADR 0003).
 */
export const authenticate = createMiddleware<ApiEnv>(async (c, next) => {
  c.set("caller", null);
  // The auth scheme is case-insensitive (RFC 9110); the key itself is not.
  const bearer = /^bearer +(\S*)$/i.exec(c.req.header("authorization") ?? "")?.[1];
  if (bearer !== undefined) {
    const row = bearer.startsWith(API_KEY_PREFIX) ? await findApiKeyByHash(c.env.DB, await sha256Hex(bearer)) : null;
    if (row !== null) {
      const now = new Date();
      if (isUseDue(row, now)) await touchApiKey(c.env.DB, row.id, now);
      c.set("caller", { kind: "apiKey", scope: row.scope, apiKey: { id: row.id, name: row.name } });
    }
    await next();
    return;
  }
  // Access mode replaces the password door (ADR 0003): only a valid Access JWT is the operator, a session cookie is not.
  const access = await accessVerdict(c.env.DB, c.req.raw, accessVerifier);
  if (access.on) {
    if (access.identity !== null) {
      if (!sameOrigin(c)) return crossOrigin();
      c.set("caller", { kind: "access", scope: "write", email: access.identity.email });
    }
    await next();
    return;
  }
  const id = getCookie(c, SESSION_COOKIE);
  if (id) {
    const idHash = await sha256Hex(id);
    if ((await findSession(c.env.DB, idHash, new Date())) !== null) {
      if (!sameOrigin(c)) return crossOrigin();
      c.set("caller", { kind: "session", scope: "write", sessionIdHash: idHash });
    }
  }
  await next();
});

/** Browser-authenticated mutating requests must come from the instance itself (ADR 0003; CSRF). */
function sameOrigin(c: Context<ApiEnv>): boolean {
  return SAFE_METHODS.has(c.req.method) || c.req.header("origin") === new URL(c.req.url).origin;
}

const crossOrigin = () => apiError(403, "forbidden", "Origin does not match this instance.");

export const requireCaller = createMiddleware<ApiEnv>(async (c, next) => {
  if (c.var.caller === null) return unauthorized();
  await next();
});

/** Session-only endpoints (a browser session or Access): an API key can never change authentication (ADR 0009). */
export const requireSession = createMiddleware<ApiEnv>(async (c, next) => {
  if (c.var.caller === null) return unauthorized();
  if (c.var.caller.kind === "apiKey") return apiError(403, "forbidden", "Session required.");
  await next();
});

/** Link and campaign writes (ADR 0009): any caller with the `write` scope. */
export const requireWrite = createMiddleware<ApiEnv>(async (c, next) => {
  if (c.var.caller === null) return unauthorized();
  if (c.var.caller.scope !== "write") return apiError(403, "forbidden", "This needs the write scope.");
  await next();
});
