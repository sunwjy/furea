// The API key resource (ADR 0009, *Authentication endpoints*; ADR 0003, *API keys*). Every route here is
// session-only: an API key can never create, list or revoke an API key.

import { CreateApiKeyRequest, type ApiKey, type CreatedApiKey } from "@furea/shared";
import { Hono } from "hono";
import { generateApiKey, sha256Hex } from "../core/crypto.ts";
import { deleteApiKey, insertApiKey, listApiKeys, type ApiKeyRow } from "../core/db/api-keys.ts";
import type { ApiEnv } from "./context.ts";
import { notFound } from "./errors.ts";
import { requireSession } from "./session.ts";
import { jsonBody } from "./validate.ts";

export const apiKeys = new Hono<ApiEnv>();

apiKeys.use(requireSession);

apiKeys.post("/", jsonBody(CreateApiKeyRequest), async (c) => {
  const { name, scope } = c.var.body;
  const { id, key, prefix } = generateApiKey();
  const row = await insertApiKey(c.env.DB, { id, keyHash: await sha256Hex(key), prefix, name, scope });
  return c.json({ ...toApiKey(row), key } satisfies CreatedApiKey, 201);
});

apiKeys.get("/", async (c) => c.json((await listApiKeys(c.env.DB)).map(toApiKey) satisfies ApiKey[]));

apiKeys.delete("/:id", async (c) => ((await deleteApiKey(c.env.DB, c.req.param("id"))) ? c.body(null, 204) : notFound()));

function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scope: row.scope,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}
