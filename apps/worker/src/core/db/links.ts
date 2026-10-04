// D1 access for the `links` table (ADR 0007: one row type and the query functions per table).

export interface LinkRow {
  slug: string;
  destination: string;
  title: string | null;
  enabled: 0 | 1;
  click_count: number;
  cache_synced: 0 | 1;
  /** ISO 8601, UTC. */
  created_at: string;
  updated_at: string;
}

export interface NewLink {
  slug: string;
  destination: string;
  title?: string | null;
  enabled?: boolean;
  now?: Date;
}

const COLUMNS = "slug, destination, title, enabled, click_count, cache_synced, created_at, updated_at";

export async function getLink(db: D1Database, slug: string): Promise<LinkRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM links WHERE slug = ?`).bind(slug).first<LinkRow>();
}

export async function insertLink(db: D1Database, link: NewLink): Promise<void> {
  const now = (link.now ?? new Date()).toISOString();
  await db
    .prepare(
      "INSERT INTO links (slug, destination, title, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(link.slug, link.destination, link.title ?? null, link.enabled === false ? 0 : 1, now, now)
    .run();
}
