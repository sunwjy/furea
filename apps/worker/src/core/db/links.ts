// D1 access for the `links` table (ADR 0007: one row type and the query functions per table).

export interface LinkRow {
  slug: string;
  destination: string;
  title: string | null;
  enabled: 0 | 1;
  click_count: number;
  cache_synced: 0 | 1;
  /** The campaign the link belongs to; `null` on a plain link. */
  campaign_id: string | null;
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

const COLUMNS = "slug, destination, title, enabled, click_count, cache_synced, campaign_id, created_at, updated_at";

export async function getLink(db: D1Database, slug: string): Promise<LinkRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM links WHERE slug = ?`).bind(slug).first<LinkRow>();
}

export async function countLinks(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT count(*) AS n FROM links").first<number>("n")) ?? 0;
}

/** `created_at` of each of the given slugs that names an existing link. */
export async function createdAtOf(db: D1Database, slugs: string[]): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();
  const { results } = await db
    .prepare("SELECT slug, created_at FROM links WHERE slug IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(slugs))
    .all<{ slug: string; created_at: string }>();
  return new Map(results.map((row) => [row.slug, row.created_at]));
}

/** Adds one click to the link's lifetime total (ADR 0005). An unknown slug changes nothing. */
export async function incrementClickCount(db: D1Database, slug: string): Promise<void> {
  await db.prepare("UPDATE links SET click_count = click_count + 1 WHERE slug = ?").bind(slug).run();
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

export interface NewCampaignLink {
  slug: string;
  destination: string;
  title: string | null;
  /** `campaignUtmKey` of the link's own UTM values (ADR 0016). */
  utmKey: string;
  now: Date;
}

/**
 * Inserts a campaign's new links in one D1 batch, which is one transaction: a taken slug or a UTM combination the
 * campaign already holds (the `UNIQUE` indexes) throws and leaves none of them created (ADR 0012).
 */
export async function insertCampaignLinks(
  db: D1Database,
  campaignId: string,
  links: readonly NewCampaignLink[],
): Promise<void> {
  if (links.length === 0) return;
  const insert = db.prepare(
    "INSERT INTO links (slug, destination, title, campaign_id, campaign_utm_key, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  await db.batch(
    links.map((link) => {
      const now = link.now.toISOString();
      return insert.bind(link.slug, link.destination, link.title, campaignId, link.utmKey, now, now);
    }),
  );
}

/** Every member of the campaign, oldest first, ties by slug: the member list order (ADR 0009). */
export async function listCampaignLinks(db: D1Database, campaignId: string): Promise<LinkRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM links WHERE campaign_id = ? ORDER BY created_at, slug`)
    .bind(campaignId)
    .all<LinkRow>();
  return results;
}

export interface LinkChanges {
  destination?: string | undefined;
  /** `null` clears the title. */
  title?: string | null | undefined;
  enabled?: boolean | undefined;
  /**
   * `null` detaches; a campaign id with the link's `campaignUtmKey` adopts. `campaign_id` and `campaign_utm_key` are
   * always set and cleared together (ADR 0016).
   */
  campaign?: { id: string; utmKey: string } | null | undefined;
}

/**
 * Applies the given fields and bumps `updated_at`; returns the row as stored, or `null` for an unknown slug. With no
 * fields it only reads the row, so an empty merge-patch leaves `updated_at` alone.
 */
export async function updateLink(
  db: D1Database,
  slug: string,
  changes: LinkChanges,
  now = new Date(),
): Promise<LinkRow | null> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (changes.destination !== undefined) {
    sets.push("destination = ?");
    params.push(changes.destination);
  }
  if (changes.title !== undefined) {
    sets.push("title = ?");
    params.push(changes.title);
  }
  if (changes.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(changes.enabled ? 1 : 0);
  }
  if (changes.campaign !== undefined) {
    sets.push("campaign_id = ?", "campaign_utm_key = ?");
    params.push(changes.campaign?.id ?? null, changes.campaign?.utmKey ?? null);
  }
  if (sets.length === 0) return getLink(db, slug);
  return db
    .prepare(`UPDATE links SET ${sets.join(", ")}, updated_at = ? WHERE slug = ? RETURNING ${COLUMNS}`)
    .bind(...params, now.toISOString(), slug)
    .first<LinkRow>();
}

/** The link's latest change has not reached the redirect cache (ADR 0004). */
export async function markSyncPending(db: D1Database, slug: string): Promise<void> {
  await db.prepare("UPDATE links SET cache_synced = 0 WHERE slug = ?").bind(slug).run();
}

/**
 * The cache now holds `written`. Matching on `updated_at` keeps a link pending when a later edit landed while this
 * version was being written, since the cache may still lag that edit.
 */
export async function markCacheSynced(db: D1Database, written: LinkRow): Promise<void> {
  await db
    .prepare("UPDATE links SET cache_synced = 1 WHERE slug = ? AND updated_at = ? AND cache_synced = 0")
    .bind(written.slug, written.updated_at)
    .run();
}

/** Sync-pending links, least recently changed first; all of them without a limit. */
export async function listSyncPending(db: D1Database, limit?: number): Promise<LinkRow[]> {
  const sql = `SELECT ${COLUMNS} FROM links WHERE cache_synced = 0 ORDER BY updated_at, slug`;
  const statement = limit === undefined ? db.prepare(sql) : db.prepare(`${sql} LIMIT ?`).bind(limit);
  const { results } = await statement.all<LinkRow>();
  return results;
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
