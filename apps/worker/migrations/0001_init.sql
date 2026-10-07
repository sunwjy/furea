-- Expand-only: compatible with the previous release's Worker (ADR 0006). Before 0.1.0 this file is edited in place (ADR 0016).

CREATE TABLE IF NOT EXISTS links (
  slug         TEXT    NOT NULL PRIMARY KEY,
  destination  TEXT    NOT NULL,
  title        TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  click_count  INTEGER NOT NULL DEFAULT 0,
  cache_synced INTEGER NOT NULL DEFAULT 1 CHECK (cache_synced IN (0, 1)),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

-- Instance settings as key/value rows (ADR 0003, ADR 0009): the operator password hash, the login limiter's
-- IP-hash salt, and later the root destination and Access mode.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);

-- Browser sessions (ADR 0003): only the SHA-256 of the cookie's session id is stored; 30 days absolute.
CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT NOT NULL PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions (expires_at);
