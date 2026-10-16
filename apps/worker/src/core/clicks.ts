// Click recording (ADR 0005): one Analytics Engine data point and `click_count + 1` in D1 per click. It takes the
// click facts, never the Request, so nothing IP-derived can reach either store.

import { incrementClickCount } from "./db/links.ts";
import { log } from "./log.ts";

export type DeviceClass = "desktop" | "mobile" | "tablet" | "bot" | "unknown";

/** The only four things remembered about a click. */
export interface ClickFacts {
  slug: string;
  /** ISO country code from Cloudflare, `XX` when absent. */
  country: string;
  /** Lower-cased host of the Referer, `direct` when absent or unparsable. */
  referrerHost: string;
  deviceClass: DeviceClass;
}

export interface ClickStores {
  DB: D1Database;
  /** Absent when the account has no Analytics Engine (ADR 0006); the click is then counted in D1 only. */
  CLICKS?: AnalyticsEngineDataset | undefined;
}

/**
 * Writes the Analytics Engine data point (not awaited) and returns the D1 counter update, for `waitUntil`. Neither
 * store's failure reaches the caller: it is logged as `click_write_failed` and the click is simply missed there.
 */
export function recordClick(stores: ClickStores, facts: ClickFacts): Promise<void> {
  const { slug, country, referrerHost, deviceClass } = facts;
  try {
    stores.CLICKS?.writeDataPoint({ indexes: [slug], blobs: [slug, country, referrerHost, deviceClass], doubles: [1] });
  } catch {
    log({ event: "click_write_failed", slug, store: "wae" });
  }
  return incrementClickCount(stores.DB, slug).catch(() => log({ event: "click_write_failed", slug, store: "d1" }));
}
