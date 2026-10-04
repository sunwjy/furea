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
