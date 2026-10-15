// The link resource (ADR 0009, *Link* and *Listing*). Every write goes to D1 first, then to the redirect cache
// (ADR 0004).

import {
  CreateLinkRequest,
  Destination,
  generateSlug,
  ListLinksQuery,
  type Link,
  type LinkPage,
} from "@furea/shared";
import { Hono } from "hono";
import { cacheEntryOf, deleteCacheEntry, writeCacheEntry } from "../core/cache.ts";
import { deleteLink, getLink, insertLink, listLinks, type LinkRow } from "../core/db/links.ts";
import type { ApiEnv } from "./context.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { apiError, notFound } from "./errors.ts";
import { requireCaller, requireWrite } from "./session.ts";
import { jsonBody, queryParams } from "./validate.ts";

export const links = new Hono<ApiEnv>();

/** A collision among 3×10^10 generated slugs is rare; a handful of draws makes a failure practically impossible. */
const GENERATED_SLUG_ATTEMPTS = 5;

/** `CreateLinkRequest` plus the one rule that needs the request: a destination never points at this instance. */
function createLinkRequestFor(url: URL) {
  const ownHost = hostOf(url);
  return CreateLinkRequest.extend({
    destination: Destination.refine((destination) => hostOf(new URL(destination)) !== ownHost, {
      message: "Must not point at this instance.",
      params: { code: "destination_self" },
    }),
  });
}

/** `s.example.com.` is the same host as `s.example.com`; `URL` already lower-cases it. */
const hostOf = (url: URL) => url.hostname.replace(/\.$/, "");

links.post("/", requireWrite, jsonBody(createLinkRequestFor), async (c) => {
  const { destination, slug, title } = c.var.body;
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
  await writeCacheEntry(c.env.KV, row.slug, cacheEntryOf(row));
  return c.json(toLink(row, c.req.url), 201);
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
  return c.json({ items: items.map((row) => toLink(row, c.req.url)), nextCursor } satisfies LinkPage);
});

links.get("/:slug", requireCaller, async (c) => {
  const row = await getLink(c.env.DB, c.req.param("slug"));
  if (row === null) return notFound();
  return c.json(toLink(row, c.req.url));
});

links.delete("/:slug", requireWrite, async (c) => {
  const slug = c.req.param("slug");
  const existed = await deleteLink(c.env.DB, slug);
  // Always, like every write (ADR 0004): retrying a delete whose KV step failed must still clear the entry.
  await deleteCacheEntry(c.env.KV, slug);
  return existed ? c.body(null, 204) : notFound();
});

/** `shortUrl` names the host the caller used, so `workers.dev` and an own domain each get their own (ADR 0009). */
function toLink(row: LinkRow, requestUrl: string): Link {
  return {
    slug: row.slug,
    shortUrl: `${new URL(requestUrl).origin}/${row.slug}`,
    destination: row.destination,
    title: row.title,
    enabled: row.enabled === 1,
    clickCount: row.click_count,
    cacheSynced: row.cache_synced === 1,
    campaign: null,
    utm: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
