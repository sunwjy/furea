// Campaign membership through `PATCH /links/:slug` (ADR 0009 *Membership*, ADR 0012): detach always, adopt only
// when the destination already matches the campaign (ADR 0014 *Adopt*), rewritten to the canonical form. Adopting
// is not screened: the host is unchanged (ADR 0013).

import {
  ADOPT_MISMATCH_MESSAGES,
  CAMPAIGN_LINK_LIMIT,
  matchAdopt,
  type AdoptMismatchReason,
} from "@furea/shared";
import { campaignUtmKeys, getCampaign } from "../core/db/campaigns.ts";
import type { LinkChanges, LinkRow } from "../core/db/links.ts";
import { apiError } from "./errors.ts";

export type MembershipChanges = Pick<LinkChanges, "campaign" | "destination">;

/** The changes `campaign` asks of `current`, or the refusal. Already being where it is asked to be changes nothing. */
export async function planMembership(
  db: D1Database,
  current: LinkRow,
  campaign: { id: string } | null,
): Promise<MembershipChanges | Response> {
  if (campaign === null) return current.campaign_id === null ? {} : { campaign: null };
  if (current.campaign_id === campaign.id) return {};
  if (current.campaign_id !== null) {
    return apiError(
      409,
      "campaign_member",
      "The link belongs to another campaign; detach it first (campaign: null), then adopt it.",
    );
  }
  const row = await getCampaign(db, campaign.id);
  if (row === null) return apiError(404, "not_found", `No campaign has the id "${campaign.id}".`);
  if (row.link_count >= CAMPAIGN_LINK_LIMIT) {
    return apiError(409, "campaign_link_limit", `A campaign holds at most ${CAMPAIGN_LINK_LIMIT} links; this one is full.`);
  }
  const taken = await campaignUtmKeys(db, row.id);
  const match = matchAdopt(
    current.destination,
    { baseUrl: row.base_url, utmCampaign: row.utm_campaign, utmId: row.utm_id },
    taken,
  );
  if (!match.ok) return adoptMismatch(match.reason);
  return { campaign: { id: row.id, utmKey: match.utmKey }, destination: match.destination };
}

export function adoptMismatch(reason: AdoptMismatchReason): Response {
  const message = ADOPT_MISMATCH_MESSAGES[reason];
  return apiError(409, "adopt_mismatch", message, { details: [{ field: "campaign", code: reason, message }] });
}
