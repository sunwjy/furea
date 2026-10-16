import { CreatedApiKey, hashPassword, Settings, verifyPassword } from "@furea/shared";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../core/crypto.ts";
import { findSession } from "../core/db/sessions.ts";
import { getSetting, isRootSyncPending, markRootSyncPending, setSetting } from "../core/db/settings.ts";
import { FAILED_LOGIN_DELAY_MS, SESSION_COOKIE, startSession } from "./session.ts";

const ORIGIN = "https://s.example.com";
const PASSWORD = "correct horse battery staple";

let cookie: string;
const keys: Record<"read" | "write", string> = { read: "", write: "" };

async function newSessionCookie(): Promise<string> {
  const { id } = await startSession(env.DB);
  return `${SESSION_COOKIE}=${id}`;
}

beforeAll(async () => {
  cookie = await newSessionCookie();
  for (const scope of ["read", "write"] as const) {
    const res = await api("/api-keys", { method: "POST", body: { name: `settings ${scope}`, scope } });
    keys[scope] = CreatedApiKey.parse(await res.json()).key;
  }
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM settings WHERE key IN ('root_destination', 'root_destination_sync_pending')");
  await env.KV.delete("_");
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Init {
  method?: string;
  body?: unknown;
  bearer?: string;
  cookie?: string;
}

function api(path: string, init: Init = {}): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN });
  if (init.bearer !== undefined) headers.set("authorization", `Bearer ${init.bearer}`);
  else headers.set("cookie", init.cookie ?? cookie);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return exports.default.fetch(
    new Request(`${ORIGIN}/api/v1${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
}

const patch = (body: unknown, init: Init = {}) => api("/settings", { ...init, method: "PATCH", body });

const root = () => exports.default.fetch(new Request(`${ORIGIN}/`, { redirect: "manual" }));

async function details(res: Response) {
  const body = (await res.json()) as { error: { code: string; details: { field: string; code: string }[] } };
  return { code: body.error.code, details: body.error.details.map(({ field, code }) => ({ field, code })) };
}

describe("GET /api/v1/settings", () => {
  it("answers the settings document with the instance facts", async () => {
    const res = await api("/settings");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Settings.parse(await res.json())).toEqual({
      rootDestination: null,
      access: null,
      analyticsConfigured: false,
      version: env.FUREA_VERSION,
    });
  });

  it("is readable with a read key", async () => {
    expect((await api("/settings", { bearer: keys.read })).status).toBe(200);
  });
});

describe("PATCH /api/v1/settings", () => {
  it("sets the root destination in D1 and the cache, and / redirects to it", async () => {
    const res = await patch({ rootDestination: "https://example.com/home" });

    expect(res.status).toBe(200);
    expect(Settings.parse(await res.json())).toMatchObject({ rootDestination: "https://example.com/home" });
    expect(await getSetting(env.DB, "root_destination")).toBe("https://example.com/home");
    const redirect = await root();
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("https://example.com/home");
    expect(Settings.parse(await (await api("/settings")).json()).rootDestination).toBe("https://example.com/home");
  });

  it("unsets it with null, and / answers the unknown-slug response again", async () => {
    await patch({ rootDestination: "https://example.com/home" });

    const res = await patch({ rootDestination: null });

    expect(res.status).toBe(200);
    expect(Settings.parse(await res.json())).toMatchObject({ rootDestination: null });
    expect(await getSetting(env.DB, "root_destination")).toBeNull();
    expect((await root()).status).toBe(404);
  });

  it("keeps the root destination on an empty patch and rewrites its cache entry", async () => {
    await setSetting(env.DB, "root_destination", "https://example.com/lagging");
    await markRootSyncPending(env.DB);

    const res = await patch({});

    expect(res.status).toBe(200);
    expect(Settings.parse(await res.json())).toMatchObject({ rootDestination: "https://example.com/lagging" });
    expect(await isRootSyncPending(env.DB)).toBe(false);
    expect((await root()).headers.get("location")).toBe("https://example.com/lagging");
  });

  it("is allowed to a write key and refused to a read key", async () => {
    expect((await patch({ rootDestination: "https://example.com/k" }, { bearer: keys.write })).status).toBe(200);
    const refused = await patch({ rootDestination: "https://example.com/r" }, { bearer: keys.read });
    expect(refused.status).toBe(403);
    expect(await getSetting(env.DB, "root_destination")).toBe("https://example.com/k");
  });

  it("reports read-only, self-referencing and unknown fields together", async () => {
    const res = await patch({
      rootDestination: "https://s.example.com/loop",
      analyticsConfigured: true,
      version: "9.9.9",
      theme: "dark",
    });

    expect(res.status).toBe(400);
    expect(await details(res)).toEqual({
      code: "validation_failed",
      details: [
        { field: "rootDestination", code: "destination_self" },
        { field: "analyticsConfigured", code: "read_only_field" },
        { field: "version", code: "read_only_field" },
        { field: "theme", code: "unknown_field" },
      ],
    });
    expect(await getSetting(env.DB, "root_destination")).toBeNull();
  });

  it("validates the root destination like a link destination", async () => {
    const res = await patch({ rootDestination: "javascript:alert(1)" });
    expect(await details(res)).toEqual({
      code: "validation_failed",
      details: [{ field: "rootDestination", code: "destination_invalid" }],
    });
  });
});

describe("POST /api/v1/password", () => {
  const NEW_PASSWORD = "a brand new passphrase";

  beforeEach(async () => {
    await setSetting(env.DB, "operator_password_hash", await hashPassword(PASSWORD, { iterations: 1_000 }));
  });

  const change = (body: unknown, init: Init = {}) => api("/password", { ...init, method: "POST", body });

  it("stores the new password and deletes every session, this one included", async () => {
    const mine = await newSessionCookie();
    const other = await newSessionCookie();

    const res = await change({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, { cookie: mine });

    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE}=; Max-Age=0;`));
    const stored = (await getSetting(env.DB, "operator_password_hash"))!;
    expect(await verifyPassword(NEW_PASSWORD, stored)).toBe(true);
    expect(await verifyPassword(PASSWORD, stored)).toBe(false);
    for (const session of [mine, other]) {
      const idHash = await sha256Hex(session.slice(`${SESSION_COOKIE}=`.length));
      expect(await findSession(env.DB, idHash, new Date())).toBeNull();
    }
    expect((await api("/settings", { cookie: other })).status).toBe(401);
    // The shared session of this file is gone too.
    cookie = await newSessionCookie();
  });

  it("answers 401 invalid_password after the fixed delay for a wrong current password, changing nothing", async () => {
    const mine = await newSessionCookie();
    const before = await getSetting(env.DB, "operator_password_hash");
    const started = Date.now();

    const res = await change({ currentPassword: "not the password", newPassword: NEW_PASSWORD }, { cookie: mine });

    expect(Date.now() - started).toBeGreaterThanOrEqual(FAILED_LOGIN_DELAY_MS);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "invalid_password", message: expect.any(String) } });
    expect(await getSetting(env.DB, "operator_password_hash")).toBe(before);
    expect((await api("/settings", { cookie: mine })).status).toBe(200);
  });

  it.each([
    ["11", "a".repeat(11)],
    ["257", "a".repeat(257)],
  ])("refuses a new password of %s characters", async (_, newPassword) => {
    const res = await change({ currentPassword: PASSWORD, newPassword });
    expect(await details(res)).toEqual({
      code: "validation_failed",
      details: [{ field: "newPassword", code: "invalid" }],
    });
  });

  it("is refused to API keys, even with the right current password", async () => {
    for (const bearer of [keys.read, keys.write]) {
      const res = await change({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, { bearer });
      expect(res.status).toBe(403);
    }
    expect(await verifyPassword(PASSWORD, (await getSetting(env.DB, "operator_password_hash"))!)).toBe(true);
  });
});
