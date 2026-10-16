// The adopt matcher (ADR 0014 *Adopt*, ADR 0012 *Membership*): whether a plain link's destination already is what a
// campaign would compose for some source/medium (and optional content/term), ignoring UTM pair order and encoding.

import { campaignUtmKey } from "./fold.ts";
import { type CampaignUtmParts, composeCampaignLink, composeUtm, parseUtm } from "./utm.ts";

export type AdoptCampaign = CampaignUtmParts;

export const ADOPT_MISMATCH_REASONS = [
  "base_url_mismatch",
  "utm_campaign_mismatch",
  "utm_id_mismatch",
  "utm_missing",
  "utm_value_untrimmed",
  "duplicate_utm_key",
  "utm_combination_taken",
] as const;
export type AdoptMismatchReason = (typeof ADOPT_MISMATCH_REASONS)[number];

/** The human-readable reason, for the `409 adopt_mismatch` message and the admin surface. */
export const ADOPT_MISMATCH_MESSAGES: Record<AdoptMismatchReason, string> = {
  base_url_mismatch: "Outside its UTM parameters, the destination is not the campaign's base URL.",
  utm_campaign_mismatch: "The destination's utm_campaign is not the campaign's UTM campaign.",
  utm_id_mismatch: "The destination's utm_id is not the campaign's utm_id.",
  utm_missing: "The destination needs a utm_source and a utm_medium.",
  utm_value_untrimmed:
    "A UTM value of the destination starts or ends with whitespace, which a campaign link's values never do.",
  duplicate_utm_key: "The destination repeats a UTM parameter or carries one in another case (like UTM_Source).",
  utm_combination_taken: "Another link of the campaign has the same source, medium, content and term (ignoring case).",
};

export type AdoptMatch =
  | {
      ok: true;
      /** The canonical form (ADR 0014): what the campaign composes for these values. */
      destination: string;
      utm: { source: string; medium: string; content: string | null; term: string | null };
      /** `campaignUtmKey` of `utm`. */
      utmKey: string;
    }
  | { ok: false; reason: AdoptMismatchReason };

/**
 * Matches `destination` against the campaign. `takenUtmKeys` holds the `campaignUtmKey` of every current member, so
 * a combination the campaign already holds is refused. Reasons are checked in a fixed order, the first one wins.
 */
export function matchAdopt(
  destination: string,
  campaign: AdoptCampaign,
  takenUtmKeys: { has(key: string): boolean },
): AdoptMatch {
  const { values, warnings } = parseUtm(destination);
  const refuse = (reason: AdoptMismatchReason): AdoptMatch => ({ ok: false, reason });
  if (warnings.some((w) => w.code === "duplicate_key" || w.code === "case_variant_key")) {
    return refuse("duplicate_utm_key");
  }
  if (composeUtm(destination, {}) !== composeUtm(campaign.baseUrl, {})) return refuse("base_url_mismatch");
  if (values.utm_campaign !== campaign.utmCampaign) return refuse("utm_campaign_mismatch");
  if (values.utm_id !== (campaign.utmId ?? "")) return refuse("utm_id_mismatch");
  if (values.utm_source.trim() === "" || values.utm_medium.trim() === "") return refuse("utm_missing");
  // Campaign link values are trimmed (ADR 0012); trimming here would change where a visitor lands (ADR 0014).
  const own = [values.utm_source, values.utm_medium, values.utm_content, values.utm_term];
  if (own.some((value) => value !== value.trim())) return refuse("utm_value_untrimmed");
  const source = values.utm_source;
  const medium = values.utm_medium;
  const content = values.utm_content === "" ? null : values.utm_content;
  const term = values.utm_term === "" ? null : values.utm_term;
  const utm = { source, medium, content, term };
  const utmKey = campaignUtmKey(utm);
  if (takenUtmKeys.has(utmKey)) return refuse("utm_combination_taken");
  return {
    ok: true,
    destination: composeCampaignLink(campaign, utm),
    utm,
    utmKey,
  };
}
