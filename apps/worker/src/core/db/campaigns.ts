// D1 access for the `campaigns` table (ADR 0007, ADR 0016). Aggregates are computed from the member links on every
// read, never stored (ADR 0009).

import { foldKey } from "@furea/shared";
import type { ListPosition } from "./links.ts";

export interface CampaignRow {
  id: string;
  name: string;
  utm_campaign: string;
  utm_id: string | null;
  base_url: string;
  /** ISO 8601, UTC. */
  created_at: string;
  updated_at: string;
  link_count: number;
  enabled_link_count: number;
  /** Sum of the members' exact lifetime totals. */
  click_count: number;
  sync_pending_link_count: number;
}

export interface NewCampaign {
  id: string;
  name: string;
  utmCampaign: string;
  utmId: string | null;
  baseUrl: string;
  now?: Date;
}

const SELECT =
  "SELECT c.id, c.name, c.utm_campaign, c.utm_id, c.base_url, c.created_at, c.updated_at, " +
  "count(l.slug) AS link_count, coalesce(sum(l.enabled), 0) AS enabled_link_count, " +
  "coalesce(sum(l.click_count), 0) AS click_count, coalesce(sum(1 - l.cache_synced), 0) AS sync_pending_link_count " +
  "FROM campaigns c LEFT JOIN links l ON l.campaign_id = c.id";

/** Inserts a campaign unless its name is taken, compared by fold key; returns whether it did. */
export async function insertCampaign(db: D1Database, campaign: NewCampaign): Promise<boolean> {
  const now = (campaign.now ?? new Date()).toISOString();
  const result = await db
    .prepare(
      "INSERT INTO campaigns (id, name, name_key, utm_campaign, utm_id, base_url, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (name_key) DO NOTHING",
    )
    .bind(
      campaign.id,
      campaign.name,
      foldKey(campaign.name),
      campaign.utmCampaign,
      campaign.utmId,
      campaign.baseUrl,
      now,
      now,
    )
    .run();
  return result.meta.changes === 1;
}

export async function getCampaign(db: D1Database, id: string): Promise<CampaignRow | null> {
  return db.prepare(`${SELECT} WHERE c.id = ? GROUP BY c.id`).bind(id).first<CampaignRow>();
}

export interface CampaignListOptions {
  limit: number;
  /** Rows strictly after this position in `created_at desc, id desc` order; `slug` carries the id. */
  after?: ListPosition | undefined;
  /** Plain substring of the name or the UTM campaign; `%` and `_` match themselves. */
  q?: string | undefined;
}

/** Newest first, ties broken by id descending: the list order of `GET /campaigns` (ADR 0009). */
export async function listCampaigns(db: D1Database, { limit, after, q }: CampaignListOptions): Promise<CampaignRow[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (after) {
    where.push("(c.created_at < ? OR (c.created_at = ? AND c.id < ?))");
    params.push(after.createdAt, after.createdAt, after.slug);
  }
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(c.name LIKE ? ESCAPE '\\' OR c.utm_campaign LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }
  const sql =
    SELECT +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    " GROUP BY c.id ORDER BY c.created_at DESC, c.id DESC LIMIT ?";
  const { results } = await db
    .prepare(sql)
    .bind(...params, limit)
    .all<CampaignRow>();
  return results;
}

/** The campaign as renamed, `"taken"` when another campaign holds the name by fold key, `null` for an unknown id. */
export async function renameCampaign(
  db: D1Database,
  id: string,
  name: string,
  now = new Date(),
): Promise<CampaignRow | "taken" | null> {
  const key = foldKey(name);
  const holder = await db.prepare("SELECT id FROM campaigns WHERE name_key = ?").bind(key).first<string>("id");
  if (holder !== null && holder !== id) return "taken";
  try {
    await db
      .prepare("UPDATE campaigns SET name = ?, name_key = ?, updated_at = ? WHERE id = ?")
      .bind(name, key, now.toISOString(), id)
      .run();
  } catch (err) {
    // A concurrent rename took the name between the check and the update.
    if (err instanceof Error && /UNIQUE/.test(err.message)) return "taken";
    throw err;
  }
  return getCampaign(db, id);
}

/**
 * Detaches every member, then deletes the campaign, in one batch (ADR 0016): links are never deleted or disabled.
 * Returns whether the campaign existed.
 */
export async function deleteCampaign(db: D1Database, id: string): Promise<boolean> {
  const [, deleted] = await db.batch([
    db.prepare("UPDATE links SET campaign_id = NULL, campaign_utm_key = NULL WHERE campaign_id = ?").bind(id),
    db.prepare("DELETE FROM campaigns WHERE id = ?").bind(id),
  ]);
  return deleted?.meta.changes === 1;
}

/** The names of the given campaigns, for the Link resource's `campaign` (ADR 0009). */
export async function campaignNames(db: D1Database, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { results } = await db
    .prepare("SELECT id, name FROM campaigns WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(ids))
    .all<{ id: string; name: string }>();
  return new Map(results.map((row) => [row.id, row.name]));
}

/** The members' UTM combination keys, each with the slug holding it: what a new combination is checked against. */
export async function campaignUtmKeys(db: D1Database, id: string): Promise<Map<string, string>> {
  const { results } = await db
    .prepare("SELECT campaign_utm_key AS key, slug FROM links WHERE campaign_id = ?")
    .bind(id)
    .all<{ key: string; slug: string }>();
  return new Map(results.map((row) => [row.key, row.slug]));
}
