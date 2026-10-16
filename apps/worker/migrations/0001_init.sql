-- Expand-only: compatible with the previous release's Worker (ADR 0006). Before 0.1.0 this file is edited in place (ADR 0016).

-- Campaigns (ADR 0012, ADR 0016). No stored aggregates: link count, enabled count, lifetime total and sync-pending
-- count are computed from `links` on every read. `name_key` is the fold key of `name` (shared `foldKey`).
CREATE TABLE IF NOT EXISTS campaigns (
  id           TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 12),
  name         TEXT NOT NULL,
  name_key     TEXT NOT NULL,
  utm_campaign TEXT NOT NULL,
  utm_id       TEXT,
  base_url     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
-- Campaign names are unique compared case-insensitively → 409 campaign_name_taken.
CREATE UNIQUE INDEX IF NOT EXISTS campaigns_name_key ON campaigns (name_key);
-- The list order of GET /campaigns: created_at desc, id desc, walked backwards by the cursor.
CREATE INDEX IF NOT EXISTS campaigns_created_at_id ON campaigns (created_at, id);

-- `campaign_id` has no ON DELETE action: deleting a campaign detaches its links in the same batch (ADR 0016), and a
-- delete that forgets to fails on the foreign key. `campaign_utm_key` is the fold keys of the link's own source,
-- medium, content and term (shared `campaignUtmKey`), set and cleared together with `campaign_id`; a comparison key,
-- never read back as data.
CREATE TABLE IF NOT EXISTS links (
  slug             TEXT    NOT NULL PRIMARY KEY,
  destination      TEXT    NOT NULL,
  title            TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  click_count      INTEGER NOT NULL DEFAULT 0,
  cache_synced     INTEGER NOT NULL DEFAULT 1 CHECK (cache_synced IN (0, 1)),
  campaign_id      TEXT    REFERENCES campaigns (id),
  campaign_utm_key TEXT,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  CHECK ((campaign_id IS NULL) = (campaign_utm_key IS NULL))
);
-- No two links of one campaign carry the same UTM combination, ignoring case → utm_combination_taken.
CREATE UNIQUE INDEX IF NOT EXISTS links_campaign_utm_key ON links (campaign_id, campaign_utm_key)
  WHERE campaign_id IS NOT NULL;
-- The member list order (created_at asc, slug asc) and the per-campaign aggregates.
CREATE INDEX IF NOT EXISTS links_campaign_created_at_slug ON links (campaign_id, created_at, slug);
-- The list order of GET /links (ADR 0009): created_at desc, slug desc, walked backwards by the cursor.
CREATE INDEX IF NOT EXISTS links_created_at_slug ON links (created_at, slug);
-- Sync-pending links (ADR 0004), found by the repair pass without scanning the table: usually empty.
CREATE INDEX IF NOT EXISTS links_sync_pending ON links (updated_at, slug) WHERE cache_synced = 0;

-- Instance settings as key/value rows (ADR 0003, ADR 0009): the operator password hash, the login limiter's
-- IP-hash salt, the root destination with its sync-pending marker (ADR 0008), and later Access mode.
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

-- API keys (ADR 0003, ADR 0009): only the SHA-256 of the key is stored, plus the first 8 characters after `furea_`
-- so lists can tell keys apart. Every API request looks its key up here by hash, so revocation is a row delete.
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT NOT NULL PRIMARY KEY,
  key_hash     TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  scope        TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
