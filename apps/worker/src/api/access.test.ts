// Access mode through the Worker (ADR 0003, *Cloudflare Access mode*; ADR 0009, *Settings*). The Access edge is
// stood in for by a `fetch` that serves the test team's certs document; nothing leaves the test.

import { CreatedApiKey, Settings } from "@furea/shared";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { certsFetch, createTestTeam, type TestTeam } from "../core/access.fixture.ts";
import { sha256Hex } from "../core/crypto.ts";
import { findSession } from "../core/db/sessions.ts";
import { getSetting } from "../core/db/settings.ts";
import { SESSION_COOKIE, startSession } from "./session.ts";

const ORIGIN = "https://s.example.com";
const WORKERS_DEV = "https://furea.someone.workers.dev";

let team: TestTeam;
const keys: Record<"read" | "write", string> = { read: "", write: "" };

async function newSessionCookie(): Promise<string> {
  const { id } = await startSession(env.DB);
  return `${SESSION_COOKIE}=${id}`;
}

beforeAll(async () => {
  team = await createTestTeam("api-team.cloudflareaccess.com");
  const cookie = await newSessionCookie();
  for (const scope of ["read", "write"] as const) {
    const res = await call("/api-keys", { method: "POST", body: { name: `access ${scope}`, scope }, cookie });
    keys[scope] = CreatedApiKey.parse(await res.json()).key;
  }
});

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(certsFetch(team));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM settings WHERE key IN ('access_team_domain', 'access_aud')");
});

interface Init {
  method?: string;
  body?: unknown;
  origin?: string;
  cookie?: string;
  bearer?: string;
  headers?: Record<string, string>;
}

function call(path: string, init: Init = {}): Promise<Response> {
  const origin = init.origin ?? ORIGIN;
  const headers = new Headers({ origin, ...init.headers });
  if (init.bearer !== undefined) headers.set("authorization", `Bearer ${init.bearer}`);
  if (init.cookie !== undefined) headers.set("cookie", init.cookie);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return exports.default.fetch(
    new Request(`${origin}${path.startsWith("/admin") ? "" : "/api/v1"}${path}`, {
      method: init.method ?? "GET",
      headers,
      redirect: "manual",
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
}

const enable = (init: Init = {}) =>
  call("/settings", { method: "PATCH", body: { access: { teamDomain: team.teamDomain, aud: team.aud } }, ...init });

async function turnOn(): Promise<void> {
  const res = await enable({ cookie: await newSessionCookie() });
  expect(res.status).toBe(200);
}

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe("PATCH /api/v1/settings with access", () => {
  it("turns Access mode on from a session on the instance's own domain", async () => {
    const res = await enable({ cookie: await newSessionCookie() });

    expect(res.status).toBe(200);
    const access = { teamDomain: team.teamDomain, aud: team.aud };
    expect(Settings.parse(await res.json()).access).toEqual(access);
    expect(await getSetting(env.DB, "access_team_domain")).toBe(team.teamDomain);
    expect(Settings.parse(await (await call("/settings", { bearer: keys.read })).json()).access).toEqual(access);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api-team.cloudflareaccess.com/cdn-cgi/access/certs",
      expect.anything(),
    );
  });

  it("is refused with 409 access_requires_own_domain on workers.dev, and nothing is stored", async () => {
    const res = await enable({ origin: WORKERS_DEV, cookie: await newSessionCookie() });

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("access_requires_own_domain");
    expect(await getSetting(env.DB, "access_team_domain")).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("is refused with 409 access_unreachable when the team's public keys cannot be fetched", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response("no such team", { status: 404 }));

    const res = await call("/settings", {
      method: "PATCH",
      body: { rootDestination: "https://example.com/not-written", access: { teamDomain: "nobody.cloudflareaccess.com", aud: "x" } },
      cookie: await newSessionCookie(),
    });

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("access_unreachable");
    expect(await getSetting(env.DB, "access_team_domain")).toBeNull();
    expect(await getSetting(env.DB, "root_destination")).toBeNull();
  });

  it("is session-only: API keys of either scope get 403, nobody gets 401", async () => {
    expect((await enable({ bearer: keys.write })).status).toBe(403);
    expect((await enable({ bearer: keys.read })).status).toBe(403);
    expect((await call("/settings", { method: "PATCH", body: { access: null }, bearer: keys.write })).status).toBe(403);
    expect((await enable()).status).toBe(401);
    expect(await getSetting(env.DB, "access_team_domain")).toBeNull();
  });

  it("turns Access mode off with null, from any host, and the password door opens again", async () => {
    await turnOn();
    const jwt = await team.sign();

    const res = await call("/settings", {
      method: "PATCH",
      body: { access: null },
      origin: WORKERS_DEV,
      headers: { "cf-access-jwt-assertion": jwt },
    });

    expect(res.status).toBe(200);
    expect(Settings.parse(await res.json()).access).toBeNull();
    expect(await (await call("/auth/login")).json()).toEqual({ method: "password" });
  });

  it("ends every password session when it turns on", async () => {
    const cookie = await newSessionCookie();
    const idHash = await sha256Hex(cookie.slice(SESSION_COOKIE.length + 1));

    await enable({ cookie });

    expect(await findSession(env.DB, idHash, new Date())).toBeNull();
  });
});

describe("with Access mode on", () => {
  beforeEach(turnOn);

  it("answers GET /auth/login with the Access door and refuses the password with 403 login_disabled", async () => {
    expect(await (await call("/auth/login")).json()).toEqual({ method: "access" });
    const res = await call("/auth/login", { method: "POST", body: { password: "anything at all" } });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("login_disabled");
  });

  it("takes a valid Access JWT, as header or cookie, as the operator session", async () => {
    const jwt = await team.sign();
    for (const init of [{ headers: { "cf-access-jwt-assertion": jwt } }, { cookie: `CF_Authorization=${jwt}` }]) {
      const res = await call("/auth/session", init);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ kind: "access", scope: "write", apiKey: null });
    }
    // Session-only endpoints are open to it.
    expect((await call("/api-keys", { headers: { "cf-access-jwt-assertion": jwt } })).status).toBe(200);
  });

  it("refuses a missing, forged or foreign JWT and a password session cookie", async () => {
    const other = await createTestTeam("api-other.cloudflareaccess.com");
    const refused: Init[] = [
      {},
      { headers: { "cf-access-jwt-assertion": "forged.jwt.value" } },
      { headers: { "cf-access-jwt-assertion": await team.sign({ aud: ["another-app"] }) } },
      { headers: { "cf-access-jwt-assertion": await other.sign({ aud: [team.aud], iss: `https://${team.teamDomain}` }) } },
      { cookie: await newSessionCookie() },
    ];
    for (const init of refused) expect((await call("/auth/session", init)).status).toBe(401);
  });

  it("refuses a JWT-authenticated write from another origin", async () => {
    const res = await call("/links", {
      method: "POST",
      body: { destination: "https://example.com/csrf" },
      cookie: `CF_Authorization=${await team.sign()}`,
      headers: { origin: "https://elsewhere.example" },
    });
    expect(res.status).toBe(403);
  });

  it("lets the Access operator override screening, as a password session may", async () => {
    const res = await call("/links", {
      method: "POST",
      body: { destination: "https://example.com/access-skip", slug: "access-skip", screening: "skip" },
      cookie: `CF_Authorization=${await team.sign()}`,
    });
    expect(res.status).toBe(201);
  });

  it("leaves API keys working", async () => {
    const res = await call("/auth/session", { bearer: keys.write });
    expect(await res.json()).toMatchObject({ kind: "apiKey", scope: "write" });
    expect((await call("/links", { bearer: keys.read })).status).toBe(200);
  });

  it("serves /admin deep links only to a valid Access JWT", async () => {
    expect((await call("/admin/campaigns")).status).toBe(403);
    const ok = await call("/admin/campaigns", { cookie: `CF_Authorization=${await team.sign()}` });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/text\/html/);
  });
});
