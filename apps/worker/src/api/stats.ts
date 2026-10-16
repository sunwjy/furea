// The stats resources (ADR 0009, *Stats*): `GET /links/:slug/stats`, the instance overview `GET /stats` and
// `GET /campaigns/:id/stats` (*Campaign stats*). They answer `503 analytics_unavailable` when breakdowns are not
// configured, naming what is missing.

import { StatsQuery } from "@furea/shared";
import { Hono } from "hono";
import { campaignStats } from "../core/analytics/campaign-stats.ts";
import { analyticsMissing, instanceStats, linkStats, sqlClientFor } from "../core/analytics/stats.ts";
import { getCampaign } from "../core/db/campaigns.ts";
import { getLink, listCampaignLinks } from "../core/db/links.ts";
import type { ApiEnv } from "./context.ts";
import { apiError, notFound } from "./errors.ts";
import { requireCaller } from "./session.ts";
import { queryParams } from "./validate.ts";

export const stats = new Hono<ApiEnv>();

const MISSING = {
  binding: {
    field: "CLICKS",
    code: "binding_missing",
    message: "The Worker has no Analytics Engine binding; Analytics Engine is not enabled on the account.",
  },
  token: {
    field: "ANALYTICS_TOKEN",
    code: "token_missing",
    message: "No analytics token is set; add one with npx furea analytics-token.",
  },
} as const;

const unavailable = (missing: (keyof typeof MISSING)[]) =>
  apiError(
    503,
    "analytics_unavailable",
    `Click breakdowns are not configured: ${missing.map((m) => (m === "binding" ? "no Analytics Engine binding" : "no analytics token")).join(" and ")}.`,
    { details: missing.map((m) => ({ ...MISSING[m] })) },
  );

stats.get("/stats", requireCaller, queryParams(StatsQuery), async (c) => {
  const client = sqlClientFor(c.env, c.var.sqlFetch);
  if (client === null) return unavailable(analyticsMissing(c.env));
  return c.json(await instanceStats(client, c.env.DB, { ...c.var.query, now: new Date() }));
});

stats.get("/links/:slug/stats", requireCaller, queryParams(StatsQuery), async (c) => {
  const client = sqlClientFor(c.env, c.var.sqlFetch);
  if (client === null) return unavailable(analyticsMissing(c.env));
  const link = await getLink(c.env.DB, c.req.param("slug"));
  if (link === null) return notFound();
  return c.json(await linkStats(client, link, { ...c.var.query, now: new Date() }));
});

// Membership is read now, from D1: the current members and their created_at become the queries' bounds (ADR 0005).
stats.get("/campaigns/:id/stats", requireCaller, queryParams(StatsQuery), async (c) => {
  const client = sqlClientFor(c.env, c.var.sqlFetch);
  if (client === null) return unavailable(analyticsMissing(c.env));
  const id = c.req.param("id");
  if ((await getCampaign(c.env.DB, id)) === null) return notFound();
  const members = await listCampaignLinks(c.env.DB, id);
  return c.json(await campaignStats(client, members, { ...c.var.query, now: new Date() }));
});
