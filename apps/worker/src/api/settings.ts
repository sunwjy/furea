// The settings resource (ADR 0009, *Settings*): the root destination (ADR 0008) and Access mode (ADR 0003) next to
// read-only instance facts.

import { UpdateSettingsRequest, type Settings } from "@furea/shared";
import { Hono } from "hono";
import { accessVerifier } from "../core/access.ts";
import { getAccessConfig, getRootDestination, setAccessConfig, setRootDestination } from "../core/db/settings.ts";
import type { Env } from "../core/env.ts";
import { writeRootThrough } from "../core/sync.ts";
import type { ApiEnv } from "./context.ts";
import { destinationFor } from "./destination.ts";
import { apiError } from "./errors.ts";
import { requireCaller, requireWrite } from "./session.ts";
import { jsonBody } from "./validate.ts";

export const settings = new Hono<ApiEnv>();

const updateSettingsRequestFor = (url: URL) =>
  UpdateSettingsRequest.extend({ rootDestination: destinationFor(url).nullable().optional() });

/** The `workers.dev` fallback cannot scope an Access application to /admin, so Access would gate the slugs too. */
const isWorkersDev = (url: URL) => url.hostname.toLowerCase().replace(/\.$/, "").endsWith(".workers.dev");

settings.get("/", requireCaller, async (c) => c.json(await settingsOf(c.env)));

// A merge-patch: every check runs before anything is written, then D1, then the reserved cache key (ADR 0004). The
// cache entry is written even when nothing changed, so `PATCH {}` repairs it, as for links. A failed cache write
// leaves the root sync pending, not an error.
settings.patch("/", requireWrite, jsonBody(updateSettingsRequestFor), async (c) => {
  const { rootDestination, access } = c.var.body;
  if (access !== undefined) {
    // Changing Access mode changes authentication: session only (ADR 0009, *Who may call what*).
    if (c.var.caller?.kind === "apiKey") return apiError(403, "forbidden", "Session required to change Access mode.");
    if (access !== null) {
      // The Worker holds no deploy token, so reaching it through a non-workers.dev host is the proof of an own domain.
      if (isWorkersDev(new URL(c.req.url))) {
        return apiError(409, "access_requires_own_domain", "Access mode needs the instance on its own domain.");
      }
      if (!(await accessVerifier.keysReachable(access.teamDomain))) {
        return apiError(409, "access_unreachable", `Could not fetch the public keys of ${access.teamDomain}.`);
      }
    }
  }
  if (rootDestination !== undefined) await setRootDestination(c.env.DB, rootDestination);
  if (access !== undefined) await setAccessConfig(c.env.DB, access);
  await writeRootThrough(c.env.DB, c.env.KV);
  return c.json(await settingsOf(c.env));
});

async function settingsOf(env: Env): Promise<Settings> {
  return {
    rootDestination: await getRootDestination(env.DB),
    access: await getAccessConfig(env.DB),
    analyticsConfigured: Boolean(env.ANALYTICS_TOKEN),
    version: env.FUREA_VERSION,
  };
}
