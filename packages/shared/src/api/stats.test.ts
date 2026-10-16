import { describe, expect, it } from "vitest";
import { InstanceStats, LinkStats, StatsQuery } from "./stats.ts";

function codes(result: { success: boolean; error?: { issues: { path: PropertyKey[]; code: string; params?: unknown }[] } }) {
  return (
    result.error?.issues.map((i) => ({
      path: i.path.join("."),
      code: (i.params as { code?: string } | undefined)?.code ?? i.code,
    })) ?? []
  );
}

describe("StatsQuery", () => {
  it("defaults to 7d in UTC", () => {
    expect(StatsQuery.parse({})).toEqual({ range: "7d", tz: "UTC" });
  });

  it.each(["24h", "7d", "30d", "90d"])("accepts the range %s", (range) => {
    expect(StatsQuery.parse({ range })).toMatchObject({ range });
  });

  it.each(["Asia/Seoul", "America/Argentina/ComodRivadavia", "Etc/GMT+5", "Asia/Kolkata", "UTC"])(
    "accepts the IANA zone %s",
    (tz) => {
      expect(StatsQuery.parse({ tz })).toMatchObject({ tz });
    },
  );

  it.each(["1d", "7D", "week", ""])("rejects the range %j as range_invalid", (range) => {
    expect(codes(StatsQuery.safeParse({ range }))).toEqual([{ path: "range", code: "range_invalid" }]);
  });

  it.each(["Mars/Olympus", "+09:00", "asia/seoul'", "", "Asia/Seoul; DROP"])("rejects the zone %j as tz_invalid", (tz) => {
    expect(codes(StatsQuery.safeParse({ tz }))).toEqual([{ path: "tz", code: "tz_invalid" }]);
  });

  it("reports both a bad range and a bad zone", () => {
    expect(codes(StatsQuery.safeParse({ range: "1y", tz: "Nowhere" }))).toEqual([
      { path: "range", code: "range_invalid" },
      { path: "tz", code: "tz_invalid" },
    ]);
  });
});

describe("stats responses", () => {
  it("parses a link's breakdowns", () => {
    const doc = {
      range: "24h",
      tz: "Asia/Seoul",
      series: [{ start: "2026-10-16T13:00:00+09:00", clicks: 3 }],
      countries: [{ country: "KR", clicks: 3 }],
      referrerHosts: [{ host: "direct", clicks: 3 }],
      deviceClasses: [{ deviceClass: "mobile", clicks: 3 }],
    };
    expect(LinkStats.parse(doc)).toEqual(doc);
    expect(LinkStats.safeParse({ ...doc, series: [{ start: "2026-10-16", clicks: 1 }] }).success).toBe(false);
  });

  it("parses the instance overview", () => {
    const doc = {
      range: "7d",
      tz: "UTC",
      today: 1,
      last7d: 2,
      last30d: 3,
      linkCount: 4,
      topLinks: [{ slug: "abc", clicks: 2 }],
      seriesBySlug: { abc: [{ start: "2026-10-16T00:00:00Z", clicks: 2 }] },
    };
    expect(InstanceStats.parse(doc)).toEqual(doc);
  });
});
