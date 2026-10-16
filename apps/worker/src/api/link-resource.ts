// The Link resource (ADR 0009, *Link*) built from D1 rows. A campaign link carries its campaign's id and name and its
// own UTM parameters, parsed from the destination: the destination is their only stored form (ADR 0014).

import { parseUtm, type Link } from "@furea/shared";
import { campaignNames } from "../core/db/campaigns.ts";
import type { LinkRow } from "../core/db/links.ts";

export async function toLinks(db: D1Database, rows: readonly LinkRow[], requestUrl: string): Promise<Link[]> {
  const ids = [...new Set(rows.flatMap((row) => (row.campaign_id === null ? [] : [row.campaign_id])))];
  const names = await campaignNames(db, ids);
  return rows.map((row) => toLink(row, requestUrl, names));
}

export async function toLinkResource(db: D1Database, row: LinkRow, requestUrl: string): Promise<Link> {
  const [link] = await toLinks(db, [row], requestUrl);
  if (link === undefined) throw new Error("no link built");
  return link;
}

/** `shortUrl` names the host the caller used, so `workers.dev` and an own domain each get their own (ADR 0009). */
function toLink(row: LinkRow, requestUrl: string, names: ReadonlyMap<string, string>): Link {
  const name = row.campaign_id === null ? undefined : names.get(row.campaign_id);
  const campaign = row.campaign_id === null || name === undefined ? null : { id: row.campaign_id, name };
  return {
    slug: row.slug,
    shortUrl: `${new URL(requestUrl).origin}/${row.slug}`,
    destination: row.destination,
    title: row.title,
    enabled: row.enabled === 1,
    clickCount: row.click_count,
    cacheSynced: row.cache_synced === 1,
    campaign,
    utm: campaign === null ? null : utmOf(row.destination),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function utmOf(destination: string): NonNullable<Link["utm"]> {
  const { values } = parseUtm(destination);
  return {
    source: values.utm_source,
    medium: values.utm_medium,
    content: values.utm_content === "" ? null : values.utm_content,
    term: values.utm_term === "" ? null : values.utm_term,
  };
}
