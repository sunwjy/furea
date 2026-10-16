// The click breakdowns of ADR 0005, read from Analytics Engine with the SQL API. Every count is
// `sum(_sample_interval)`; every per-link query carries `index1 = <slug> AND timestamp >= <created_at>` so a reused
// slug never inherits a deleted link's clicks (ADR 0002).

import type { InstanceStats, LinkStats, SeriesPoint, StatsRange } from "@furea/shared";
import { countLinks, createdAtOf } from "../db/links.ts";
import type { Env } from "../env.ts";
import { type Bucket, dailyBuckets, rangeBuckets, rangeInterval, sqlDateTime } from "./buckets.ts";
import { createSqlClient, type SqlClient, type SqlRow, sqlString } from "./sql-client.ts";

/** The dataset of the `CLICKS` binding (ADR 0005, manifest). */
export const DATASET = "furea_clicks";
export const TOP = 10;

export type AnalyticsMissing = "binding" | "token";

/**
 * What stops breakdowns on this instance: the `CLICKS` binding (the account has no Analytics Engine, ADR 0006) and/or
 * the `ANALYTICS_TOKEN` secret (with the account id the installer writes next to it). Empty when they are available.
 */
export function analyticsMissing(env: Env): AnalyticsMissing[] {
  const missing: AnalyticsMissing[] = [];
  if (env.CLICKS === undefined) missing.push("binding");
  if (!env.ANALYTICS_TOKEN || !env.FUREA_ACCOUNT_ID) missing.push("token");
  return missing;
}

/** The SQL client for a configured instance; `null` when `analyticsMissing` is not empty. */
export function sqlClientFor(env: Env, fetch: typeof globalThis.fetch): SqlClient | null {
  if (analyticsMissing(env).length > 0 || !env.ANALYTICS_TOKEN || !env.FUREA_ACCOUNT_ID) return null;
  return createSqlClient({ accountId: env.FUREA_ACCOUNT_ID, token: env.ANALYTICS_TOKEN, fetch });
}

export interface StatsRequest {
  range: StatsRange;
  tz: string;
  now: Date;
}

export const bucketColumn = (range: StatsRange, tz: string) =>
  `toStartOfInterval(timestamp, ${rangeInterval(range)}, ${sqlString(tz)}) AS bucket`;

/** `series` over every bucket of the range, empty ones as 0, buckets wholly before `since` dropped to 0 too. */
export function zeroFilled(buckets: Bucket[], rows: SqlRow[], sinceMs = -Infinity): SeriesPoint[] {
  const clicks = new Map(rows.map((row) => [String(row["bucket"]), Number(row["clicks"])]));
  return buckets.map((b) => ({ start: b.start, clicks: b.endMs > sinceMs ? (clicks.get(b.key) ?? 0) : 0 }));
}

export async function linkStats(
  client: SqlClient,
  link: { slug: string; created_at: string },
  { range, tz, now }: StatsRequest,
): Promise<LinkStats> {
  const buckets = rangeBuckets(range, tz, now);
  const where =
    `WHERE index1 = ${sqlString(link.slug)} AND timestamp >= ${sqlDateTime(Date.parse(link.created_at))}\n` +
    `  AND timestamp >= ${sqlDateTime(buckets[0]?.startMs ?? now.getTime())}`;
  const top = (column: string, alias: string) =>
    `SELECT ${column} AS ${alias}, sum(_sample_interval) AS clicks\nFROM ${DATASET}\n${where}\n` +
    `GROUP BY ${alias}\nORDER BY clicks DESC\nLIMIT ${TOP}\nFORMAT JSON`;

  const [series, countries, hosts, devices] = await Promise.all([
    client.query(
      `SELECT ${bucketColumn(range, tz)}, sum(_sample_interval) AS clicks\nFROM ${DATASET}\n${where}\n` +
        "GROUP BY bucket\nORDER BY bucket\nFORMAT JSON",
    ),
    client.query(top("blob2", "country")),
    client.query(top("blob3", "host")),
    client.query(top("blob4", "deviceClass")),
  ]);
  return {
    range,
    tz,
    series: zeroFilled(buckets, series),
    countries: countries.map((r) => ({ country: String(r["country"]), clicks: Number(r["clicks"]) })),
    referrerHosts: hosts.map((r) => ({ host: String(r["host"]), clicks: Number(r["clicks"]) })),
    deviceClasses: devices.map((r) => ({ deviceClass: String(r["deviceClass"]), clicks: Number(r["clicks"]) })),
  };
}

/**
 * The instance overview: the today / 7 d / 30 d tiles over every click, and from one `GROUP BY index1, bucket` query
 * the top links and a series per existing link. Slugs that no longer exist are left out, and a slug's buckets from
 * before its link was created count 0, since that query cannot carry a bound per link.
 */
export async function instanceStats(
  client: SqlClient,
  db: D1Database,
  { range, tz, now }: StatsRequest,
): Promise<InstanceStats> {
  const buckets = rangeBuckets(range, tz, now);
  const days = dailyBuckets(tz, 30, now);
  const since = (dayCount: number) => sqlDateTime(days[days.length - dayCount]?.startMs ?? now.getTime());

  const [rows, tiles, linkCount] = await Promise.all([
    client.query(
      `SELECT index1 AS slug, ${bucketColumn(range, tz)}, sum(_sample_interval) AS clicks\nFROM ${DATASET}\n` +
        `WHERE timestamp >= ${sqlDateTime(buckets[0]?.startMs ?? now.getTime())}\n` +
        "GROUP BY slug, bucket\nORDER BY slug, bucket\nFORMAT JSON",
    ),
    client.query(
      `SELECT sumIf(_sample_interval, timestamp >= ${since(1)}) AS today,\n` +
        `  sumIf(_sample_interval, timestamp >= ${since(7)}) AS last7d,\n` +
        `  sum(_sample_interval) AS last30d\nFROM ${DATASET}\nWHERE timestamp >= ${since(30)}\nFORMAT JSON`,
    ),
    countLinks(db),
  ]);

  const bySlug = new Map<string, SqlRow[]>();
  for (const row of rows) {
    const slug = String(row["slug"]);
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), row]);
  }
  const created = await createdAtOf(db, [...bySlug.keys()]);

  const seriesBySlug: Record<string, SeriesPoint[]> = {};
  const totals: { slug: string; clicks: number }[] = [];
  for (const [slug, slugRows] of bySlug) {
    const createdAt = created.get(slug);
    if (createdAt === undefined) continue;
    const series = zeroFilled(buckets, slugRows, Date.parse(createdAt));
    const clicks = series.reduce((sum, point) => sum + point.clicks, 0);
    if (clicks === 0) continue;
    seriesBySlug[slug] = series;
    totals.push({ slug, clicks });
  }
  totals.sort((a, b) => b.clicks - a.clicks || (a.slug < b.slug ? -1 : 1));

  const tile = (name: string) => Number(tiles[0]?.[name] ?? 0);
  return {
    range,
    tz,
    today: tile("today"),
    last7d: tile("last7d"),
    last30d: tile("last30d"),
    linkCount,
    topLinks: totals.slice(0, TOP),
    seriesBySlug,
  };
}
