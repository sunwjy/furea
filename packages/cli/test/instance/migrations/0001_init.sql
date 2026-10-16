-- Expand-only: compatible with the previous release's Worker (ADR 0006).
CREATE TABLE IF NOT EXISTS settings (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);
