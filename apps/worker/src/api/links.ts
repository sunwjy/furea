// The link resource (ADR 0009, *Link* and *Listing*). Every write goes to D1 first, then to the redirect cache
// (ADR 0004).

import {
  CreateLinkRequest,
  generateSlug,
  ListLinksQuery,
  UpdateLinkRequest,
  type LinkPage,
} from "@furea/shared";
import { Hono } from "hono";
import { deleteCacheEntry } from "../core/cache.ts";
import { deleteLink, getLink, insertLink, listLinks, updateLink, type LinkRow } from "../core/db/links.ts";
import { writeThrough } from "../core/sync.ts";
import type { ApiEnv } from "./context.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { destinationFor } from "./destination.ts";
import { apiError, notFound } from "./errors.ts";
import { toLinkResource, toLinks } from "./link-resource.ts";
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
  const { destination, title, enabled, campaign, screening } = c.var.body;
  const slug = c.req.param("slug");
  let membership: MembershipChanges = {};
  if (destination !== undefined || campaign !== undefined) {
    const current = await getLink(c.env.DB, slug);
    if (current === null) return notFound();
    // No drift (ADR 0012): a campaign link's destination is always composed from the campaign. Detaching in the
    // same request frees it.
    const ownedAfter = campaign === undefined ? current.campaign_id !== null : campaign !== null;
    if (destination !== undefined && ownedAfter) {
      return apiError(400, "validation_failed", "The request is invalid.", {
        details: [
          {
            field: "destination",
            code: "destination_campaign_owned",
            message: "A campaign link's destination is composed from its campaign; detach the link to edit it.",
          },
        ],
      });
    }
    if (campaign !== undefined) {
      const planned = await planMembership(c.env.DB, current, campaign);
      if (planned instanceof Response) return planned;
      membership = planned;
    }
  }
  const destinations = destination === undefined ? [] : [{ field: "destination", url: destination }];
  const screened = await screen(c.var.caller, destinations, screening);
  if (screened instanceof Response) return screened;
  let row: LinkRow | null;
  try {
    row = await updateLink(c.env.DB, slug, { destination, title, enabled, ...membership });
  } catch (err) {
    // A concurrent write gave the campaign this UTM combination between the match and the update (ADR 0016).
    if (membership.campaign && err instanceof Error && /UNIQUE/.test(err.message)) {
      return adoptMismatch("utm_combination_taken");
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
