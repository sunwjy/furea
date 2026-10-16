// The stats resources (ADR 0009, *Stats*; ADR 0005) through the Worker's fetch, with the Analytics Engine SQL API
// replaced by an injected fetch that answers canned SQL API responses (docs/testing.md).

import { InstanceStats, LinkStats } from "@furea/shared";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./core/env.ts";
import { insertLink } from "./core/db/links.ts";
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

describe("without breakdowns configured", () => {
  for (const path of ["/stats", "/links/whatever/stats"]) {
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
