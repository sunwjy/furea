// Visitor-facing paths: slugs, the root and robots.txt. Imports core/ only, never api/ (ADR 0001, ADR 0007).

import { isCustomSlug, isReservedPath } from "@furea/shared";
import { Hono } from "hono";
import { cacheEntryOf, readCacheEntry, ROOT_CACHE_KEY, writeCacheEntry } from "../core/cache.ts";
import { getLink } from "../core/db/links.ts";
import type { Env } from "../core/env.ts";
import { methodNotAllowed, redirectTo, robotsTxt, unknownSlug } from "./responses.ts";

export const redirect = new Hono<{ Bindings: Env }>();

// Hono answers HEAD by running the GET route and dropping the body, so HEAD mirrors GET by construction.
redirect.get("/robots.txt", () => robotsTxt());

// The root is never a slug (ADR 0008). Only the cache is read: the same write-through and repair as links keep the
// reserved entry in step with D1. A root redirect is not a click.
redirect.get("/", async (c) => {
  const entry = await readCacheEntry(c.env.KV, ROOT_CACHE_KEY);
  return entry === null || entry.disabled ? unknownSlug() : redirectTo(entry.to);
});

redirect.get("*", async (c) => {
  // The raw pathname: c.req.path is percent-decoded, and slugs are matched byte for byte (ADR 0002).
  const segment = new URL(c.req.url).pathname.slice(1);
  // Syntax and reserved-path checks run before any lookup: `/`, multi-segment, `_*` and `.*` paths cost nothing.
  if (!isCustomSlug(segment) || isReservedPath(segment)) return unknownSlug();

  // KV first (ADR 0004); on a miss D1 answers and the entry is backfilled after the response. An unknown slug is
  // never written to KV, so scanners cannot spend the KV write budget.
  let entry = await readCacheEntry(c.env.KV, segment);
  if (entry === null) {
    const link = await getLink(c.env.DB, segment);
    if (link === null) return unknownSlug();
    entry = cacheEntryOf(link);
    // A failed backfill is retried by the next miss; it is not a sync-pending change, so nothing is logged.
    c.executionCtx.waitUntil(writeCacheEntry(c.env.KV, segment, entry).catch(() => {}));
  }
  if (entry.disabled) return unknownSlug();
  return redirectTo(entry.to);
});

redirect.all("*", () => methodNotAllowed());
