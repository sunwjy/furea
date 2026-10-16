// The campaign resource (ADR 0009, *Campaigns*; ADR 0012). A campaign link's destination is always composed from the
// campaign and the link's own UTM values with the shared ADR 0014 functions; bulk creation is the only way to create
// one, all-or-nothing in D1, then written through to the redirect cache per link (ADR 0004).

import {
  BulkCreateCampaignLinksRequest,
  CAMPAIGN_LINK_LIMIT,
  campaignUtmKey,
  composeUtm,
  CreateCampaignRequest,
  generateSlug,
  ListCampaignsQuery,
  parseUtm,
  randomAlphabetString,
  UpdateCampaignRequest,
  type Campaign,
  type CampaignLinkUtm,
  type CampaignLinks,
  type CampaignPage,
  type ErrorDetail,
  type UpdatedCampaign,
} from "@furea/shared";
import { Hono } from "hono";
import {
  campaignUtmKeys,
  deleteCampaign,
  getCampaign,
  insertCampaign,
  listCampaigns,
  renameCampaign,
  type CampaignRow,
} from "../core/db/campaigns.ts";
import { createdAtOf, insertCampaignLinks, listCampaignLinks, type LinkRow } from "../core/db/links.ts";
import { writeThrough } from "../core/sync.ts";
import type { ApiEnv } from "./context.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { baseUrlFor, destinationFor } from "./destination.ts";
import { apiError, notFound } from "./errors.ts";
import { toLinks } from "./link-resource.ts";
import { logScreening, screen } from "./screening.ts";
import { requireCaller, requireWrite } from "./session.ts";
import { jsonBody, queryParams } from "./validate.ts";

export const campaigns = new Hono<ApiEnv>();

const CAMPAIGN_ID_LENGTH = 12;
/** Rounds of drawing generated slugs for the items without one; a collision is rare, a handful is plenty. */
const GENERATED_SLUG_ROUNDS = 5;

const createCampaignRequestFor = (url: URL) => CreateCampaignRequest.extend({ baseUrl: baseUrlFor(url) });

const nameTaken = (name: string) =>
  apiError(409, "campaign_name_taken", `Another campaign is already named "${name}" (compared ignoring case).`);

campaigns.post("/", requireWrite, jsonBody(createCampaignRequestFor), async (c) => {
  const { name, baseUrl, utmCampaign, utmId, screening } = c.var.body;
  const screened = await screen(c.var.caller, [{ field: "baseUrl", url: baseUrl }], screening);
  if (screened instanceof Response) return screened;
  const id = randomAlphabetString(CAMPAIGN_ID_LENGTH);
  const inserted = await insertCampaign(c.env.DB, {
    id,
    name,
    utmCampaign: utmCampaign ?? name,
    utmId: utmId ?? null,
    baseUrl,
  });
  if (!inserted) return nameTaken(name);
  const row = await getCampaign(c.env.DB, id);
  if (row === null) throw new Error("a created campaign vanished");
  logScreening(screened, { campaign: id });
  return c.json(toCampaign(row), 201);
});

campaigns.get("/", requireCaller, queryParams(ListCampaignsQuery), async (c) => {
  const { limit, cursor, q } = c.var.query;
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  if (after === null) return apiError(400, "cursor_invalid", "The cursor is not one this API returned.");
  const rows = await listCampaigns(c.env.DB, { limit: limit + 1, after, q });
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor =
    rows.length > limit && last !== undefined ? encodeCursor({ createdAt: last.created_at, slug: last.id }) : null;
  return c.json({ items: items.map(toCampaign), nextCursor } satisfies CampaignPage);
});

campaigns.get("/:id", requireCaller, async (c) => {
  const row = await getCampaign(c.env.DB, c.req.param("id"));
  return row === null ? notFound() : c.json(toCampaign(row));
});

// A merge-patch (ADR 0009). Renaming rewrites no link; the fields that do arrive with campaign edits (ADR 0012).
campaigns.patch("/:id", requireWrite, jsonBody(UpdateCampaignRequest), async (c) => {
  const { name } = c.var.body;
  const id = c.req.param("id");
  const row = name === undefined ? await getCampaign(c.env.DB, id) : await renameCampaign(c.env.DB, id, name);
  if (row === "taken") return nameTaken(name ?? "");
  if (row === null) return notFound();
  return c.json({ ...toCampaign(row), rewrittenLinkCount: 0 } satisfies UpdatedCampaign);
});

// Detaches every member and deletes the campaign; links are never deleted or disabled (ADR 0012), so neither their
// destinations nor their cache entries change.
campaigns.delete("/:id", requireWrite, async (c) => {
  return (await deleteCampaign(c.env.DB, c.req.param("id"))) ? c.body(null, 204) : notFound();
});

campaigns.get("/:id/links", requireCaller, async (c) => {
  const id = c.req.param("id");
  if ((await getCampaign(c.env.DB, id)) === null) return notFound();
  const rows = await listCampaignLinks(c.env.DB, id);
  return c.json({ items: await toLinks(c.env.DB, rows, c.req.url) } satisfies CampaignLinks);
});

campaigns.post("/:id/links", requireWrite, jsonBody(BulkCreateCampaignLinksRequest), async (c) => {
  const { items, screening } = c.var.body;
  const campaign = await getCampaign(c.env.DB, c.req.param("id"));
  if (campaign === null) return notFound();
  if (campaign.link_count + items.length > CAMPAIGN_LINK_LIMIT) {
    return apiError(
      409,
      "campaign_link_limit",
      `A campaign holds at most ${CAMPAIGN_LINK_LIMIT} links; this one has ${campaign.link_count}, so at most ` +
        `${CAMPAIGN_LINK_LIMIT - campaign.link_count} more can be added.`,
    );
  }

  // Every item is validated before anything is written, and every failure is reported (ADR 0009).
  const members = new Map((await listCampaignLinks(c.env.DB, campaign.id)).map((row) => [row.slug, row]));
  const takenKeys = await campaignUtmKeys(c.env.DB, campaign.id);
  const givenSlugs = items.flatMap((item) => (item.slug === undefined ? [] : [item.slug]));
  const takenSlugs = await createdAtOf(c.env.DB, givenSlugs);
  const destination = destinationFor(new URL(c.req.url));
  const seenSlugs = new Map<string, number>();
  const seenKeys = new Map<string, number>();
  const details: ErrorDetail[] = [];
  const planned = items.map((item, i) => {
    if (item.slug !== undefined) {
      const earlier = seenSlugs.get(item.slug);
      if (takenSlugs.has(item.slug)) {
        details.push({ field: `items[${i}].slug`, code: "slug_taken", message: `The slug "${item.slug}" is taken.` });
      } else if (earlier !== undefined) {
        details.push({
          field: `items[${i}].slug`,
          code: "slug_taken",
          message: `The slug "${item.slug}" is already used by items[${earlier}].`,
          conflictsWith: { item: earlier },
        });
      } else {
        seenSlugs.set(item.slug, i);
      }
    }
    const utmKey = campaignUtmKey(item.utm);
    const holder = takenKeys.get(utmKey);
    const earlier = seenKeys.get(utmKey);
    if (holder !== undefined) {
      const stored = members.get(holder);
      const value = stored === undefined ? "" : ` (${describeUtm(stored)})`;
      details.push({
        field: `items[${i}].utm`,
        code: "utm_combination_taken",
        message: `The campaign already has this combination as /${holder}${value}, compared ignoring case.`,
        conflictsWith: { slug: holder },
      });
    } else if (earlier !== undefined) {
      details.push({
        field: `items[${i}].utm`,
        code: "utm_combination_taken",
        message: `Same combination as items[${earlier}], compared ignoring case.`,
        conflictsWith: { item: earlier },
      });
    } else {
      seenKeys.set(utmKey, i);
    }
    const composed = compose(campaign, item.utm);
    if (!destination.safeParse(composed).success) {
      details.push({
        field: `items[${i}].utm`,
        code: "destination_invalid",
        message: "The composed destination would be longer than 2048 characters.",
      });
    }
    return { slug: item.slug, destination: composed, title: item.title ?? null, utmKey };
  });
  if (details.length > 0) return apiError(400, "validation_failed", "The request is invalid.", { details });

  // One lookup for the base URL's host: every item shares it (ADR 0013).
  const screened = await screen(c.var.caller, [{ field: "baseUrl", url: campaign.base_url }], screening);
  if (screened instanceof Response) return screened;

  const slugs = await assignSlugs(c.env.DB, planned.map((item) => item.slug));
  // One millisecond apart, so the member list (createdAt asc) keeps the request's order.
  const start = Date.now();
  await insertCampaignLinks(
    c.env.DB,
    campaign.id,
    planned.map((item, i) => ({ ...item, slug: slugs[i] as string, now: new Date(start + i) })),
  );

  const created = new Map((await listCampaignLinks(c.env.DB, campaign.id)).map((row) => [row.slug, row]));
  const synced: LinkRow[] = [];
  for (const slug of slugs) {
    const row = created.get(slug);
    if (row === undefined) throw new Error("a created link vanished");
    synced.push(await writeThrough(c.env.DB, c.env.KV, row));
    logScreening(screened, slug);
  }
  return c.json({ items: await toLinks(c.env.DB, synced, c.req.url) } satisfies CampaignLinks, 201);
});

/** The given custom slugs, with a free generated slug drawn for each item that has none. */
async function assignSlugs(db: D1Database, given: readonly (string | undefined)[]): Promise<string[]> {
  const slugs = [...given];
  for (let round = 0; round < GENERATED_SLUG_ROUNDS; round++) {
    const open = slugs.flatMap((slug, i) => (slug === undefined ? [i] : []));
    if (open.length === 0) return slugs as string[];
    const used = new Set(slugs.filter((slug) => slug !== undefined));
    const candidates = new Map<number, string>();
    for (const i of open) {
      let candidate = generateSlug();
      while (used.has(candidate)) candidate = generateSlug();
      used.add(candidate);
      candidates.set(i, candidate);
    }
    const taken = await createdAtOf(db, [...candidates.values()]);
    for (const [i, candidate] of candidates) if (!taken.has(candidate)) slugs[i] = candidate;
  }
  if (slugs.some((slug) => slug === undefined)) throw new Error("no free generated slug");
  return slugs as string[];
}

function compose(campaign: CampaignRow, utm: CampaignLinkUtm): string {
  return composeUtm(campaign.base_url, {
    utm_id: campaign.utm_id ?? "",
    utm_source: utm.source,
    utm_medium: utm.medium,
    utm_campaign: campaign.utm_campaign,
    utm_term: utm.term ?? "",
    utm_content: utm.content ?? "",
  });
}

/** A member's own UTM values as stored, for a message: `Newsletter / email / story`. */
function describeUtm(row: LinkRow): string {
  const { values } = parseUtm(row.destination);
  return [values.utm_source, values.utm_medium, values.utm_content, values.utm_term]
    .filter((value) => value !== "")
    .join(" / ");
}

function toCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    name: row.name,
    utmCampaign: row.utm_campaign,
    utmId: row.utm_id,
    baseUrl: row.base_url,
    linkCount: row.link_count,
    enabledLinkCount: row.enabled_link_count,
    clickCount: row.click_count,
    syncPendingLinkCount: row.sync_pending_link_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
