// The settings resource (ADR 0009, *Settings*): the root destination (ADR 0008) next to read-only instance facts.
// Access mode joins it with its own ticket; until then `access` is always `null`.

import { UpdateSettingsRequest, type Settings } from "@furea/shared";
import { Hono } from "hono";
import { getRootDestination, setRootDestination } from "../core/db/settings.ts";
import type { Env } from "../core/env.ts";
import { writeRootThrough } from "../core/sync.ts";
import type { ApiEnv } from "./context.ts";
import { destinationFor } from "./destination.ts";
import { requireCaller, requireWrite } from "./session.ts";
import { jsonBody } from "./validate.ts";

export const settings = new Hono<ApiEnv>();

const updateSettingsRequestFor = (url: URL) =>
  UpdateSettingsRequest.extend({ rootDestination: destinationFor(url).nullable().optional() });

settings.get("/", requireCaller, async (c) => c.json(await settingsOf(c.env)));

// A merge-patch: D1 first, then the reserved cache key (ADR 0004). The cache entry is written even when nothing
// changed, so `PATCH {}` repairs it, as for links. A failed cache write leaves the root sync pending, not an error.
settings.patch("/", requireWrite, jsonBody(updateSettingsRequestFor), async (c) => {
  const { rootDestination } = c.var.body;
  if (rootDestination !== undefined) await setRootDestination(c.env.DB, rootDestination);
  await writeRootThrough(c.env.DB, c.env.KV);
  return c.json(await settingsOf(c.env));
});

async function settingsOf(env: Env): Promise<Settings> {
  return {
    rootDestination: await getRootDestination(env.DB),
    access: null,
    analyticsConfigured: Boolean(env.ANALYTICS_TOKEN),
    version: env.FUREA_VERSION,
  };
}
