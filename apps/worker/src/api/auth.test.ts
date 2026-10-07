import { hashPassword } from "@furea/shared";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../core/crypto.ts";
import { getSetting, setSetting } from "../core/db/settings.ts";
import { FAILED_LOGIN_DELAY_MS, SESSION_COOKIE } from "./session.ts";

// Every test logs in from its own client IP so the per-client limiter (5 per minute) never couples tests.
// The global limiter (30 per minute) is exhausted on purpose by the last test in this file, and no other test
// file logs in through the endpoint (they create sessions with startSession()).

const ORIGIN = "https://s.example.com";
const PASSWORD = "correct horse battery staple";
const COOKIE_PATTERN = new RegExp(
  `^${SESSION_COOKIE}=([A-Za-z0-9_-]{43}); Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax$`,
);

let nextIp = 1;
function freshIp(): string {
  return `198.51.100.${nextIp++}`;
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}/api/v1${path}`, init));
}

function login(body: unknown, ip = freshIp(), headers: Record<string, string> = {}): Promise<Response> {
  return api("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

async function loggedInCookie(): Promise<string> {
  const res = await login({ password: PASSWORD });
  expect(res.status).toBe(204);
  const id = COOKIE_PATTERN.exec(res.headers.get("set-cookie") ?? "")?.[1];
  if (id === undefined) throw new Error("no session cookie");
  return `${SESSION_COOKIE}=${id}`;
}

beforeAll(async () => {
  // A cheap iteration count keeps the suite fast; verify reads the count from the stored string.
  await setSetting(env.DB, "operator_password_hash", await hashPassword(PASSWORD, { iterations: 1_000 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/v1/auth/login", () => {
  it("names the password door without authentication", async () => {
    const res = await api("/auth/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ method: "password" });
  });
});

describe("POST /api/v1/auth/login", () => {
  it("answers 204 with a __Host- session cookie and stores only the id's SHA-256 for 30 days", async () => {
    const res = await login({ password: PASSWORD });

    expect(res.status).toBe(204);
    const id = COOKIE_PATTERN.exec(res.headers.get("set-cookie") ?? "")?.[1];
    expect(id).toBeDefined();
    const row = await env.DB.prepare("SELECT created_at, expires_at FROM sessions WHERE id_hash = ?")
      .bind(await sha256Hex(id as string))
      .first<{ created_at: string; expires_at: string }>();
    expect(row).not.toBeNull();
    const lifetime = Date.parse(row?.expires_at ?? "") - Date.parse(row?.created_at ?? "");
    expect(lifetime).toBe(30 * 24 * 60 * 60 * 1000);
    const raw = await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE id_hash = ?").bind(id).first<{ n: number }>();
    expect(raw?.n).toBe(0);
  });

  it("purges expired session rows", async () => {
    await env.DB.prepare("INSERT INTO sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .bind("expired-row", "2020-01-01T00:00:00.000Z", "2020-01-31T00:00:00.000Z")
      .run();
    expect((await login({ password: PASSWORD })).status).toBe(204);
    expect(await env.DB.prepare("SELECT 1 FROM sessions WHERE id_hash = 'expired-row'").first()).toBeNull();
  });

  it("answers 401 invalid_password after the fixed delay for a wrong password", async () => {
    const started = Date.now();
    const res = await login({ password: "correct horse battery stapler" });

    expect(Date.now() - started).toBeGreaterThanOrEqual(FAILED_LOGIN_DELAY_MS);
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ error: { code: "invalid_password", message: expect.any(String) } });
  });

  it("answers 401 invalid_password while no password hash is stored", async () => {
    const stored = await getSetting(env.DB, "operator_password_hash");
    await env.DB.exec("DELETE FROM settings WHERE key = 'operator_password_hash'");
    try {
      const res = await login({ password: PASSWORD });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: { code: "invalid_password" } });
    } finally {
      await setSetting(env.DB, "operator_password_hash", stored as string);
    }
  });

  it("reports a missing password and unknown fields as validation_failed", async () => {
    const res = await login({ user: "admin" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "validation_failed",
        message: expect.any(String),
        details: [
          { field: "password", code: "invalid", message: expect.any(String) },
          { field: "user", code: "unknown_field", message: expect.any(String) },
        ],
      },
    });
  });

  it("refuses a body that is not JSON", async () => {
    const wrongType = await api("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": freshIp() },
      body: "password=x",
    });
    expect(wrongType.status).toBe(415);
    expect(await wrongType.json()).toMatchObject({ error: { code: "unsupported_media_type" } });

    const malformed = await api("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", "cf-connecting-ip": freshIp() },
      body: '{"password":',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "invalid_json" } });
  });

  it("refuses a body over 64 KiB with 413", async () => {
    const res = await login({ password: "x".repeat(65 * 1024) });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: "payload_too_large" } });
  });

  it("brakes one client at its limit with 429 + Retry-After and logs login_rate_limited without the IP", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ip = freshIp();

    // Malformed bodies still count, so the loop is fast. The limiter's window is aligned to the wall clock;
    // looping until the first 429 keeps the test independent of where in the minute it starts.
    let res: Response | undefined;
    for (let i = 0; i < 12; i++) {
      res = await login({}, ip);
      if (res.status === 429) break;
    }

    expect(res?.status).toBe(429);
    expect(res?.headers.get("retry-after")).toBe("60");
    expect(await res?.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect((await login({ password: PASSWORD }, ip)).status).toBe(429);
    expect((await login({ password: PASSWORD })).status).toBe(204);

    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain(JSON.stringify({ event: "login_rate_limited", limiter: "per_client" }));
    expect(lines.join("\n")).not.toContain(ip);
  });
});

describe("GET /api/v1/auth/session", () => {
  it("reports a browser session", async () => {
    const res = await api("/auth/session", { headers: { cookie: await loggedInCookie() } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "session", scope: "write", apiKey: null });
  });

  it("answers 401 unauthorized without a cookie, with an unknown one and with an expired one", async () => {
    expect((await api("/auth/session")).status).toBe(401);
    const unknown = await api("/auth/session", { headers: { cookie: `${SESSION_COOKIE}=not-a-session` } });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({ error: { code: "unauthorized" } });

    await env.DB.prepare("INSERT INTO sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .bind(await sha256Hex("an-expired-id"), "2020-01-01T00:00:00.000Z", "2020-01-31T00:00:00.000Z")
      .run();
    const expired = await api("/auth/session", { headers: { cookie: `${SESSION_COOKIE}=an-expired-id` } });
    expect(expired.status).toBe(401);
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("deletes the session row and clears the cookie", async () => {
    const cookie = await loggedInCookie();

    const res = await api("/auth/logout", { method: "POST", headers: { cookie, origin: ORIGIN } });

    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toBe(
      `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );
    expect((await api("/auth/session", { headers: { cookie } })).status).toBe(401);
  });

  it("answers 401 without a session", async () => {
    const res = await api("/auth/logout", { method: "POST", headers: { origin: ORIGIN } });
    expect(res.status).toBe(401);
  });
});

describe("a cookie-authenticated mutating request", () => {
  it.each([
    ["without an Origin header", {}],
    ["from another origin", { origin: "https://evil.example" }],
    ["from the same host over another scheme", { origin: "http://s.example.com" }],
  ])("is refused with 403 forbidden %s", async (_, headers: Record<string, string>) => {
    const cookie = await loggedInCookie();

    const res = await api("/auth/logout", { method: "POST", headers: { cookie, ...headers } });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
    expect((await api("/auth/session", { headers: { cookie } })).status).toBe(200);
  });

  it("is not needed for a safe method", async () => {
    const res = await api("/auth/session", { headers: { cookie: await loggedInCookie() } });
    expect(res.status).toBe(200);
  });
});

describe("an unknown /api path", () => {
  it("answers the not_found envelope", async () => {
    for (const path of ["/api/v1/nope", "/api/v2/auth/login", "/api"]) {
      const res = await exports.default.fetch(new Request(`${ORIGIN}${path}`));
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    }
  });
});

// Last: once the instance-wide limiter is exhausted, no login in this file succeeds for the rest of the minute.
describe("the instance-wide login limiter", () => {
  it("brakes logins from many clients with 429 and logs login_rate_limited", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    let res: Response | undefined;
    for (let i = 0; i < 70; i++) {
      res = await login({});
      if (res.status === 429) break;
    }

    expect(res?.status).toBe(429);
    expect(res?.headers.get("retry-after")).toBe("60");
    expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
      JSON.stringify({ event: "login_rate_limited", limiter: "global" }),
    );
  });
});
