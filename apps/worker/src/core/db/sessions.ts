// D1 access for the `sessions` table (ADR 0003). Rows are keyed by the SHA-256 of the cookie's session id,
// so a database read never yields a usable cookie.

export interface SessionRow {
  id_hash: string;
  /** ISO 8601, UTC. */
  created_at: string;
  expires_at: string;
}

export interface NewSession {
  idHash: string;
  now: Date;
  expiresAt: Date;
}

export async function insertSession(db: D1Database, session: NewSession): Promise<void> {
  await db
    .prepare("INSERT INTO sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)")
    .bind(session.idHash, session.now.toISOString(), session.expiresAt.toISOString())
    .run();
}

/** The session, if it exists and has not reached its expiry at `now`. */
export async function findSession(db: D1Database, idHash: string, now: Date): Promise<SessionRow | null> {
  return db
    .prepare("SELECT id_hash, created_at, expires_at FROM sessions WHERE id_hash = ? AND expires_at > ?")
    .bind(idHash, now.toISOString())
    .first<SessionRow>();
}

export async function deleteSession(db: D1Database, idHash: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(idHash).run();
}

export async function purgeExpiredSessions(db: D1Database, now: Date): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now.toISOString()).run();
}
