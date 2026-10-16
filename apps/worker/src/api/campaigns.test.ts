// Campaigns through the public API (ADR 0009 *Campaigns*, ADR 0012): create, list, rename, delete, bulk creation and
// the member list. Screening of campaign writes is in screening.test.ts.

import { Campaign, CampaignLinks, campaignUtmKey, CampaignPage, Link, UpdatedCampaign } from "@furea/shared";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { insertCampaignLinks, insertLink } from "../core/db/links.ts";
import { SESSION_COOKIE, startSession } from "./session.ts";

const ORIGIN = "https://s.example.com";

let cookie: string;

beforeAll(async () => {
  const { id } = await startSession(env.DB);
  cookie = `${SESSION_COOKIE}=${id}`;
});

function api(method: string, path: string, body?: unknown): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN, cookie });
  if (body !== undefined) headers.set("content-type", "application/json");
  return exports.default.fetch(
    new Request(`${ORIGIN}/api/v1${path}`, {
      method,
      headers,
      redirect: "manual",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function createCampaign(body: Record<string, unknown>): Promise<Campaign> {
  const res = await api("POST", "/campaigns", { baseUrl: "https://shop.example/spring?ref=a#top", ...body });
  expect(res.status).toBe(201);
  return Campaign.parse(await res.json());
}

async function addLinks(id: string, items: unknown[]): Promise<Link[]> {
  const res = await api("POST", `/campaigns/${id}/links`, { items });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return CampaignLinks.parse(await res.json()).items;
}

async function errorOf(res: Response, status: number) {
  expect(res.status).toBe(status);
  return ((await res.json()) as { error: { code: string; details?: Record<string, unknown>[] } }).error;
}

const countLinks = async () => (await env.DB.prepare("SELECT count(*) AS n FROM links").first<number>("n")) ?? 0;

describe("POST /api/v1/campaigns", () => {
  it("creates a campaign whose UTM campaign defaults to the trimmed name, case kept", async () => {
    const res = await api("POST", "/campaigns", { name: "  Spring Launch ", baseUrl: "https://shop.example/spring" });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const campaign = Campaign.parse(await res.json());
    expect(campaign).toEqual({
      id: expect.stringMatching(/^[23456789A-HJ-NP-Za-km-z]{12}$/),
      name: "Spring Launch",
      utmCampaign: "Spring Launch",
      utmId: null,
      baseUrl: "https://shop.example/spring",
      linkCount: 0,
      enabledLinkCount: 0,
      clickCount: 0,
      syncPendingLinkCount: 0,
      createdAt: expect.any(String),
      updatedAt: campaign.createdAt,
    });
    const read = await api("GET", `/campaigns/${campaign.id}`);
    expect(Campaign.parse(await read.json())).toEqual(campaign);
  });

  it("keeps an explicit UTM campaign and utm_id", async () => {
    const campaign = await createCampaign({ name: "Explicit utm", utmCampaign: "spring_2026", utmId: "Q2" });
    expect(campaign).toMatchObject({ utmCampaign: "spring_2026", utmId: "Q2" });
  });

  it("refuses a name another campaign holds, ignoring case", async () => {
    await createCampaign({ name: "Taken name" });
    expect(await errorOf(await api("POST", "/campaigns", { name: "TAKEN NAME", baseUrl: "https://shop.example/" }), 409))
      .toMatchObject({ code: "campaign_name_taken" });
  });

  it("refuses a base URL with utm_* parameters or pointing at the instance, reporting both fields", async () => {
    const error = await errorOf(
      await api("POST", "/campaigns", { name: "", baseUrl: "https://shop.example/?utm_source=x" }),
      400,
    );
    expect(error.details?.map(({ field, code }) => ({ field, code }))).toEqual([
      { field: "name", code: "invalid" },
      { field: "baseUrl", code: "base_url_has_utm" },
    ]);
    const self = await errorOf(await api("POST", "/campaigns", { name: "Self", baseUrl: `${ORIGIN}/x` }), 400);
    expect(self.details?.map(({ field, code }) => ({ field, code }))).toEqual([
      { field: "baseUrl", code: "destination_self" },
    ]);
  });
});

describe("GET /api/v1/campaigns", () => {
  it("lists newest first with a cursor, and matches q on the name or the UTM campaign", async () => {
    const a = await createCampaign({ name: "Listing alpha", utmCampaign: "lst_shared" });
    const b = await createCampaign({ name: "Listing beta" });
    const c = await createCampaign({ name: "Listing gamma", utmCampaign: "lst_shared" });

    const first = CampaignPage.parse(await (await api("GET", "/campaigns?limit=2&q=listing")).json());
    expect(first.items.map((x) => x.id)).toEqual([c.id, b.id]);
    expect(first.nextCursor).not.toBeNull();
    const second = CampaignPage.parse(
      await (await api("GET", `/campaigns?limit=2&q=listing&cursor=${first.nextCursor}`)).json(),
    );
    expect(second).toEqual({ items: [a], nextCursor: null });

    const byUtm = CampaignPage.parse(await (await api("GET", "/campaigns?q=LST_SHARED")).json());
    expect(byUtm.items.map((x) => x.id)).toEqual([c.id, a.id]);
  });

  it("refuses a cursor it did not issue, and answers 404 for an unknown campaign", async () => {
    expect(await errorOf(await api("GET", "/campaigns?cursor=nope"), 400)).toMatchObject({ code: "cursor_invalid" });
    expect(await errorOf(await api("GET", "/campaigns/noSuchCampgn"), 404)).toMatchObject({ code: "not_found" });
  });
});

describe("PATCH /api/v1/campaigns/:id", () => {
  it("renames the campaign, rewriting nothing", async () => {
    const campaign = await createCampaign({ name: "Before rename" });
    const res = await api("PATCH", `/campaigns/${campaign.id}`, { name: " After rename " });
    expect(res.status).toBe(200);
    expect(UpdatedCampaign.parse(await res.json())).toMatchObject({
      name: "After rename",
      utmCampaign: "Before rename",
      rewrittenLinkCount: 0,
    });
  });

  it("refuses a name another campaign holds, read-only aggregates, and an unknown campaign", async () => {
    await createCampaign({ name: "Rename holder" });
    const campaign = await createCampaign({ name: "Rename mover" });
    expect(await errorOf(await api("PATCH", `/campaigns/${campaign.id}`, { name: "rename HOLDER" }), 409)).toMatchObject({
      code: "campaign_name_taken",
    });
    const readOnly = await errorOf(await api("PATCH", `/campaigns/${campaign.id}`, { clickCount: 9 }), 400);
    expect(readOnly.details).toMatchObject([{ field: "clickCount", code: "read_only_field" }]);
    expect((await api("PATCH", "/campaigns/noSuchCampgn", { name: "x" })).status).toBe(404);
  });
});

describe("POST /api/v1/campaigns/:id/links", () => {
  it("creates every item with its destination composed from the campaign and writes each through", async () => {
    const campaign = await createCampaign({ name: "Bulk create", utmCampaign: "spring", utmId: "q2" });
    const links = await addLinks(campaign.id, [
      { utm: { source: "Newsletter", medium: "email" }, slug: "bulk-news", title: "News" },
      { utm: { source: "ig", medium: "social", content: "story a", term: "shoes" } },
    ]);

    expect(links.map((l) => l.destination)).toEqual([
      "https://shop.example/spring?ref=a&utm_id=q2&utm_source=Newsletter&utm_medium=email&utm_campaign=spring#top",
      "https://shop.example/spring?ref=a&utm_id=q2&utm_source=ig&utm_medium=social&utm_campaign=spring" +
        "&utm_term=shoes&utm_content=story%20a#top",
    ]);
    expect(links[0]).toMatchObject({
      slug: "bulk-news",
      title: "News",
      enabled: true,
      cacheSynced: true,
      campaign: { id: campaign.id, name: "Bulk create" },
      utm: { source: "Newsletter", medium: "email", content: null, term: null },
    });
    expect(links[1]?.slug).toMatch(/^[23456789A-HJ-NP-Za-km-z]{6}$/);
    expect(links[1]?.utm).toEqual({ source: "ig", medium: "social", content: "story a", term: "shoes" });

    for (const link of links) {
      expect(await env.KV.get(link.slug, "json")).toEqual({ to: link.destination, disabled: false });
      const visit = await exports.default.fetch(new Request(`${ORIGIN}/${link.slug}`, { redirect: "manual" }));
      expect(visit.status).toBe(302);
      expect(visit.headers.get("location")).toBe(link.destination);
    }

    const after = Campaign.parse(await (await api("GET", `/campaigns/${campaign.id}`)).json());
    expect(after).toMatchObject({ linkCount: 2, enabledLinkCount: 2, syncPendingLinkCount: 0 });
  });

  it("creates nothing when any item fails, and reports every failure", async () => {
    await insertLink(env.DB, { slug: "bulk-taken", destination: "https://example.com/taken" });
    const campaign = await createCampaign({ name: "Bulk refuse" });
    const [existing] = await addLinks(campaign.id, [{ utm: { source: "Newsletter", medium: "email" } }]);
    const before = await countLinks();

    const res = await api("POST", `/campaigns/${campaign.id}/links`, {
      items: [
        { utm: { source: "fine", medium: "web" }, slug: "bulk-dup" },
        { utm: { source: "newsletter", medium: "EMAIL" } },
        { utm: { source: "fresh", medium: "web" }, slug: "bulk-taken" },
        { utm: { source: "fine ", medium: "Web" }, slug: "bulk-dup" },
        { utm: { source: "long", medium: "x".repeat(2000) } },
      ],
    });
    const error = await errorOf(res, 400);
    expect(error.code).toBe("validation_failed");
    expect(error.details?.map(({ field, code, conflictsWith }) => ({ field, code, conflictsWith }))).toEqual([
      { field: "items[1].utm", code: "utm_combination_taken", conflictsWith: { slug: existing?.slug } },
      { field: "items[2].slug", code: "slug_taken" },
      { field: "items[3].slug", code: "slug_taken", conflictsWith: { item: 0 } },
      { field: "items[3].utm", code: "utm_combination_taken", conflictsWith: { item: 0 } },
      { field: "items[4].utm", code: "rewrite_too_long" },
    ]);
    // The message names the colliding value as stored.
    expect(error.details?.[0]?.["message"]).toMatch(/Newsletter \/ email/);
    expect(await countLinks()).toBe(before);
  });

  it("reports a slug or combination taken while it screened as validation_failed, creating nothing", async () => {
    const campaign = await createCampaign({ name: "Bulk race" });
    const before = await countLinks();
    // Another write lands between validation and the insert: during the base URL's screening lookup.
    const fetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      globalThis.fetch = fetch;
      await insertLink(env.DB, { slug: "bulk-race", destination: "https://example.com/race" });
      await insertCampaignLinks(env.DB, campaign.id, [
        { slug: "bulk-race-b", destination: "https://shop.example/x", title: null, now: new Date(),
          utmKey: campaignUtmKey({ source: "rival", medium: "web" }) },
      ]);
      return fetch(input, init);
    };
    try {
      const res = await api("POST", `/campaigns/${campaign.id}/links`, {
        items: [
          { utm: { source: "fresh", medium: "web" }, slug: "bulk-race" },
          { utm: { source: "Rival", medium: "web" } },
        ],
      });
      const error = await errorOf(res, 400);
      expect(error.code).toBe("validation_failed");
      expect(error.details?.map(({ field, code, conflictsWith }) => ({ field, code, conflictsWith }))).toEqual([
        { field: "items[0].slug", code: "slug_taken", conflictsWith: undefined },
        { field: "items[1].utm", code: "utm_combination_taken", conflictsWith: { slug: "bulk-race-b" } },
      ]);
      expect(await countLinks()).toBe(before + 2);
    } finally {
      globalThis.fetch = fetch;
    }
  });

  it("refuses items past the 50-link cap with campaign_link_limit, creating nothing", async () => {
    const campaign = await createCampaign({ name: "Bulk cap" });
    const items = (n: number, from = 0) =>
      Array.from({ length: n }, (_, i) => ({ utm: { source: `s${from + i}`, medium: "m" } }));
    await addLinks(campaign.id, items(48));
    const before = await countLinks();

    expect(await errorOf(await api("POST", `/campaigns/${campaign.id}/links`, { items: items(3, 48) }), 409)).toMatchObject({
      code: "campaign_link_limit",
    });
    expect(await countLinks()).toBe(before);
    expect(await addLinks(campaign.id, items(2, 48))).toHaveLength(2);
  });

  it("answers 404 for an unknown campaign", async () => {
    const res = await api("POST", "/campaigns/noSuchCampgn/links", { items: [{ utm: { source: "a", medium: "b" } }] });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/campaigns/:id/links", () => {
  it("lists every member oldest first, and only members", async () => {
    const campaign = await createCampaign({ name: "Members" });
    const first = await addLinks(campaign.id, [
      { utm: { source: "z", medium: "m" }, slug: "mem-z" },
      { utm: { source: "a", medium: "m" }, slug: "mem-a" },
    ]);
    const second = await addLinks(campaign.id, [{ utm: { source: "b", medium: "m" }, slug: "mem-b" }]);
    await insertLink(env.DB, { slug: "mem-plain", destination: "https://example.com/plain" });

    const res = await api("GET", `/campaigns/${campaign.id}/links`);
    expect(res.status).toBe(200);
    const { items } = CampaignLinks.parse(await res.json());
    // Request order within one bulk creation, then the later one.
    expect(items.map((l) => l.slug)).toEqual([...first, ...second].map((l) => l.slug));
    expect((await api("GET", "/campaigns/noSuchCampgn/links")).status).toBe(404);
  });
});

describe("DELETE /api/v1/campaigns/:id", () => {
  it("detaches the links, keeping their destinations, state and redirects", async () => {
    const campaign = await createCampaign({ name: "Deleted campaign" });
    const [link] = await addLinks(campaign.id, [{ utm: { source: "a", medium: "m" }, slug: "del-member" }]);
    await api("PATCH", "/links/del-member", { enabled: false });

    expect((await api("DELETE", `/campaigns/${campaign.id}`)).status).toBe(204);
    expect((await api("GET", `/campaigns/${campaign.id}`)).status).toBe(404);
    const detached = Link.parse(await (await api("GET", "/links/del-member")).json());
    expect(detached).toMatchObject({ destination: link?.destination, enabled: false, campaign: null, utm: null });
    expect((await api("DELETE", `/campaigns/${campaign.id}`)).status).toBe(404);
  });
});

describe("campaign links through /links", () => {
  it("carry their campaign and UTM values in the list and on their own", async () => {
    const campaign = await createCampaign({ name: "Through links" });
    await addLinks(campaign.id, [{ utm: { source: "tl", medium: "m", term: "t" }, slug: "through-a" }]);
    const one = Link.parse(await (await api("GET", "/links/through-a")).json());
    expect(one).toMatchObject({
      campaign: { id: campaign.id, name: "Through links" },
      utm: { source: "tl", medium: "m", content: null, term: "t" },
    });
    const page = (await (await api("GET", "/links?q=through-a")).json()) as { items: Link[] };
    expect(page.items).toEqual([one]);
  });

  it("refuse a destination edit: the campaign owns it", async () => {
    const campaign = await createCampaign({ name: "Owned destination" });
    await addLinks(campaign.id, [{ utm: { source: "od", medium: "m" }, slug: "owned-a" }]);
    const error = await errorOf(await api("PATCH", "/links/owned-a", { destination: "https://example.com/else" }), 400);
    expect(error.details).toMatchObject([{ field: "destination", code: "destination_campaign_owned" }]);
    expect((await api("PATCH", "/links/owned-a", { title: "Fine" })).status).toBe(200);
  });

  it("stay out of POST /links, which is plain-only", async () => {
    const res = await api("POST", "/links", { destination: "https://example.com/p", campaign: { id: "x" } });
    expect((await errorOf(res, 400)).details).toMatchObject([{ field: "campaign", code: "unknown_field" }]);
  });
});
