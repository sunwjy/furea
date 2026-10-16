// The stats resources (ADR 0009, *Stats*; ADR 0005) through the Worker's fetch, with the Analytics Engine SQL API
// replaced by an injected fetch that answers canned SQL API responses (docs/testing.md).

import { CampaignStats, campaignUtmKey, InstanceStats, LinkStats } from "@furea/shared";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./core/env.ts";
import { insertCampaign } from "./core/db/campaigns.ts";
import { insertCampaignLinks, insertLink } from "./core/db/links.ts";
import { createWorker } from "./index.ts";
import { SESSION_COOKIE, startSession } from "./api/session.ts";

const ORIGIN = "https://s.example.com";
/** 14:30 in Seoul. */
const NOW = new Date("2026-10-16T05:30:00Z");

let cookie: string;

beforeAll(async () => {
  const { id } = await startSession(env.DB);
  cookie = `${SESSION_COOKIE}=${id}`;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

type Rows = Record<string, string | number>[];

/** Answers each SQL statement with the rows of the first matcher found in it, and records every statement. */
function sqlApi(answers: [RegExp, Rows][]) {
  const statements: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(request.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc-1/analytics_engine/sql");
    expect(request.headers.get("authorization")).toBe("Bearer analytics-ro");
    const sql = await request.text();
    statements.push(sql);
    const rows = answers.find(([pattern]) => pattern.test(sql))?.[1] ?? [];
    const meta = Object.keys(rows[0] ?? {}).map((name) => ({ name, type: name === "clicks" ? "UInt64" : "String" }));
    return Response.json({ meta, data: rows.map((r) => ({ ...r, ...("clicks" in r ? { clicks: String(r["clicks"]) } : {}) })), rows: rows.length });
  }) as typeof globalThis.fetch;
  return { fetch, statements };
}

const CONFIGURED = { ANALYTICS_TOKEN: "analytics-ro", FUREA_ACCOUNT_ID: "acc-1" };

async function get(
  path: string,
  { fetch = sqlApi([]).fetch, bindings = CONFIGURED as Partial<Env> & Record<string, unknown>, drop = [] as (keyof Env)[] } = {},
): Promise<Response> {
  const testEnv: Record<string, unknown> = { ...env, ...bindings };
  for (const name of drop) delete testEnv[name];
  const ctx = createExecutionContext();
  const res = await createWorker({ fetch }).fetch(
    new Request(`${ORIGIN}/api/v1${path}`, { headers: { cookie } }),
    testEnv as unknown as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const day = (date: string) => `${date}T00:00:00+09:00`;
const SEOUL_WEEK = ["10", "11", "12", "13", "14", "15", "16"].map((d) => day(`2026-10-${d}`));

describe("GET /api/v1/links/:slug/stats", () => {
  const SLUG = "stats-link";
  const CREATED = "2026-10-01T08:15:30.000Z";

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM links WHERE slug = ?").bind(SLUG).run();
    await insertLink(env.DB, { slug: SLUG, destination: "https://example.com/s", now: new Date(CREATED) });
  });

  it("returns a zero-filled daily series and the three top lists for 7d in the browser's zone", async () => {
    const api = sqlApi([
      [/GROUP BY bucket/, [
        { bucket: "2026-10-12 00:00:00", clicks: 4 },
        { bucket: "2026-10-16 00:00:00", clicks: 2 },
      ]],
      [/blob2 AS country/, [{ country: "KR", clicks: 5 }, { country: "XX", clicks: 1 }]],
      [/blob3 AS host/, [{ host: "direct", clicks: 6 }]],
      [/blob4 AS deviceClass/, [{ deviceClass: "mobile", clicks: 4 }, { deviceClass: "bot", clicks: 2 }]],
    ]);

    const res = await get(`/links/${SLUG}/stats?range=7d&tz=Asia/Seoul`, { fetch: api.fetch });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(LinkStats.parse(await res.json())).toEqual({
      range: "7d",
      tz: "Asia/Seoul",
      series: SEOUL_WEEK.map((start, i) => ({ start, clicks: i === 2 ? 4 : i === 6 ? 2 : 0 })),
      countries: [{ country: "KR", clicks: 5 }, { country: "XX", clicks: 1 }],
      referrerHosts: [{ host: "direct", clicks: 6 }],
      deviceClasses: [{ deviceClass: "mobile", clicks: 4 }, { deviceClass: "bot", clicks: 2 }],
    });
  });

  it("bounds every query to the slug since the link's creation and to the range, counting sum(_sample_interval)", async () => {
    const api = sqlApi([]);
    await get(`/links/${SLUG}/stats?range=7d&tz=Asia/Seoul`, { fetch: api.fetch });

    expect(api.statements).toHaveLength(4);
    for (const sql of api.statements) {
      expect(sql).toContain("FROM furea_clicks");
      expect(sql).toContain(`index1 = '${SLUG}' AND timestamp >= toDateTime('2026-10-01 08:15:30')`);
      // Midnight of 10 October in Seoul.
      expect(sql).toContain("timestamp >= toDateTime('2026-10-09 15:00:00')");
      expect(sql).toContain("sum(_sample_interval) AS clicks");
    }
    expect(api.statements[0]).toContain("toStartOfInterval(timestamp, INTERVAL '1' DAY, 'Asia/Seoul') AS bucket");
    for (const sql of api.statements.slice(1)) expect(sql).toMatch(/ORDER BY clicks DESC\s+LIMIT 10/);
  });

  it("buckets 24h by the hour, the last 24 including the current one", async () => {
    const api = sqlApi([[/GROUP BY bucket/, [{ bucket: "2026-10-16 14:00:00", clicks: 7 }]]]);

    const body = LinkStats.parse(await (await get(`/links/${SLUG}/stats?range=24h&tz=Asia/Seoul`, { fetch: api.fetch })).json());

    expect(api.statements[0]).toContain("toStartOfInterval(timestamp, INTERVAL '1' HOUR, 'Asia/Seoul') AS bucket");
    expect(api.statements[0]).toContain("timestamp >= toDateTime('2026-10-15 06:00:00')");
    expect(body.series).toHaveLength(24);
    expect(body.series[0]).toEqual({ start: "2026-10-15T15:00:00+09:00", clicks: 0 });
    expect(body.series[23]).toEqual({ start: "2026-10-16T14:00:00+09:00", clicks: 7 });
  });

  it("defaults to 7d in UTC", async () => {
    const body = LinkStats.parse(await (await get(`/links/${SLUG}/stats`)).json());
    expect(body.range).toBe("7d");
    expect(body.tz).toBe("UTC");
    expect(body.series.map((p) => p.start)).toEqual(
      ["10", "11", "12", "13", "14", "15", "16"].map((d) => `2026-10-${d}T00:00:00Z`),
    );
  });

  it("refuses an unknown range or zone as validation_failed, naming each", async () => {
    const res = await get(`/links/${SLUG}/stats?range=1y&tz=Mars/Olympus`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "validation_failed",
        message: expect.any(String),
        details: [
          { field: "range", code: "range_invalid", message: expect.any(String) },
          { field: "tz", code: "tz_invalid", message: expect.any(String) },
        ],
      },
    });
  });

  it("answers 404 for an unknown slug without querying Analytics Engine", async () => {
    const api = sqlApi([]);
    const res = await get("/links/no-such-link/stats", { fetch: api.fetch });
    expect(res.status).toBe(404);
    expect(api.statements).toEqual([]);
  });
});

describe("GET /api/v1/stats", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM links");
    await insertLink(env.DB, { slug: "alpha", destination: "https://example.com/a", now: new Date("2026-09-01T00:00:00Z") });
    await insertLink(env.DB, { slug: "beta", destination: "https://example.com/b", now: new Date("2026-09-01T00:00:00Z") });
    // Re-created on 14 October (Seoul): a deleted link of the same slug had clicks before that.
    await insertLink(env.DB, { slug: "reused", destination: "https://example.com/r", now: new Date("2026-10-13T20:00:00Z") });
  });

  it("returns the tiles, the top links and a zero-filled series per slug from one GROUP BY index1, bucket", async () => {
    const api = sqlApi([
      [/GROUP BY slug, bucket/, [
        { slug: "alpha", bucket: "2026-10-15 00:00:00", clicks: 3 },
        { slug: "alpha", bucket: "2026-10-16 00:00:00", clicks: 1 },
        { slug: "beta", bucket: "2026-10-10 00:00:00", clicks: 9 },
        { slug: "reused", bucket: "2026-10-11 00:00:00", clicks: 50 },
        { slug: "reused", bucket: "2026-10-14 00:00:00", clicks: 2 },
        { slug: "deleted", bucket: "2026-10-12 00:00:00", clicks: 8 },
      ]],
      [/sumIf/, [{ today: 1, last7d: 73, last30d: 120 }]],
    ]);

    const res = await get("/stats?range=7d&tz=Asia/Seoul", { fetch: api.fetch });

    expect(res.status).toBe(200);
    const week = (values: Record<number, number>) => SEOUL_WEEK.map((start, i) => ({ start, clicks: values[i] ?? 0 }));
    expect(InstanceStats.parse(await res.json())).toEqual({
      range: "7d",
      tz: "Asia/Seoul",
      today: 1,
      last7d: 73,
      last30d: 120,
      linkCount: 3,
      topLinks: [
        { slug: "beta", clicks: 9 },
        { slug: "alpha", clicks: 4 },
        { slug: "reused", clicks: 2 },
      ],
      seriesBySlug: { alpha: week({ 5: 3, 6: 1 }), beta: week({ 0: 9 }), reused: week({ 4: 2 }) },
    });
    const series = api.statements.find((sql) => sql.includes("GROUP BY slug, bucket"));
    expect(series).toContain("index1 AS slug");
    expect(series).toContain("toStartOfInterval(timestamp, INTERVAL '1' DAY, 'Asia/Seoul') AS bucket");
    const tiles = api.statements.find((sql) => sql.includes("sumIf"));
    // Today, 7 and 30 days, all in Seoul days.
    expect(tiles).toContain("sumIf(_sample_interval, timestamp >= toDateTime('2026-10-15 15:00:00')) AS today");
    expect(tiles).toContain("sumIf(_sample_interval, timestamp >= toDateTime('2026-10-09 15:00:00')) AS last7d");
    expect(tiles).toContain("timestamp >= toDateTime('2026-09-16 15:00:00')");
    expect(api.statements).toHaveLength(2);
  });

  it("keeps the ten busiest links only", async () => {
    for (let i = 0; i < 12; i++) {
      await insertLink(env.DB, { slug: `many-${i}`, destination: "https://example.com/m", now: new Date("2026-09-01T00:00:00Z") });
    }
    const rows = Array.from({ length: 12 }, (_, i) => ({ slug: `many-${i}`, bucket: "2026-10-16 00:00:00", clicks: i + 1 }));
    const api = sqlApi([[/GROUP BY slug, bucket/, rows]]);

    const body = InstanceStats.parse(await (await get("/stats", { fetch: api.fetch })).json());

    expect(body.topLinks.map((l) => l.slug)).toEqual(Array.from({ length: 10 }, (_, i) => `many-${11 - i}`));
    expect(Object.keys(body.seriesBySlug)).toHaveLength(12);
    expect(body).toMatchObject({ today: 0, last7d: 0, last30d: 0, linkCount: 15 });
  });
});

describe("GET /api/v1/campaigns/:id/stats", () => {
  const CAMPAIGN = "cmpstats0001";

  /** One link's clicks as Analytics Engine holds them: per Seoul day, with the fact each click carried. */
  interface Clicks {
    bucket: string;
    clicks: number;
    country: string;
    host: string;
    deviceClass: string;
  }

  /**
   * A fake SQL API that holds clicks per slug and answers only for the slugs bound in the statement, so what a
   * response contains follows the campaign's current membership, read at query time.
   */
  function clickStore(store: Record<string, Clicks[]>) {
    const statements: string[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const sql = await new Request(input, init).text();
      statements.push(sql);
      const bound = Object.keys(store).filter((slug) => sql.includes(`(index1 = '${slug}' AND`));
      const facts = bound.flatMap((slug) => (store[slug] ?? []).map((c) => ({ slug, ...c })));
      let rows: Record<string, string | number>[];
      if (sql.includes("GROUP BY slug, bucket")) {
        rows = facts.map(({ slug, bucket, clicks }) => ({ slug, bucket, clicks: String(clicks), rows_read: "1" }));
      } else {
        const column = (["country", "host", "deviceClass"] as const).find((c) => sql.includes(`AS ${c},`)) ?? "country";
        const sums = new Map<string, number>();
        for (const fact of facts) sums.set(fact[column], (sums.get(fact[column]) ?? 0) + fact.clicks);
        rows = [...sums]
          .sort((a, b) => b[1] - a[1])
          .map(([value, clicks]) => ({ [column]: value, clicks: String(clicks), rows_read: "1" }));
      }
      const meta = Object.keys(rows[0] ?? {}).map((name) => ({
        name,
        type: name === "clicks" || name === "rows_read" ? "UInt64" : "String",
      }));
      return Response.json({ meta, data: rows, rows: rows.length });
    }) as typeof globalThis.fetch;
    return { fetch, statements };
  }

  const STORE: Record<string, Clicks[]> = {
    "spring-ig": [
      { bucket: "2026-10-12 00:00:00", clicks: 4, country: "KR", host: "www.instagram.com", deviceClass: "mobile" },
    ],
    "spring-fb": [
      { bucket: "2026-10-16 00:00:00", clicks: 2, country: "US", host: "l.facebook.com", deviceClass: "desktop" },
    ],
    // A plain link with clicks from before it was ever in the campaign.
    loose: [{ bucket: "2026-10-11 00:00:00", clicks: 5, country: "KR", host: "direct", deviceClass: "mobile" }],
  };

  const week = (values: Record<number, number>) => SEOUL_WEEK.map((start, i) => ({ start, clicks: values[i] ?? 0 }));
  const member = (slug: string, source: string, created: string) => ({
    slug,
    destination: `https://example.com/spring?utm_source=${source}`,
    title: null,
    utmKey: campaignUtmKey({ source, medium: "social" }),
    now: new Date(created),
  });

  beforeEach(async () => {
    await env.DB.exec("DELETE FROM links");
    await env.DB.exec("DELETE FROM campaigns");
    await insertCampaign(env.DB, {
      id: CAMPAIGN,
      name: "Spring stats",
      utmCampaign: "spring",
      utmId: null,
      baseUrl: "https://example.com/spring",
    });
    await insertCampaignLinks(env.DB, CAMPAIGN, [
      member("spring-ig", "instagram", "2026-10-01T08:15:30.000Z"),
      member("spring-fb", "facebook", "2026-10-12T00:00:00.000Z"),
      member("spring-x", "x", "2026-10-13T00:00:00.000Z"),
    ]);
    await insertLink(env.DB, { slug: "loose", destination: "https://example.com/spring?utm_source=news", now: new Date("2026-09-01T00:00:00Z") });
  });

  it("returns the combined series and top lists, and every current member under bySlug, zero-filled", async () => {
    const api = clickStore(STORE);

    const res = await get(`/campaigns/${CAMPAIGN}/stats?range=7d&tz=Asia/Seoul`, { fetch: api.fetch });

    expect(res.status).toBe(200);
    expect(CampaignStats.parse(await res.json())).toEqual({
      range: "7d",
      tz: "Asia/Seoul",
      series: week({ 2: 4, 6: 2 }),
      countries: [{ country: "KR", clicks: 4 }, { country: "US", clicks: 2 }],
      referrerHosts: [{ host: "www.instagram.com", clicks: 4 }, { host: "l.facebook.com", clicks: 2 }],
      deviceClasses: [{ deviceClass: "mobile", clicks: 4 }, { deviceClass: "desktop", clicks: 2 }],
      bySlug: {
        "spring-ig": { clicks: 4, series: week({ 2: 4 }) },
        "spring-fb": { clicks: 2, series: week({ 6: 2 }) },
        "spring-x": { clicks: 0, series: week({}) },
      },
    });
    expect(api.statements).toHaveLength(4);
    expect(api.statements[0]).toContain("(index1 = 'spring-ig' AND timestamp >= toDateTime('2026-10-01 08:15:30'))");
  });

  it("brings an adopted link's earlier clicks in and takes a detached link's out, by current membership", async () => {
    // Adopt `loose` and detach `spring-ig` the way the campaign-membership writes leave the rows.
    await env.DB.prepare("UPDATE links SET campaign_id = ?, campaign_utm_key = ? WHERE slug = 'loose'")
      .bind(CAMPAIGN, campaignUtmKey({ source: "news", medium: "social" }))
      .run();
    await env.DB.exec("UPDATE links SET campaign_id = NULL, campaign_utm_key = NULL WHERE slug = 'spring-ig'");

    const body = CampaignStats.parse(
      await (await get(`/campaigns/${CAMPAIGN}/stats?range=7d&tz=Asia/Seoul`, { fetch: clickStore(STORE).fetch })).json(),
    );

    expect(body.series).toEqual(week({ 1: 5, 6: 2 }));
    expect(body.countries).toEqual([{ country: "KR", clicks: 5 }, { country: "US", clicks: 2 }]);
    expect(Object.keys(body.bySlug).sort()).toEqual(["loose", "spring-fb", "spring-x"]);
    expect(body.bySlug["loose"]).toEqual({ clicks: 5, series: week({ 1: 5 }) });
  });

  it("answers an empty campaign with zeros and no Analytics Engine query", async () => {
    await env.DB.exec("UPDATE links SET campaign_id = NULL, campaign_utm_key = NULL");
    const api = clickStore(STORE);

    const body = CampaignStats.parse(await (await get(`/campaigns/${CAMPAIGN}/stats?tz=Asia/Seoul`, { fetch: api.fetch })).json());

    expect(body).toEqual({
      range: "7d",
      tz: "Asia/Seoul",
      series: week({}),
      countries: [],
      referrerHosts: [],
      deviceClasses: [],
      bySlug: {},
    });
    expect(api.statements).toEqual([]);
  });

  it("leaves campaigns out of the instance overview: no campaign field and no campaign query", async () => {
    const api = clickStore(STORE);

    const body = await (await get("/stats?tz=Asia/Seoul", { fetch: api.fetch })).json();

    expect(Object.keys(body as object).sort()).toEqual(
      ["last30d", "last7d", "linkCount", "range", "seriesBySlug", "today", "topLinks", "tz"],
    );
    expect(api.statements.join("\n")).not.toMatch(/campaign/i);
  });

  it("answers 404 for an unknown campaign without querying Analytics Engine", async () => {
    const api = clickStore(STORE);
    const res = await get("/campaigns/no-such-campaign/stats", { fetch: api.fetch });
    expect(res.status).toBe(404);
    expect(api.statements).toEqual([]);
  });
});

describe("GET /api/v1/settings", () => {
  it.each([
    ["configured", [], true, []],
    ["without the token", ["ANALYTICS_TOKEN"], false, ["token"]],
    ["without the binding", ["CLICKS"], false, ["binding"]],
    ["without either", ["CLICKS", "ANALYTICS_TOKEN"], false, ["binding", "token"]],
  ] as const)("tells the admin surface %s whether breakdowns work and what is missing", async (_, drop, configured, missing) => {
    const res = await get("/settings", { drop: [...drop] });
    expect(await res.json()).toMatchObject({ analyticsConfigured: configured, analyticsMissing: missing });
  });
});

describe("without breakdowns configured", () => {
  for (const path of ["/stats", "/links/whatever/stats", "/campaigns/whatever/stats"]) {
    it(`GET ${path} answers 503 analytics_unavailable naming the missing token`, async () => {
      const api = sqlApi([]);
      const res = await get(path, { fetch: api.fetch, drop: ["ANALYTICS_TOKEN"] });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: {
          code: "analytics_unavailable",
          message: expect.stringMatching(/analytics token/i),
          details: [{ field: "ANALYTICS_TOKEN", code: "token_missing", message: expect.any(String) }],
        },
      });
      expect(api.statements).toEqual([]);
    });
  }

  it("names the missing Analytics Engine binding, and both when both are missing", async () => {
    const binding = await get("/stats", { drop: ["CLICKS"] });
    expect(binding.status).toBe(503);
    expect(await binding.json()).toMatchObject({
      error: { code: "analytics_unavailable", details: [{ field: "CLICKS", code: "binding_missing" }] },
    });

    const both = await get("/stats", { drop: ["CLICKS", "ANALYTICS_TOKEN"] });
    expect(await both.json()).toMatchObject({
      error: { details: [{ field: "CLICKS", code: "binding_missing" }, { field: "ANALYTICS_TOKEN", code: "token_missing" }] },
    });
  });
});
