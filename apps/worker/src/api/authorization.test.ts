// ADR 0009, *Who may call what*: every existing endpoint against every kind of caller, plus *Cross-origin*.

import { CreatedApiKey } from "@furea/shared";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { insertLink } from "../core/db/links.ts";
import { SESSION_COOKIE, startSession } from "./session.ts";

const ORIGIN = "https://s.example.com";
const SLUG = "authz-target";

type CallerKind = "none" | "read" | "write" | "session";
const CALLERS: CallerKind[] = ["none", "read", "write", "session"];

const credentials: Record<Exclude<CallerKind, "none">, Record<string, string>> = { read: {}, write: {}, session: {} };

beforeAll(async () => {
  const { id } = await startSession(env.DB);
  credentials.session = { cookie: `${SESSION_COOKIE}=${id}` };
  for (const scope of ["read", "write"] as const) {
    const res = await exports.default.fetch(
      new Request(`${ORIGIN}/api/v1/api-keys`, {
        method: "POST",
        headers: { ...credentials.session, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ name: `authz ${scope}`, scope }),
      }),
    );
    credentials[scope] = { authorization: `Bearer ${CreatedApiKey.parse(await res.json()).key}` };
  }
});

interface Endpoint {
  method: string;
  path: string;
  body?: unknown;
  /** The expected status per caller: a number, or "ok" for any 2xx. */
  expect: Record<CallerKind, "ok" | 401 | 403>;
}

const PUBLIC = { none: "ok", read: "ok", write: "ok", session: "ok" } as const;
const ANY_CALLER = { none: 401, read: "ok", write: "ok", session: "ok" } as const;
const WRITE = { none: 401, read: 403, write: "ok", session: "ok" } as const;
const SESSION_ONLY = { none: 401, read: 403, write: 403, session: "ok" } as const;

const ENDPOINTS: Endpoint[] = [
  { method: "GET", path: "/auth/login", expect: PUBLIC },
  { method: "GET", path: "/openapi.json", expect: PUBLIC },
  { method: "GET", path: "/auth/session", expect: ANY_CALLER },
  { method: "GET", path: "/links", expect: ANY_CALLER },
  { method: "GET", path: `/links/${SLUG}`, expect: ANY_CALLER },
  { method: "POST", path: "/links", body: { destination: "https://example.com/authz" }, expect: WRITE },
  { method: "PATCH", path: `/links/${SLUG}`, body: {}, expect: WRITE },
  { method: "DELETE", path: `/links/${SLUG}`, expect: WRITE },
  { method: "GET", path: "/api-keys", expect: SESSION_ONLY },
  { method: "POST", path: "/api-keys", body: { name: "minted", scope: "write" }, expect: SESSION_ONLY },
  { method: "DELETE", path: "/api-keys/doesNotExist", expect: SESSION_ONLY },
  // Logging out ends the session, so it runs last and with its own session.
];

function call(endpoint: Endpoint, headers: Record<string, string>): Promise<Response> {
  return exports.default.fetch(
    new Request(`${ORIGIN}/api/v1${endpoint.path}`, {
      method: endpoint.method,
      headers: {
        ...headers,
        origin: ORIGIN,
        ...(endpoint.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(endpoint.body === undefined ? {} : { body: JSON.stringify(endpoint.body) }),
    }),
  );
}

const credentialsOf = (caller: CallerKind) => (caller === "none" ? {} : credentials[caller]);

describe("who may call what", () => {
  for (const endpoint of ENDPOINTS) {
    for (const caller of CALLERS) {
      const expected = endpoint.expect[caller];
      it(`${endpoint.method} ${endpoint.path} as ${caller} → ${expected}`, async () => {
        await insertLink(env.DB, { slug: SLUG, destination: "https://example.com/authz-target" });
        const res = await call(endpoint, credentialsOf(caller));
        if (expected === "ok") {
          // The DELETE of an unknown key id is the session's 404: past the authorization check.
          if (endpoint.path === "/api-keys/doesNotExist") expect(res.status).toBe(404);
          else expect(res.ok, `status ${res.status}`).toBe(true);
          return;
        }
        expect(res.status).toBe(expected);
        const body = await res.json();
        if (expected === 401) expect(body).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
        else expect(body).toEqual({ error: { code: "forbidden", message: expect.any(String) } });
      });
    }
  }

  it("names the missing scope, or that a session is required", async () => {
    const write = await call(ENDPOINTS.find((e) => e.method === "POST" && e.path === "/links") as Endpoint, credentials.read);
    expect(((await write.json()) as { error: { message: string } }).error.message).toMatch(/write scope/);
    const keys = await call({ method: "GET", path: "/api-keys", expect: SESSION_ONLY }, credentials.write);
    expect(((await keys.json()) as { error: { message: string } }).error.message).toMatch(/session required/i);
  });

  it("refuses POST /auth/logout to API keys and lets a session log out", async () => {
    const logout: Endpoint = { method: "POST", path: "/auth/logout", expect: SESSION_ONLY };
    expect((await call(logout, {})).status).toBe(401);
    expect((await call(logout, credentials.read)).status).toBe(403);
    expect((await call(logout, credentials.write)).status).toBe(403);
    const { id } = await startSession(env.DB);
    expect((await call(logout, { cookie: `${SESSION_COOKIE}=${id}` })).status).toBe(204);
  });
});

describe("cross-origin", () => {
  it("sends no CORS headers, not even to a preflight from another origin", async () => {
    const requests = [
      new Request(`${ORIGIN}/api/v1/links`, {
        method: "OPTIONS",
        headers: {
          origin: "https://elsewhere.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type",
        },
      }),
      new Request(`${ORIGIN}/api/v1/links`, { headers: { ...credentials.read, origin: "https://elsewhere.example" } }),
      new Request(`${ORIGIN}/api/v1/openapi.json`, { headers: { origin: "https://elsewhere.example" } }),
      new Request(`${ORIGIN}/api/v1/auth/session`, { headers: { origin: "https://elsewhere.example" } }),
    ];
    for (const request of requests) {
      const res = await exports.default.fetch(request);
      const cors = [...res.headers.keys()].filter((name) => name.startsWith("access-control-"));
      expect(cors, `${request.method} ${request.url}`).toEqual([]);
    }
  });
});
