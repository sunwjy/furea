// The settings resource (ADR 0009, *Settings*): the root destination (ADR 0008) next to read-only instance facts.
// Access mode joins it with its own ticket; until then `access` is always `null`.

import { UpdateSettingsRequest, type Settings } from "@furea/shared";
import { Hono } from "hono";
import { analyticsMissing } from "../core/analytics/stats.ts";
import { getRootDestination, setRootDestination } from "../core/db/settings.ts";
import type { Env } from "../core/env.ts";
import { writeRootThrough } from "../core/sync.ts";
import type { ApiEnv } from "./context.ts";
import { destinationFor } from "./destination.ts";
import { logScreening, screen } from "./screening.ts";
import { requireCaller, requireWrite } from "./session.ts";
import { jsonBody } from "./validate.ts";

export const settings = new Hono<ApiEnv>();

/** The root destination's stand-in for a slug in log events (ADR 0011). */
const ROOT_SLUG = "_";

const updateSettingsRequestFor = (url: URL) =>
  UpdateSettingsRequest.extend({ rootDestination: destinationFor(url).nullable().optional() });

settings.get("/", requireCaller, async (c) => c.json(await settingsOf(c.env)));

// A merge-patch: D1 first, then the reserved cache key (ADR 0004). The cache entry is written even when nothing
// changed, so `PATCH {}` repairs it, as for links. A failed cache write leaves the root sync pending, not an error.
// A root destination being set is screened like a link's (ADR 0013); its log events name the slug `_`.
settings.patch("/", requireWrite, jsonBody(updateSettingsRequestFor), async (c) => {
  const { rootDestination, screening } = c.var.body;
  const destinations = rootDestination ? [{ field: "rootDestination", url: rootDestination }] : [];
  const screened = await screen(c.var.caller, destinations, screening);
  if (screened instanceof Response) return screened;
  if (rootDestination !== undefined) await setRootDestination(c.env.DB, rootDestination);
  logScreening(screened, ROOT_SLUG);
  await writeRootThrough(c.env.DB, c.env.KV);
  return c.json(await settingsOf(c.env));
});

async function settingsOf(env: Env): Promise<Settings> {
  const missing = analyticsMissing(env);
  return {
    rootDestination: await getRootDestination(env.DB),
    access: null,
    analyticsConfigured: missing.length === 0,
    analyticsMissing: missing,
    version: env.FUREA_VERSION,
  };
}
