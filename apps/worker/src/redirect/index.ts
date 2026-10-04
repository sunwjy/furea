// Visitor-facing paths: slugs, the root and robots.txt. Imports core/ only, never api/ (ADR 0001, ADR 0007).

import { isCustomSlug, isReservedPath } from "@furea/shared";
import { Hono } from "hono";
import { getLink } from "../core/db/links.ts";
import type { Env } from "../core/env.ts";
import { methodNotAllowed, redirectTo, robotsTxt, unknownSlug } from "./responses.ts";

export const redirect = new Hono<{ Bindings: Env }>();

// Hono answers HEAD by running the GET route and dropping the body, so HEAD mirrors GET by construction.
redirect.get("/robots.txt", () => robotsTxt());

redirect.get("*", async (c) => {
  // The raw pathname: c.req.path is percent-decoded, and slugs are matched byte for byte (ADR 0002).
  const segment = new URL(c.req.url).pathname.slice(1);
  // Syntax and reserved-path checks run before any lookup: `/`, multi-segment, `_*` and `.*` paths cost nothing.
  if (!isCustomSlug(segment) || isReservedPath(segment)) return unknownSlug();

  const link = await getLink(c.env.DB, segment);
  if (link === null || link.enabled === 0) return unknownSlug();
  return redirectTo(link.destination);
});

redirect.all("*", () => methodNotAllowed());
