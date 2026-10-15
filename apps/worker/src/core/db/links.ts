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
  title?: string | null | undefined;
  enabled?: boolean;
  now?: Date;
}

const COLUMNS = "slug, destination, title, enabled, click_count, cache_synced, created_at, updated_at";

export async function getLink(db: D1Database, slug: string): Promise<LinkRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM links WHERE slug = ?`).bind(slug).first<LinkRow>();
}

/** Inserts a link unless its slug is taken; returns whether it did. A taken slug is never overwritten. */
export async function insertLink(db: D1Database, link: NewLink): Promise<boolean> {
  const now = (link.now ?? new Date()).toISOString();
  const result = await db
    .prepare(
      "INSERT INTO links (slug, destination, title, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (slug) DO NOTHING",
    )
    .bind(link.slug, link.destination, link.title ?? null, link.enabled === false ? 0 : 1, now, now)
    .run();
  return result.meta.changes === 1;
}

/** Hard delete (ADR 0002); returns whether a link existed. */
export async function deleteLink(db: D1Database, slug: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM links WHERE slug = ?").bind(slug).run();
  return result.meta.changes === 1;
}

export interface ListPosition {
  createdAt: string;
  slug: string;
}

export interface ListOptions {
  limit: number;
  /** Rows strictly after this position in `created_at desc, slug desc` order. */
  after?: ListPosition | undefined;
  /** Plain substring of slug, title or destination; `%` and `_` match themselves. */
  q?: string | undefined;
}

/** Newest first, ties broken by slug (binary, so case-sensitive) descending: ADR 0009's list order. */
export async function listLinks(db: D1Database, { limit, after, q }: ListOptions): Promise<LinkRow[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (after) {
    where.push("(created_at < ? OR (created_at = ? AND slug < ?))");
    params.push(after.createdAt, after.createdAt, after.slug);
  }
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(slug LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR destination LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern, pattern);
  }
  const sql =
    `SELECT ${COLUMNS} FROM links` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY created_at DESC, slug DESC LIMIT ?";
  const { results } = await db
    .prepare(sql)
    .bind(...params, limit)
    .all<LinkRow>();
  return results;
}
