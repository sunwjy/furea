// The link resource (ADR 0009, *Link* and *Listing*). Every write goes to D1 first, then to the redirect cache
// (ADR 0004).

import {
  campaignUtmKey,
  composeCampaignLink,
  CreateLinkRequest,
  generateSlug,
  ListLinksQuery,
  UpdateLinkRequest,
  type CampaignLinkUtmPatch,
  type ErrorDetail,
  type LinkPage,
} from "@furea/shared";
import { Hono } from "hono";
import { deleteCacheEntry } from "../core/cache.ts";
import { campaignUtmKeys, getCampaign, utmPartsOf } from "../core/db/campaigns.ts";
import { deleteLink, getLink, insertLink, listLinks, updateLink, type LinkRow } from "../core/db/links.ts";
import { writeThrough } from "../core/sync.ts";
import type { ApiEnv } from "./context.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { composedTooLong, destinationFor } from "./destination.ts";
import { apiError, notFound, validationFailed } from "./errors.ts";
import { toLinkResource, toLinks, utmOf } from "./link-resource.ts";
import { adoptMismatch, planMembership, type MembershipChanges } from "./membership.ts";
import { logScreening, screen } from "./screening.ts";
import { requireCaller, requireWrite } from "./session.ts";
import { jsonBody, queryParams } from "./validate.ts";

export const links = new Hono<ApiEnv>();

/** A collision among 3×10^10 generated slugs is rare; a handful of draws makes a failure practically impossible. */
const GENERATED_SLUG_ATTEMPTS = 5;

const createLinkRequestFor = (url: URL) => CreateLinkRequest.extend({ destination: destinationFor(url) });
const updateLinkRequestFor = (url: URL) => UpdateLinkRequest.extend({ destination: destinationFor(url).optional() });

links.post("/", requireWrite, jsonBody(createLinkRequestFor), async (c) => {
  const { destination, slug, title, screening } = c.var.body;
  const screened = await screen(c.var.caller, [{ field: "destination", url: destination }], screening);
  if (screened instanceof Response) return screened;
  let stored: string | null = null;
  if (slug !== undefined) {
    if (!(await insertLink(c.env.DB, { slug, destination, title }))) {
      return apiError(409, "slug_taken", `The slug "${slug}" is taken.`);
    }
    stored = slug;
  } else {
    for (let attempt = 0; attempt < GENERATED_SLUG_ATTEMPTS && stored === null; attempt++) {
      const candidate = generateSlug();
      if (await insertLink(c.env.DB, { slug: candidate, destination, title })) stored = candidate;
    }
    if (stored === null) throw new Error("no free generated slug");
  }

  const row = await getLink(c.env.DB, stored);
  if (row === null) throw new Error("a created link vanished");
  logScreening(screened, row.slug);
  return c.json(await toLinkResource(c.env.DB, await writeThrough(c.env.DB, c.env.KV, row), c.req.url), 201);
});

links.get("/", requireCaller, queryParams(ListLinksQuery), async (c) => {
  const { limit, cursor, q } = c.var.query;
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  if (after === null) return apiError(400, "cursor_invalid", "The cursor is not one this API returned.");
  // One extra row tells whether another page follows without a count query.
  const rows = await listLinks(c.env.DB, { limit: limit + 1, after, q });
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor =
    rows.length > limit && last !== undefined ? encodeCursor({ createdAt: last.created_at, slug: last.slug }) : null;
  return c.json({ items: await toLinks(c.env.DB, items, c.req.url), nextCursor } satisfies LinkPage);
});

links.get("/:slug", requireCaller, async (c) => {
  const row = await getLink(c.env.DB, c.req.param("slug"));
  if (row === null) return notFound();
  return c.json(await toLinkResource(c.env.DB, row, c.req.url));
});

// A merge-patch (ADR 0009). The cache entry is written even when nothing changed, so `PATCH {}` repairs it. A
// destination is screened whenever it is present, even when its host is the link's current one (ADR 0013).
links.patch("/:slug", requireWrite, jsonBody(updateLinkRequestFor), async (c) => {
  const { destination, title, enabled, campaign, utm, screening } = c.var.body;
  const slug = c.req.param("slug");
  let membership: MembershipChanges = {};
  let recomposed: { destination: string; campaignUtmKey: string } | undefined;
  if (destination !== undefined || campaign !== undefined || utm !== undefined) {
    const current = await getLink(c.env.DB, slug);
    if (current === null) return notFound();
    // No drift (ADR 0012): a campaign link's destination is always composed from the campaign. Detaching in the
    // same request frees it.
    const ownedAfter = campaign === undefined ? current.campaign_id !== null : campaign !== null;
    const details: ErrorDetail[] = [];
    if (destination !== undefined && ownedAfter) {
      details.push({
        field: "destination",
        code: "destination_campaign_owned",
        message: "A campaign link's destination is composed from its campaign; detach the link to edit it.",
      });
    }
    // Own UTM values belong to a link already in its campaign, staying there: not to one being adopted or detached.
    const staysMember = current.campaign_id !== null && (campaign === undefined || campaign?.id === current.campaign_id);
    if (utm !== undefined && !staysMember) {
      details.push({
        field: "utm",
        code: "utm_requires_campaign",
        message: "Only a campaign link has its own UTM values; edit a plain link's destination instead.",
      });
    }
    if (details.length > 0) return validationFailed(details);
    if (campaign !== undefined) {
      const planned = await planMembership(c.env.DB, current, campaign);
      if (planned instanceof Response) return planned;
      membership = planned;
    }
    if (utm !== undefined && current.campaign_id !== null) {
      const own = await recompose(c.env.DB, current, current.campaign_id, utm);
      if (own instanceof Response) return own;
      recomposed = own;
    }
  }
  // Only a destination given as such is screened: a recomposed one keeps the campaign's host (ADR 0009).
  const destinations = destination === undefined ? [] : [{ field: "destination", url: destination }];
  const screened = await screen(c.var.caller, destinations, screening);
  if (screened instanceof Response) return screened;
  let row: LinkRow | null;
  try {
    row = await updateLink(c.env.DB, slug, { destination, title, enabled, ...membership, ...recomposed });
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) {
      // A concurrent write gave the campaign this UTM combination between the check and the update (ADR 0016).
      if (membership.campaign) return adoptMismatch("utm_combination_taken");
      if (recomposed !== undefined) {
        return apiError(409, "utm_combination_taken", "The campaign already has this combination, compared ignoring case.");
      }
    }
    throw err;
  }
  if (row === null) return notFound();
  logScreening(screened, row.slug);
  return c.json(await toLinkResource(c.env.DB, await writeThrough(c.env.DB, c.env.KV, row), c.req.url));
});

links.delete("/:slug", requireWrite, async (c) => {
  const slug = c.req.param("slug");
  const existed = await deleteLink(c.env.DB, slug);
  // Always, like every write (ADR 0004): retrying a delete whose KV step failed must still clear the entry.
  await deleteCacheEntry(c.env.KV, slug);
  return existed ? c.body(null, 204) : notFound();
});

/**
 * A campaign link's destination recomposed with its own UTM values merge-patched (ADR 0009, ADR 0014), and the
 * combination key that goes with it; or the refusal: too long, or a combination another member holds.
 */
async function recompose(
  db: D1Database,
  current: LinkRow,
  campaignId: string,
  patch: CampaignLinkUtmPatch,
): Promise<Response | { destination: string; campaignUtmKey: string }> {
  const campaign = await getCampaign(db, campaignId);
  if (campaign === null) throw new Error("a campaign link's campaign vanished");
  const stored = utmOf(current.destination);
  const own = {
    source: patch.source ?? stored.source,
    medium: patch.medium ?? stored.medium,
    content: patch.content === undefined ? stored.content : patch.content,
    term: patch.term === undefined ? stored.term : patch.term,
  };
  const composed = composeCampaignLink(utmPartsOf(campaign), own);
  const tooLong = composedTooLong(composed, "utm", current.slug);
  if (tooLong !== null) return validationFailed([tooLong]);
  const key = campaignUtmKey(own);
  const holder = (await campaignUtmKeys(db, campaign.id)).get(key);
  if (holder !== undefined && holder !== current.slug) {
    return apiError(409, "utm_combination_taken", `The campaign already has this combination as /${holder}, compared ignoring case.`, {
      details: [
        {
          field: "utm",
          code: "utm_combination_taken",
          message: `The campaign already has this combination as /${holder}, compared ignoring case.`,
          conflictsWith: { slug: holder },
        },
      ],
    });
  }
  return { destination: composed, campaignUtmKey: key };
}
