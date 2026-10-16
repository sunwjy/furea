import { campaignUtmKey } from "@furea/shared";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  campaignUtmKeys,
  deleteCampaign,
  getCampaign,
  insertCampaign,
  listCampaigns,
  renameCampaign,
  updateCampaign,
} from "./campaigns.ts";
import {
  getLink,
  insertCampaignLinks,
  insertLink,
  listCampaignLinks,
  markSyncPending,
  setCampaignLinksEnabled,
  updateLink,
} from "./links.ts";

const T0 = new Date("2026-10-10T00:00:00.000Z");

async function campaign(id: string, name: string, now = T0) {
  expect(
    await insertCampaign(env.DB, { id, name, utmCampaign: name, utmId: null, baseUrl: "https://example.com/c", now }),
  ).toBe(true);
}

function member(slug: string, source: string, medium: string, now = T0) {
  return {
    slug,
    destination: `https://example.com/c?utm_source=${source}&utm_medium=${medium}`,
    title: null,
    utmKey: campaignUtmKey({ source, medium }),
    now,
  };
}

describe("campaigns", () => {
  it("inserts a campaign and reads it back with zero aggregates", async () => {
    await insertCampaign(env.DB, {
      id: "cmpRead00001",
      name: "Spring launch",
      utmCampaign: "spring",
      utmId: "q2",
      baseUrl: "https://example.com/spring",
      now: T0,
    });
    expect(await getCampaign(env.DB, "cmpRead00001")).toEqual({
      id: "cmpRead00001",
      name: "Spring launch",
      utm_campaign: "spring",
      utm_id: "q2",
      base_url: "https://example.com/spring",
      created_at: T0.toISOString(),
      updated_at: T0.toISOString(),
      link_count: 0,
      enabled_link_count: 0,
      click_count: 0,
      sync_pending_link_count: 0,
    });
    expect(await getCampaign(env.DB, "cmpMissing01")).toBeNull();
  });

  it("refuses a campaign name that differs from a taken one only in case or composition", async () => {
    await campaign("cmpName00001", "Été sale");
    const variant = { utmCampaign: "x", utmId: null, baseUrl: "https://example.com/c", now: T0 };
    expect(await insertCampaign(env.DB, { id: "cmpName00002", name: "ÉTÉ SALE", ...variant })).toBe(false);
    expect(await insertCampaign(env.DB, { id: "cmpName00003", name: "Été sale", ...variant })).toBe(false);
    expect(await getCampaign(env.DB, "cmpName00002")).toBeNull();
  });

  it("computes the aggregates from the member links", async () => {
    await campaign("cmpAggr00001", "Aggregates");
    await insertCampaignLinks(env.DB, "cmpAggr00001", [
      member("agg-a", "a", "email"),
      member("agg-b", "b", "email"),
      member("agg-c", "c", "email"),
    ]);
    await env.DB.prepare("UPDATE links SET click_count = ? WHERE slug = ?").bind(5, "agg-a").run();
    await env.DB.prepare("UPDATE links SET click_count = ? WHERE slug = ?").bind(7, "agg-b").run();
    await updateLink(env.DB, "agg-c", { enabled: false });
    await markSyncPending(env.DB, "agg-b");
    // A plain link is no member.
    await insertLink(env.DB, { slug: "agg-plain", destination: "https://example.com/c?utm_source=a&utm_medium=email" });

    expect(await getCampaign(env.DB, "cmpAggr00001")).toMatchObject({
      link_count: 3,
      enabled_link_count: 2,
      click_count: 12,
      sync_pending_link_count: 1,
    });
  });

  it("refuses a case-variant UTM combination inside one campaign, all-or-nothing", async () => {
    await campaign("cmpUtm000001", "Utm one");
    await insertCampaignLinks(env.DB, "cmpUtm000001", [member("utm-a", "Newsletter", "email")]);
    await expect(
      insertCampaignLinks(env.DB, "cmpUtm000001", [
        member("utm-b", "fresh", "email"),
        member("utm-c", "newsletter", "EMAIL"),
      ]),
    ).rejects.toThrow(/UNIQUE/);
    // The batch is one transaction: the clean item was not created either.
    expect(await getLink(env.DB, "utm-b")).toBeNull();
    expect(await getLink(env.DB, "utm-c")).toBeNull();
  });

  it("allows the same UTM combination in another campaign, and on plain links", async () => {
    await campaign("cmpUtm000002", "Utm two");
    await campaign("cmpUtm000003", "Utm three");
    await insertCampaignLinks(env.DB, "cmpUtm000002", [member("utm-x2", "ads", "cpc")]);
    await insertCampaignLinks(env.DB, "cmpUtm000003", [member("utm-x3", "ADS", "cpc")]);
    expect((await getLink(env.DB, "utm-x3"))?.campaign_id).toBe("cmpUtm000003");
    expect(await campaignUtmKeys(env.DB, "cmpUtm000003")).toEqual(
      new Map([[campaignUtmKey({ source: "ads", medium: "cpc" }), "utm-x3"]]),
    );
  });

  it("lists members oldest first, ties by slug", async () => {
    await campaign("cmpOrder0001", "Order");
    const later = new Date(T0.getTime() + 1);
    await insertCampaignLinks(env.DB, "cmpOrder0001", [
      member("ord-z", "z", "m"),
      member("ord-later", "l", "m", later),
      member("ord-a", "a", "m"),
    ]);
    expect((await listCampaignLinks(env.DB, "cmpOrder0001")).map((row) => row.slug)).toEqual([
      "ord-a",
      "ord-z",
      "ord-later",
    ]);
  });

  it("deleting a campaign detaches its links and clears their UTM keys, so the combination is free again", async () => {
    await campaign("cmpDelete001", "Delete me");
    await insertCampaignLinks(env.DB, "cmpDelete001", [member("del-a", "a", "m")]);
    await updateLink(env.DB, "del-a", { enabled: false });

    expect(await deleteCampaign(env.DB, "cmpDelete001")).toBe(true);
    expect(await getCampaign(env.DB, "cmpDelete001")).toBeNull();
    const link = await getLink(env.DB, "del-a");
    expect(link).toMatchObject({ campaign_id: null, enabled: 0, destination: member("del-a", "a", "m").destination });
    const key = await env.DB.prepare("SELECT campaign_utm_key FROM links WHERE slug = 'del-a'").first("campaign_utm_key");
    expect(key).toBeNull();
    expect(await deleteCampaign(env.DB, "cmpDelete001")).toBe(false);
  });

  it("refuses to delete a campaign row that still has members (the foreign key)", async () => {
    await campaign("cmpFk0000001", "Foreign key");
    await insertCampaignLinks(env.DB, "cmpFk0000001", [member("fk-a", "a", "m")]);
    await expect(env.DB.prepare("DELETE FROM campaigns WHERE id = 'cmpFk0000001'").run()).rejects.toThrow(/FOREIGN KEY/);
  });

  it("renames a campaign, refusing a name another campaign holds in any case", async () => {
    await campaign("cmpRename001", "Rename one");
    await campaign("cmpRename002", "Rename two");
    const later = new Date(T0.getTime() + 1000);
    expect(await renameCampaign(env.DB, "cmpRename001", "RENAME TWO", later)).toBe("taken");
    expect(await renameCampaign(env.DB, "cmpRename001", "Rename ONE", later)).toMatchObject({
      name: "Rename ONE",
      updated_at: later.toISOString(),
    });
    expect(await renameCampaign(env.DB, "cmpMissing02", "Whatever", later)).toBeNull();
  });

  it("lists campaigns newest first by id, after a position, matching q on name or UTM campaign", async () => {
    const at = (ms: number) => new Date(Date.UTC(2030, 0, 1) + ms);
    await insertCampaign(env.DB, { id: "listAlpha001", name: "List alpha", utmCampaign: "zeta_q", utmId: null, baseUrl: "https://e.com/", now: at(0) });
    await insertCampaign(env.DB, { id: "listBeta0001", name: "List beta", utmCampaign: "b", utmId: null, baseUrl: "https://e.com/", now: at(1) });
    await insertCampaign(env.DB, { id: "listGamma001", name: "List gamma", utmCampaign: "c", utmId: null, baseUrl: "https://e.com/", now: at(1) });

    const firstTwo = await listCampaigns(env.DB, { limit: 2 });
    expect(firstTwo.map((row) => row.id)).toEqual(["listGamma001", "listBeta0001"]);
    const next = await listCampaigns(env.DB, { limit: 1, after: { createdAt: at(1).toISOString(), slug: "listBeta0001" } });
    expect(next.map((row) => row.id)).toEqual(["listAlpha001"]);
    expect((await listCampaigns(env.DB, { limit: 10, q: "ZETA_" })).map((row) => row.id)).toEqual(["listAlpha001"]);
    expect((await listCampaigns(env.DB, { limit: 10, q: "list g" })).map((row) => row.id)).toEqual(["listGamma001"]);
    expect(await listCampaigns(env.DB, { limit: 10, q: "%" })).toEqual([]);
  });

  it("updates the shared values and rewrites the given members in one batch, leaving other links alone", async () => {
    await campaign("cmpRewrite01", "Rewrite db");
    await insertCampaignLinks(env.DB, "cmpRewrite01", [member("rwdb-a", "a", "m"), member("rwdb-b", "b", "m")]);
    await insertLink(env.DB, { slug: "rwdb-plain", destination: "https://example.com/plain", now: T0 });
    const later = new Date(T0.getTime() + 1000);

    const row = await updateCampaign(
      env.DB,
      "cmpRewrite01",
      { baseUrl: "https://example.com/new", utmCampaign: "autumn", utmId: "q3" },
      [
        { slug: "rwdb-a", destination: "https://example.com/new?utm_source=a" },
        // A slug outside the campaign is never touched, whatever the caller passes.
        { slug: "rwdb-plain", destination: "https://example.com/hijacked" },
      ],
      later,
    );
    expect(row).toMatchObject({
      base_url: "https://example.com/new",
      utm_campaign: "autumn",
      utm_id: "q3",
      updated_at: later.toISOString(),
    });
    expect(await getLink(env.DB, "rwdb-a")).toMatchObject({
      destination: "https://example.com/new?utm_source=a",
      updated_at: later.toISOString(),
    });
    expect((await getLink(env.DB, "rwdb-b"))?.updated_at).toBe(T0.toISOString());
    expect((await getLink(env.DB, "rwdb-plain"))?.destination).toBe("https://example.com/plain");
    expect(await updateCampaign(env.DB, "cmpRewrite01", { utmId: null }, [], later)).toMatchObject({ utm_id: null });
  });

  it("sets enabled on every member and returns them as stored", async () => {
    await campaign("cmpToggle001", "Toggle db");
    await insertCampaignLinks(env.DB, "cmpToggle001", [member("tgdb-a", "a", "m"), member("tgdb-b", "b", "m")]);
    const later = new Date(T0.getTime() + 1000);

    const rows = await setCampaignLinksEnabled(env.DB, "cmpToggle001", false, later);
    expect(rows.map((r) => [r.slug, r.enabled, r.updated_at]).sort()).toEqual([
      ["tgdb-a", 0, later.toISOString()],
      ["tgdb-b", 0, later.toISOString()],
    ]);
    expect(await setCampaignLinksEnabled(env.DB, "cmpMissing03", true, later)).toEqual([]);
  });
});
