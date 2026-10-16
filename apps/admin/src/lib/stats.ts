// The stats resources as seen by the admin surface (ADR 0009, *Stats*): click breakdowns in the browser's time zone,
// and what is missing when the instance answers 503 analytics_unavailable.

import { InstanceStats, LinkStats, type StatsRange } from "@furea/shared";
import { queryOptions } from "@tanstack/react-query";
import { ApiError, apiJson } from "./api.ts";

/** Day and hour boundaries follow the browser's zone (ADR 0005). */
export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export type AnalyticsMissing = "binding" | "token";

/** What the 503 names as missing; `null` for any other error. */
export function analyticsMissing(error: unknown): AnalyticsMissing[] | null {
  if (!(error instanceof ApiError) || error.code !== "analytics_unavailable") return null;
  const missing: AnalyticsMissing[] = [];
  if (error.details.some((d) => d.code === "binding_missing")) missing.push("binding");
  if (error.details.some((d) => d.code === "token_missing")) missing.push("token");
  return missing;
}

const query = (range: StatsRange) => new URLSearchParams({ range, tz: browserTimeZone() }).toString();

/** Not retried on 503: the instance is not configured for breakdowns, which a retry does not change. */
const retry = (count: number, error: unknown) => analyticsMissing(error) === null && count < 2;

export function instanceStatsQuery(range: StatsRange) {
  return queryOptions({
    queryKey: ["stats", "instance", range],
    queryFn: () => apiJson(`/stats?${query(range)}`, InstanceStats),
    retry,
  });
}

export function linkStatsQuery(slug: string, range: StatsRange) {
  return queryOptions({
    queryKey: ["stats", "link", slug, range],
    queryFn: () => apiJson(`/links/${encodeURIComponent(slug)}/stats?${query(range)}`, LinkStats),
    retry,
  });
}
