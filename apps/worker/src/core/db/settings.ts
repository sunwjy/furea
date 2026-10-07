// D1 access for the `settings` table: one row per instance setting (ADR 0003, ADR 0009).

export type SettingKey =
  /** The operator password in the `shared` hash format (ADR 0003). */
  | "operator_password_hash"
  /** Random salt for the login limiter's IP hash, created on first use; the IP itself is never stored. */
  | "login_ip_salt";

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
