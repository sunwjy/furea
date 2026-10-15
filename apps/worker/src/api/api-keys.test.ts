import { ApiKeyList, CreatedApiKey, GENERATED_SLUG_ALPHABET } from "@furea/shared";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../core/crypto.ts";
import { SESSION_COOKIE, startSession } from "./session.ts";

const ORIGIN = "https://s.example.com";
const ID = new RegExp(`^[${GENERATED_SLUG_ALPHABET}]{12}$`);
const SECRET = new RegExp(`^furea_[${GENERATED_SLUG_ALPHABET}]{45}$`);

let cookie: string;

beforeAll(async () => {
  const { id } = await startSession(env.DB);
  cookie = `${SESSION_COOKIE}=${id}`;
});

function api(path: string, init: RequestInit & { bearer?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.bearer === undefined) headers.set("cookie", cookie);
  else headers.set("authorization", `Bearer ${init.bearer}`);
  headers.set("origin", ORIGIN);
  return exports.default.fetch(new Request(`${ORIGIN}/api/v1${path}`, { ...init, headers }));
}

function create(body: unknown, init: { bearer?: string } = {}): Promise<Response> {
  return api("/api-keys", {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function created(name: string, scope: "read" | "write"): Promise<CreatedApiKey> {
  const res = await create({ name, scope });
  expect(res.status).toBe(201);
  return CreatedApiKey.parse(await res.json());
}

async function lastUsedAt(id: string): Promise<string | null | undefined> {
  const row = await env.DB.prepare("SELECT last_used_at FROM api_keys WHERE id = ?")
    .bind(id)
    .first<{ last_used_at: string | null }>();
  return row?.last_used_at;
}

describe("POST /api/v1/api-keys", () => {
  it("answers 201 with the key resource and the secret, storing only its SHA-256", async () => {
    const res = await create({ name: "  backup script ", scope: "read" });

    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const key = CreatedApiKey.parse(await res.json());
    expect(key).toEqual({
      id: expect.stringMatching(ID),
      name: "backup script",
      prefix: key.key.slice("furea_".length, "furea_".length + 8),
      scope: "read",
      createdAt: expect.any(String),
      lastUsedAt: null,
      key: expect.stringMatching(SECRET),
    });
    const row = await env.DB.prepare("SELECT key_hash FROM api_keys WHERE id = ?").bind(key.id).first<{ key_hash: string }>();
    expect(row?.key_hash).toBe(await sha256Hex(key.key));
  });

  it("reports an invalid name and scope as validation_failed", async () => {
    const res = await create({ name: " ", scope: "admin" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "validation_failed",
        message: expect.any(String),
        details: [
          { field: "name", code: "invalid", message: expect.any(String) },
          { field: "scope", code: "invalid", message: expect.any(String) },
        ],
      },
    });
  });
});

describe("GET /api/v1/api-keys", () => {
  it("lists every key without its secret, newest first", async () => {
    const older = await created("older", "read");
    const newer = await created("newer", "write");

    const res = await api("/api-keys");
    expect(res.status).toBe(200);
    const body = await res.json();
    const keys = ApiKeyList.parse(body);
    expect(JSON.stringify(body)).not.toContain(newer.key);
    const ids = keys.map((k) => k.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    const { key: _secret, ...listed } = newer;
    expect(keys.find((k) => k.id === newer.id)).toEqual(listed);
  });
});

describe("DELETE /api/v1/api-keys/:id", () => {
  it("revokes a key, which stops working on the next request", async () => {
    const key = await created("revoked soon", "write");
    expect((await api("/links", { bearer: key.key })).status).toBe(200);

    expect((await api(`/api-keys/${key.id}`, { method: "DELETE" })).status).toBe(204);

    expect((await api("/links", { bearer: key.key })).status).toBe(401);
    expect((await api(`/api-keys/${key.id}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("Authorization: Bearer", () => {
  it("authenticates as the key in GET /auth/session", async () => {
    const key = await created("ci", "read");
    const res = await api("/auth/session", { bearer: key.key });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "apiKey", scope: "read", apiKey: { id: key.id, name: "ci" } });
  });

  it("answers 401 for an unknown or malformed key, even with a session cookie alongside", async () => {
    const key = await created("malformed", "read");
    for (const bearer of [`${key.key}x`, key.key.slice("furea_".length), "furea_"]) {
      const res = await api("/auth/session", { bearer, headers: { cookie } });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
    }
  });

  it("accepts the bearer scheme in any case, and ignores other schemes in favour of the session cookie", async () => {
    const key = await created("scheme case", "read");
    for (const authorization of [`bearer ${key.key}`, `BEARER ${key.key}`]) {
      const res = await api("/auth/session", { headers: { authorization } });
      expect(await res.json()).toMatchObject({ kind: "apiKey" });
    }
    const basic = await api("/auth/session", { headers: { authorization: "Basic dXNlcjpwYXNz" } });
    expect(await basic.json()).toMatchObject({ kind: "session" });
  });

  it("needs no Origin header: scripts do not send one", async () => {
    const key = await created("no origin", "write");
    const res = await exports.default.fetch(
      new Request(`${ORIGIN}/api/v1/links`, {
        method: "POST",
        headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
        body: JSON.stringify({ destination: "https://example.com/from-a-script" }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it("writes last_used_at on first use and not again within a day", async () => {
    const key = await created("touched", "read");
    expect(await lastUsedAt(key.id)).toBeNull();

    expect((await api("/links", { bearer: key.key })).status).toBe(200);
    const first = await lastUsedAt(key.id);
    expect(first).toEqual(expect.any(String));

    expect((await api("/links", { bearer: key.key })).status).toBe(200);
    expect(await lastUsedAt(key.id)).toBe(first);

    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(yesterday, key.id).run();
    expect((await api("/links", { bearer: key.key })).status).toBe(200);
    expect(await lastUsedAt(key.id)).not.toBe(yesterday);
  });
});
