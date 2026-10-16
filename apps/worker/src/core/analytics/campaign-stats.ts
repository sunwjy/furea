// A campaign's click breakdowns (ADR 0005, section *Campaigns*; ADR 0009, *Campaign stats*). Membership is read at
// query time: the four queries carry one `(index1 = <slug> AND timestamp >= <created_at>)` bound per current member,
// so adopting a link brings its earlier clicks in and detaching takes them out, with nothing written at click time.

import type { CampaignStats, SeriesPoint, StatsRange } from "@furea/shared";
import { rangeBuckets, sqlDateTime } from "./buckets.ts";
import { type SqlClient, type SqlRow, sqlString } from "./sql-client.ts";
import { bucketColumn, DATASET, type StatsRequest, TOP, zeroFilled } from "./stats.ts";

export interface CampaignMember {
  slug: string;
  /** ISO 8601, UTC: the member's clicks count from here, so a reused slug never inherits a deleted link's. */
  created_at: string;
}

export interface CampaignQueries {
  /** `GROUP BY index1, bucket`: each member's series and range total, and the combined series. */
  series: string;
  countries: string;
  referrerHosts: string;
  deviceClasses: string;
}

/**
 * The four queries for a campaign with at least one member. Each also selects `count()` (ADR 0005), which v1 does not
 * expose. At the 50-link cap the worst case stays under 9,000 characters, unsplit (docs/testing.md).
 */
export function campaignQueries(
  members: readonly CampaignMember[],
  { range, tz, now }: { range: StatsRange; tz: string; now: Date },
): CampaignQueries {
  const buckets = rangeBuckets(range, tz, now);
  const bounds = members
    .map((m) => `(index1 = ${sqlString(m.slug)} AND timestamp >= ${sqlDateTime(Date.parse(m.created_at))})`)
    .join("\n   OR ");
  const where = `WHERE (${bounds})\n  AND timestamp >= ${sqlDateTime(buckets[0]?.startMs ?? now.getTime())}`;
  const counts = "sum(_sample_interval) AS clicks, count() AS rows_read";
  const top = (column: string, alias: string) =>
    `SELECT ${column} AS ${alias}, ${counts}\nFROM ${DATASET}\n${where}\n` +
    `GROUP BY ${alias}\nORDER BY clicks DESC\nLIMIT ${TOP}\nFORMAT JSON`;
  return {
    series:
      `SELECT index1 AS slug, ${bucketColumn(range, tz)}, ${counts}\nFROM ${DATASET}\n${where}\n` +
      "GROUP BY slug, bucket\nORDER BY slug, bucket\nFORMAT JSON",
    countries: top("blob2", "country"),
    referrerHosts: top("blob3", "host"),
    deviceClasses: top("blob4", "deviceClass"),
  };
}

/**
 * The campaign view's breakdowns over its current members: the combined series and top lists, and `bySlug` with
 * every member, zero-filled. A campaign with no members runs no query.
 */
export async function campaignStats(
  client: SqlClient,
  members: readonly CampaignMember[],
  { range, tz, now }: StatsRequest,
): Promise<CampaignStats> {
  const buckets = rangeBuckets(range, tz, now);
  const empty: CampaignStats = {
    range,
    tz,
    series: zeroFilled(buckets, []),
    countries: [],
    referrerHosts: [],
    deviceClasses: [],
    bySlug: {},
  };
  if (members.length === 0) return empty;

  const queries = campaignQueries(members, { range, tz, now });
  const [series, countries, hosts, devices] = await Promise.all([
    client.query(queries.series),
    client.query(queries.countries),
    client.query(queries.referrerHosts),
    client.query(queries.deviceClasses),
  ]);

  const rowsBySlug = new Map<string, SqlRow[]>();
  for (const row of series) {
    const slug = String(row["slug"]);
    rowsBySlug.set(slug, [...(rowsBySlug.get(slug) ?? []), row]);
  }
  const bySlug: CampaignStats["bySlug"] = {};
  for (const m of members) {
    const points = zeroFilled(buckets, rowsBySlug.get(m.slug) ?? [], Date.parse(m.created_at));
    bySlug[m.slug] = { clicks: points.reduce((sum, p) => sum + p.clicks, 0), series: points };
  }
  const combined: SeriesPoint[] = empty.series.map((point, i) => ({
    start: point.start,
    clicks: Object.values(bySlug).reduce((sum, s) => sum + (s.series[i]?.clicks ?? 0), 0),
  }));

  return {
    ...empty,
    series: combined,
    countries: countries.map((r) => ({ country: String(r["country"]), clicks: Number(r["clicks"]) })),
    referrerHosts: hosts.map((r) => ({ host: String(r["host"]), clicks: Number(r["clicks"]) })),
    deviceClasses: devices.map((r) => ({ deviceClass: String(r["deviceClass"]), clicks: Number(r["clicks"]) })),
    bySlug,
  };
}
