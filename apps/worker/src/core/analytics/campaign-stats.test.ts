// The four campaign queries of ADR 0005 (section *Campaigns*): one bound per current member, AND-ed with the range,
// and short enough for the SQL API's undocumented 10,000-character limit at the 50-link cap (docs/testing.md).

import { CAMPAIGN_LINK_LIMIT } from "@furea/shared";
import { describe, expect, it } from "vitest";
import { campaignQueries } from "./campaign-stats.ts";

const NOW = new Date("2026-10-16T05:30:00Z");

describe("campaignQueries", () => {
  const members = [
    { slug: "spring-ig", created_at: "2026-10-01T08:15:30.000Z" },
    { slug: "it's", created_at: "2026-10-12T00:00:00.000Z" },
  ];

  it("builds exactly four queries, each OR-ing one bound per member, AND-ed with the range, selecting count()", () => {
    const queries = campaignQueries(members, { range: "7d", tz: "Asia/Seoul", now: NOW });

    expect(Object.keys(queries).sort()).toEqual(["countries", "deviceClasses", "referrerHosts", "series"]);
    for (const sql of Object.values(queries)) {
      expect(sql).toContain("FROM furea_clicks");
      expect(sql).toContain(
        "WHERE ((index1 = 'spring-ig' AND timestamp >= toDateTime('2026-10-01 08:15:30'))\n" +
          "   OR (index1 = 'it\\'s' AND timestamp >= toDateTime('2026-10-12 00:00:00')))\n" +
          // Midnight of 10 October in Seoul.
          "  AND timestamp >= toDateTime('2026-10-09 15:00:00')",
      );
      expect(sql).toContain("sum(_sample_interval) AS clicks");
      expect(sql).toContain("count() AS rows_read");
    }
    expect(queries.series).toContain("SELECT index1 AS slug, toStartOfInterval(timestamp, INTERVAL '1' DAY, 'Asia/Seoul') AS bucket");
    expect(queries.series).toContain("GROUP BY slug, bucket");
    expect(queries.countries).toMatch(/blob2 AS country[\s\S]*GROUP BY country\nORDER BY clicks DESC\nLIMIT 10/);
    expect(queries.referrerHosts).toMatch(/blob3 AS host[\s\S]*GROUP BY host\nORDER BY clicks DESC\nLIMIT 10/);
    expect(queries.deviceClasses).toMatch(/blob4 AS deviceClass[\s\S]*GROUP BY deviceClass\nORDER BY clicks DESC/);
  });

  it("keeps each query at or under 9,000 characters for the worst case the 50-link cap allows", () => {
    // 50 links with 64-character custom slugs, each created at its own instant inside the range, and the longest
    // IANA zone name.
    const worst = Array.from({ length: CAMPAIGN_LINK_LIMIT }, (_, i) => ({
      slug: `${String(i).padStart(2, "0")}-${"x".repeat(61)}`,
      created_at: new Date(NOW.getTime() - (i + 1) * 3_600_000 - i * 1000 - 0.5).toISOString(),
    }));
    expect(worst.every((m) => m.slug.length === 64)).toBe(true);
    const longestZone = "America/Argentina/ComodRivadavia";
    expect(longestZone).toHaveLength(32);

    for (const range of ["24h", "7d", "30d", "90d"] as const) {
      const queries = campaignQueries(worst, { range, tz: longestZone, now: NOW });
      for (const sql of Object.values(queries)) {
        expect(sql.match(/\(index1 = /g)).toHaveLength(50);
        expect(sql.length).toBeLessThanOrEqual(9_000);
      }
    }
  });
});
