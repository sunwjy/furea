// Campaign membership through PATCH /links/:slug (ADR 0009 *Membership*, ADR 0012, ADR 0014 *Adopt*): detach and
// adopt.

import { Campaign, CampaignLinks, Link } from "@furea/shared";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { insertLink } from "../core/db/links.ts";
import { SESSION_COOKIE, startSession } from "./session.ts";

const ORIGIN = "https://s.example.com";
const BASE_URL = "https://shop.example/spring?ref=a#top";

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
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function createCampaign(name: string, extra: Record<string, unknown> = {}): Promise<Campaign> {
  const res = await api("POST", "/campaigns", { name, baseUrl: BASE_URL, ...extra });
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
  return ((await res.json()) as { error: { code: string; message: string; details?: Record<string, unknown>[] } })
    .error;
}

async function patch(slug: string, body: unknown): Promise<Link> {
  const res = await api("PATCH", `/links/${slug}`, body);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  return Link.parse(await res.json());
}

describe("detach: PATCH /links/:slug {campaign: null}", () => {
  it("makes the link plain, keeping its destination, state and history", async () => {
    const campaign = await createCampaign("Detach me");
    const [member] = await addLinks(campaign.id, [{ utm: { source: "news", medium: "email" }, slug: "detach-a" }]);
    await env.DB.prepare("UPDATE links SET click_count = 7 WHERE slug = 'detach-a'").run();

    const detached = await patch("detach-a", { campaign: null });
    expect(detached).toMatchObject({ destination: member?.destination, clickCount: 7, campaign: null, utm: null });
    const key = await env.DB.prepare("SELECT campaign_utm_key FROM links WHERE slug = 'detach-a'").first("campaign_utm_key");
    expect(key).toBeNull();
    const after = Campaign.parse(await (await api("GET", `/campaigns/${campaign.id}`)).json());
    expect(after.linkCount).toBe(0);

    // The destination is the operator's again, and a plain link detaches as a no-op.
    expect((await patch("detach-a", { destination: "https://example.com/else" })).destination).toBe(
      "https://example.com/else",
    );
    expect((await patch("detach-a", { campaign: null })).campaign).toBeNull();
  });
});

describe("adopt: PATCH /links/:slug {campaign: {id}}", () => {
  it("adopts a reordered, differently encoded destination and stores the canonical form", async () => {
    const campaign = await createCampaign("Adopt canonical", { utmCampaign: "spring sale" });
    await insertLink(env.DB, {
      slug: "adopt-a",
      destination: "https://shop.example/spring?utm_medium=email&ref=a&utm_campaign=spring+sale&utm_source=news#top",
    });
    await env.DB.prepare("UPDATE links SET click_count = 3 WHERE slug = 'adopt-a'").run();

    const adopted = await patch("adopt-a", { campaign: { id: campaign.id } });
    const canonical = "https://shop.example/spring?ref=a&utm_source=news&utm_medium=email&utm_campaign=spring%20sale#top";
    expect(adopted).toMatchObject({
      destination: canonical,
      clickCount: 3,
      campaign: { id: campaign.id, name: "Adopt canonical" },
      utm: { source: "news", medium: "email", content: null, term: null },
      cacheSynced: true,
    });
    expect(await env.KV.get("adopt-a", "json")).toEqual({ to: canonical, disabled: false });
    const after = Campaign.parse(await (await api("GET", `/campaigns/${campaign.id}`)).json());
    expect(after).toMatchObject({ linkCount: 1, clickCount: 3 });

    // The adopted combination is the campaign's now: bulk creation collides with it.
    const res = await api("POST", `/campaigns/${campaign.id}/links`, { items: [{ utm: { source: "NEWS", medium: "Email" } }] });
    expect((await errorOf(res, 400)).details).toMatchObject([{ code: "utm_combination_taken" }]);
    // Adopting into the campaign it is already in changes nothing.
    expect((await patch("adopt-a", { campaign: { id: campaign.id } })).destination).toBe(canonical);
  });

  it("refuses a mismatch with adopt_mismatch and the reason code, changing nothing", async () => {
    const campaign = await createCampaign("Adopt mismatch");
    await addLinks(campaign.id, [{ utm: { source: "news", medium: "email" }, slug: "mismatch-member" }]);
    const taken = "https://shop.example/spring?ref=a&utm_source=News&utm_medium=email&utm_campaign=Adopt%20mismatch#top";
    await insertLink(env.DB, { slug: "mismatch-a", destination: taken });
    await insertLink(env.DB, { slug: "mismatch-b", destination: "https://shop.example/autumn?utm_source=x&utm_medium=y" });

    const a = await errorOf(await api("PATCH", "/links/mismatch-a", { campaign: { id: campaign.id } }), 409);
    expect(a).toMatchObject({ code: "adopt_mismatch", details: [{ field: "campaign", code: "utm_combination_taken" }] });
    const b = await errorOf(await api("PATCH", "/links/mismatch-b", { campaign: { id: campaign.id }, title: "No" }), 409);
    expect(b).toMatchObject({ code: "adopt_mismatch", details: [{ field: "campaign", code: "base_url_mismatch" }] });
    expect(b.message).toMatch(/base URL/);

    const unchanged = Link.parse(await (await api("GET", "/links/mismatch-a")).json());
    expect(unchanged).toMatchObject({ destination: taken, campaign: null, title: null });
  });

  it("refuses a link of another campaign with campaign_member: detach first", async () => {
    const one = await createCampaign("Member one");
    const two = await createCampaign("Member two");
    await addLinks(one.id, [{ utm: { source: "s", medium: "m" }, slug: "member-a" }]);
    const error = await errorOf(await api("PATCH", "/links/member-a", { campaign: { id: two.id } }), 409);
    expect(error.code).toBe("campaign_member");
    expect((await patch("member-a", {})).campaign?.id).toBe(one.id);
  });

  it("refuses past the 50-link cap with campaign_link_limit", async () => {
    const campaign = await createCampaign("Adopt full");
    await addLinks(
      campaign.id,
      Array.from({ length: 50 }, (_, i) => ({ utm: { source: `s${i}`, medium: "m" } })),
    );
    await insertLink(env.DB, {
      slug: "full-a",
      destination: "https://shop.example/spring?ref=a&utm_source=late&utm_medium=m&utm_campaign=Adopt%20full#top",
    });
    const error = await errorOf(await api("PATCH", "/links/full-a", { campaign: { id: campaign.id } }), 409);
    expect(error.code).toBe("campaign_link_limit");
  });

  it("answers 404 for an unknown campaign or link, and refuses a destination in the same request", async () => {
    const campaign = await createCampaign("Adopt 404");
    await insertLink(env.DB, { slug: "adopt-404", destination: "https://shop.example/spring?ref=a#top" });
    expect((await errorOf(await api("PATCH", "/links/adopt-404", { campaign: { id: "nope" } }), 404)).code).toBe(
      "not_found",
    );
    expect((await api("PATCH", "/links/no-such-link", { campaign: { id: campaign.id } })).status).toBe(404);
    const both = await api("PATCH", "/links/adopt-404", {
      campaign: { id: campaign.id },
      destination: "https://shop.example/spring?ref=a&utm_source=s&utm_medium=m&utm_campaign=Adopt%20404#top",
    });
    expect((await errorOf(both, 400)).details).toMatchObject([{ field: "destination", code: "destination_campaign_owned" }]);
  });
});
