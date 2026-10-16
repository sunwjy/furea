// The stats resources of the public API (ADR 0009, *Stats*; ADR 0005): click breakdowns from Analytics Engine,
// last-90-days estimates computed with `sum(_sample_interval)`.

import { z } from "zod";

export const STATS_RANGES = ["24h", "7d", "30d", "90d"] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

/** Letters, digits and `/ _ - +`: every IANA name, and nothing that could end a SQL string literal. */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9/_+-]*$/;

export function isTimeZone(tz: string): boolean {
  if (!ZONE_NAME.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `?range&tz` of every stats endpoint. */
export const StatsQuery = z.object({
  range: z
    .string()
    .refine((range) => (STATS_RANGES as readonly string[]).includes(range), {
      message: `Must be one of ${STATS_RANGES.join(", ")}.`,
      params: { code: "range_invalid" },
    })
    .transform((range) => range as StatsRange)
    .default("7d")
    .describe("24h (hourly buckets), 7d, 30d or 90d (daily buckets)."),
  tz: z
    .string()
    .refine(isTimeZone, { message: "Must be an IANA time zone name.", params: { code: "tz_invalid" } })
    .default("UTC")
    .describe("The IANA time zone that day and hour boundaries follow, usually the browser's."),
});
export type StatsQuery = z.output<typeof StatsQuery>;

/** ISO 8601 with the requested zone's offset (`Z` for UTC). */
const BucketStart = z.iso.datetime({ offset: true });

export const SeriesPoint = z.object({ start: BucketStart, clicks: z.number() });
export type SeriesPoint = z.infer<typeof SeriesPoint>;

const ESTIMATE = "Last 90 days, estimated from Analytics Engine with sum(_sample_interval).";

/** `GET /links/:slug/stats`. */
export const LinkStats = z
  .object({
    range: z.enum(STATS_RANGES),
    tz: z.string(),
    /** Every bucket of the range, oldest first, empty ones as 0: hourly for 24h, daily otherwise. */
    series: z.array(SeriesPoint),
    /** At most 10 each, descending. */
    countries: z.array(z.object({ country: z.string(), clicks: z.number() })),
    referrerHosts: z.array(z.object({ host: z.string(), clicks: z.number() })),
    deviceClasses: z.array(z.object({ deviceClass: z.string(), clicks: z.number() })),
  })
  .describe(ESTIMATE);
export type LinkStats = z.infer<typeof LinkStats>;

/** `GET /stats`, the instance overview. */
export const InstanceStats = z
  .object({
    range: z.enum(STATS_RANGES),
    tz: z.string(),
    today: z.number(),
    last7d: z.number(),
    last30d: z.number(),
    /** How many links exist now (exact, from D1), for the tile next to the click tiles. */
    linkCount: z.number().int(),
    /** The 10 links with the most clicks in the range, descending. */
    topLinks: z.array(z.object({ slug: z.string(), clicks: z.number() })),
    /** Every existing link with a click in the range, each series zero-filled like a link's. */
    seriesBySlug: z.record(z.string(), z.array(SeriesPoint)),
  })
  .describe(ESTIMATE);
export type InstanceStats = z.infer<typeof InstanceStats>;
