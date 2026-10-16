import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { type ClickFacts, recordClick } from "./clicks.ts";
import { getLink, insertLink } from "./db/links.ts";

const FACTS: ClickFacts = { slug: "rec", country: "KR", referrerHost: "news.example.org", deviceClass: "mobile" };

/** Analytics Engine has no local readback, so the data points are captured, or `writeDataPoint` throws. */
function dataset(behaviour: "capture" | "throw" = "capture") {
  const points: AnalyticsEngineDataPoint[] = [];
  const clicks: AnalyticsEngineDataset = {
    writeDataPoint(point) {
      if (behaviour === "throw") throw new Error("injected WAE failure");
      if (point) points.push(point);
    },
  };
  return { clicks, points };
}

/** The real D1 binding, except that every statement fails (fault injection, docs/testing.md). */
const failingDb = new Proxy(env.DB, {
  get(target, property) {
    if (property === "prepare") throw new Error("injected D1 failure");
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  },
});

let errors: MockInstance<Console["error"]>;

beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await env.DB.prepare("DELETE FROM links WHERE slug = ?").bind(FACTS.slug).run();
  await insertLink(env.DB, { slug: FACTS.slug, destination: "https://example.com/rec" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const logged = (): unknown[] => errors.mock.calls.map(([line]) => JSON.parse(String(line)));

describe("recordClick", () => {
  it("writes one data point with the slug as index and adds one to click_count", async () => {
    const { clicks, points } = dataset();
    await recordClick({ DB: env.DB, CLICKS: clicks }, FACTS);
    expect(points).toStrictEqual([
      { indexes: ["rec"], blobs: ["rec", "KR", "news.example.org", "mobile"], doubles: [1] },
    ]);
    expect((await getLink(env.DB, "rec"))?.click_count).toBe(1);
    expect(logged()).toEqual([]);
  });

  it("counts in D1 alone when there is no Analytics Engine binding", async () => {
    await recordClick({ DB: env.DB }, FACTS);
    expect((await getLink(env.DB, "rec"))?.click_count).toBe(1);
    expect(logged()).toEqual([]);
  });

  it("logs a failed data point and still counts the click", async () => {
    const { clicks } = dataset("throw");
    await recordClick({ DB: env.DB, CLICKS: clicks }, FACTS);
    expect((await getLink(env.DB, "rec"))?.click_count).toBe(1);
    expect(logged()).toEqual([{ event: "click_write_failed", slug: "rec", store: "wae" }]);
  });

  it("logs a failed counter update without rejecting, after writing the data point", async () => {
    const { clicks, points } = dataset();
    await expect(recordClick({ DB: failingDb, CLICKS: clicks }, FACTS)).resolves.toBeUndefined();
    expect(points).toHaveLength(1);
    expect((await getLink(env.DB, "rec"))?.click_count).toBe(0);
    expect(logged()).toEqual([{ event: "click_write_failed", slug: "rec", store: "d1" }]);
  });
});
