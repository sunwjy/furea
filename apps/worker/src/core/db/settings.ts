// D1 access for the `settings` table: one row per instance setting (ADR 0003, ADR 0008, ADR 0009).

import type { AccessConfig } from "../access.ts";

export type SettingKey =
  /** The operator password in the `shared` hash format (ADR 0003). */
  | "operator_password_hash"
  /** Random salt for the login limiter's IP hash, created on first use; the IP itself is never stored. */
  | "login_ip_salt"
  /** Where `/` redirects (ADR 0008); no row while it is unset. */
  | "root_destination"
  /** Present (value `1`) while the root destination's cache entry lags D1: the root's `cache_synced = 0`. */
  | "root_destination_sync_pending"
  /** Cloudflare Access mode (ADR 0003): both rows present while it is on, neither while it is off. */
  | "access_team_domain"
  | "access_aud";

export async function getSetting(db: D1Database, key: SettingKey): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: SettingKey, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

export async function deleteSetting(db: D1Database, key: SettingKey): Promise<void> {
  await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}

/** Returns the stored value, writing `create()` first if there is none. Concurrent first calls agree on one value. */
export async function getOrCreateSetting(db: D1Database, key: SettingKey, create: () => string): Promise<string> {
  const row = await db
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = value RETURNING value",
    )
    .bind(key, create())
    .first<{ value: string }>();
  if (row === null) throw new Error(`setting ${key} was not written`);
  return row.value;
}

/** Access mode's settings, or `null` while it is off. */
export async function getAccessConfig(db: D1Database): Promise<AccessConfig | null> {
  const { results } = await db
    .prepare("SELECT key, value FROM settings WHERE key IN ('access_team_domain', 'access_aud')")
    .all<{ key: SettingKey; value: string }>();
  const teamDomain = results.find((row) => row.key === "access_team_domain")?.value;
  const aud = results.find((row) => row.key === "access_aud")?.value;
  return teamDomain === undefined || aud === undefined ? null : { teamDomain, aud };
}

/**
 * `null` turns Access mode off. Turning it on also deletes every session row: the password door closes, and a session
 * left over from it must not come back to life if Access mode is turned off again later.
 */
export async function setAccessConfig(db: D1Database, config: AccessConfig | null): Promise<void> {
  if (config === null) {
    await db.prepare("DELETE FROM settings WHERE key IN ('access_team_domain', 'access_aud')").run();
    return;
  }
  const upsert = "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value";
  await db.batch([
    db.prepare(upsert).bind("access_team_domain", config.teamDomain),
    db.prepare(upsert).bind("access_aud", config.aud),
    db.prepare("DELETE FROM sessions"),
  ]);
}

export const getRootDestination = (db: D1Database) => getSetting(db, "root_destination");

/** `null` unsets it. */
export async function setRootDestination(db: D1Database, destination: string | null): Promise<void> {
  if (destination === null) await deleteSetting(db, "root_destination");
  else await setSetting(db, "root_destination", destination);
}

export async function isRootSyncPending(db: D1Database): Promise<boolean> {
  return (await getSetting(db, "root_destination_sync_pending")) !== null;
}

export const markRootSyncPending = (db: D1Database) => setSetting(db, "root_destination_sync_pending", "1");

/**
 * Clears sync pending, but only while the root destination is still `written`: a change made since the cache write
 * keeps its own pending state (the guard `updated_at` gives links).
 */
export async function markRootSynced(db: D1Database, written: string | null): Promise<void> {
  await db
    .prepare(
      "DELETE FROM settings WHERE key = 'root_destination_sync_pending' " +
        "AND (SELECT value FROM settings WHERE key = 'root_destination') IS ?",
    )
    .bind(written)
    .run();
}
