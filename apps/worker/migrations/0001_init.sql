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
-- The list order of GET /links (ADR 0009): created_at desc, slug desc, walked backwards by the cursor.
CREATE INDEX IF NOT EXISTS links_created_at_slug ON links (created_at, slug);
-- Sync-pending links (ADR 0004), found by the repair pass without scanning the table: usually empty.
CREATE INDEX IF NOT EXISTS links_sync_pending ON links (updated_at, slug) WHERE cache_synced = 0;

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
