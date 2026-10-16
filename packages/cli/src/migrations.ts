// D1 migrations over the REST API, recorded the way wrangler and `cf` record them (ADR 0006, ADR 0015):
// the `d1_migrations` table, one row per applied file, and each file sent in one `/query` request together
// with its bookkeeping row, so D1 commits both or neither.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CloudflareClient } from "./cloudflare/client.ts";

const TABLE = "d1_migrations";

// Byte for byte wrangler's `initMigrationsTable`.
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS ${TABLE}(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

/** The numbered SQL files in numeric-prefix order, as wrangler sorts them. */
export function migrationFiles(dir: URL): string[] {
  return readdirSync(fileURLToPath(dir))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b));
}

/** Applies every file not yet recorded, in order, stopping at the first failure; returns the applied names. */
export async function applyMigrations(client: CloudflareClient, accountId: string, databaseId: string, dir: URL): Promise<string[]> {
  const results = await client.d1Query<{ name: string }>(accountId, databaseId, `${CREATE_TABLE}\nSELECT name FROM ${TABLE} ORDER BY id;`);
  const done = new Set((results.at(-1)?.results ?? []).map((row) => row.name));
  const pending = migrationFiles(dir).filter((file) => !done.has(file));
  for (const file of pending) {
    const sql = readFileSync(new URL(file, dir), "utf8").trimEnd();
    const record = `INSERT INTO "${TABLE}" (name) values ('${file.replaceAll("'", "''")}');`;
    await client.d1Query(accountId, databaseId, `${sql}\n${record}`);
  }
  return pending;
}
