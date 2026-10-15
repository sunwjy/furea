// D1 access for the `api_keys` table (ADR 0003, *API keys*). Rows are found by the SHA-256 of the key, so a
// database read never yields a usable key; the hash itself never leaves this module.

import type { Scope } from "@furea/shared";

export interface ApiKeyRow {
  id: string;
  prefix: string;
  name: string;
  scope: Scope;
  /** ISO 8601, UTC. */
  created_at: string;
  last_used_at: string | null;
}

export interface NewApiKey {
  id: string;
  keyHash: string;
  prefix: string;
  name: string;
  scope: Scope;
  now?: Date;
}

const COLUMNS = "id, prefix, name, scope, created_at, last_used_at";
const DAY_MS = 24 * 60 * 60 * 1000;

export async function insertApiKey(db: D1Database, key: NewApiKey): Promise<ApiKeyRow> {
  const row = await db
    .prepare(
      `INSERT INTO api_keys (id, key_hash, prefix, name, scope, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    )
    .bind(key.id, key.keyHash, key.prefix, key.name, key.scope, (key.now ?? new Date()).toISOString())
    .first<ApiKeyRow>();
  if (row === null) throw new Error("an inserted API key returned no row");
  return row;
}

export async function findApiKeyByHash(db: D1Database, keyHash: string): Promise<ApiKeyRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM api_keys WHERE key_hash = ?`).bind(keyHash).first<ApiKeyRow>();
}

/** Every key, newest first. */
export async function listApiKeys(db: D1Database): Promise<ApiKeyRow[]> {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM api_keys ORDER BY created_at DESC, id DESC`).all<ApiKeyRow>();
  return results;
}

/** Revocation; returns whether the key existed. */
export async function deleteApiKey(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM api_keys WHERE id = ?").bind(id).run();
  return result.meta.changes === 1;
}

/**
 * Records a use unless one was recorded within the last 24 hours, so key usage does not eat the D1 write budget
 * (ADR 0003); returns whether it wrote. The condition lives in SQL so concurrent requests write at most once.
 */
export async function touchApiKey(db: D1Database, id: string, now = new Date()): Promise<boolean> {
  const result = await db
    .prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)")
    .bind(now.toISOString(), id, new Date(now.getTime() - DAY_MS).toISOString())
    .run();
  return result.meta.changes === 1;
}

/** Whether `touchApiKey` would write, judged from a row already read, so most requests skip the statement. */
export function isUseDue(row: ApiKeyRow, now = new Date()): boolean {
  return row.last_used_at === null || Date.parse(row.last_used_at) <= now.getTime() - DAY_MS;
}
