// ADR 0009, *Who may call what*: every existing endpoint against every kind of caller, plus *Cross-origin*.

import { CreatedApiKey } from "@furea/shared";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { insertCampaign } from "../core/db/campaigns.ts";
import { insertLink } from "../core/db/links.ts";
import { SESSION_COOKIE, startSession } from "./session.ts";

const ORIGIN = "https://s.example.com";
const SLUG = "authz-target";
const CAMPAIGN = "authzCampgn1";

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
  // No analytics token in the test instance: a caller allowed to read is answered 503, past the check.
  { method: "GET", path: `/links/${SLUG}/stats`, expect: ANY_CALLER },
  { method: "GET", path: "/stats", expect: ANY_CALLER },
  { method: "POST", path: "/links", body: { destination: "https://example.com/authz" }, expect: WRITE },
  { method: "PATCH", path: `/links/${SLUG}`, body: {}, expect: WRITE },
  { method: "DELETE", path: `/links/${SLUG}`, expect: WRITE },
  { method: "GET", path: "/api-keys", expect: SESSION_ONLY },
  { method: "POST", path: "/api-keys", body: { name: "minted", scope: "write" }, expect: SESSION_ONLY },
  { method: "DELETE", path: "/api-keys/doesNotExist", expect: SESSION_ONLY },
  { method: "GET", path: "/settings", expect: ANY_CALLER },
  { method: "PATCH", path: "/settings", body: { rootDestination: null }, expect: WRITE },
  // Access mode changes authentication; turning it off (already off here) keeps the matrix free of side effects.
  { method: "PATCH", path: "/settings", body: { access: null }, expect: SESSION_ONLY },
  { method: "GET", path: "/campaigns", expect: ANY_CALLER },
  { method: "GET", path: `/campaigns/${CAMPAIGN}`, expect: ANY_CALLER },
  { method: "GET", path: `/campaigns/${CAMPAIGN}/links`, expect: ANY_CALLER },
  { method: "GET", path: `/campaigns/${CAMPAIGN}/stats`, expect: ANY_CALLER },
  { method: "POST", path: "/campaigns", body: { name: "authz minted", baseUrl: "https://example.com/" }, expect: WRITE },
  { method: "PATCH", path: `/campaigns/${CAMPAIGN}`, body: {}, expect: WRITE },
  {
    method: "POST",
    path: `/campaigns/${CAMPAIGN}/links`,
    body: { items: [{ utm: { source: "authz", medium: "m" } }] },
    expect: WRITE,
  },
  { method: "PATCH", path: `/campaigns/${CAMPAIGN}/links`, body: { enabled: true }, expect: WRITE },
  { method: "DELETE", path: `/campaigns/${CAMPAIGN}`, expect: WRITE },
  // Logging out and changing the password end sessions, so they run last and with their own session.
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
        // Each caller allowed through meets the same campaign state: present, without members, its name free.
        await env.DB.batch([
          env.DB.prepare("UPDATE links SET campaign_id = NULL, campaign_utm_key = NULL WHERE campaign_id IS NOT NULL"),
          env.DB.prepare("DELETE FROM campaigns WHERE id != ?").bind(CAMPAIGN),
        ]);
        await insertCampaign(env.DB, {
          id: CAMPAIGN,
          name: "authz campaign",
          utmCampaign: "authz",
          utmId: null,
          baseUrl: "https://example.com/authz",
        });
        const res = await call(endpoint, credentialsOf(caller));
        if (expected === "ok") {
          // The DELETE of an unknown key id is the session's 404: past the authorization check.
          if (endpoint.path === "/api-keys/doesNotExist") expect(res.status).toBe(404);
          else if (endpoint.path.endsWith("/stats")) expect(res.status).toBe(503);
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

  it("refuses POST /password to API keys and lets a session past the authorization check", async () => {
    // A wrong current password: the session gets the endpoint's own 401, nothing is changed.
    const change: Endpoint = {
      method: "POST",
      path: "/password",
      body: { currentPassword: "not the password", newPassword: "long enough new one" },
      expect: SESSION_ONLY,
    };
    expect(await (await call(change, {})).json()).toMatchObject({ error: { code: "unauthorized" } });
    expect((await call(change, credentials.read)).status).toBe(403);
    expect((await call(change, credentials.write)).status).toBe(403);
    const { id } = await startSession(env.DB);
    expect(await (await call(change, { cookie: `${SESSION_COOKIE}=${id}` })).json()).toMatchObject({
      error: { code: "invalid_password" },
    });
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
