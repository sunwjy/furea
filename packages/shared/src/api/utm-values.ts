// A campaign link's own UTM values as the API takes them (ADR 0012): trimmed, case kept. Shared by the campaign and
// link schemas, so it lives apart from both.

import { z } from "zod";

/** A UTM value as entered: trimmed, case kept (ADR 0012). */
export const UtmValue = z.string().trim();
export const RequiredUtmValue = UtmValue.min(1, { message: "Required." });
/** Optional: empty, whitespace-only and `null` all mean "none". */
export const OptionalUtmValue = UtmValue.transform((value) => (value === "" ? null : value)).nullable();

/**
 * `utm` on `PATCH /links/:slug`: a merge-patch of a campaign link's own values. Source and medium cannot be cleared;
 * the Worker recomposes the destination (ADR 0014).
 */
export const CampaignLinkUtmPatch = z
  .strictObject({
    source: RequiredUtmValue.optional().describe("utm_source, trimmed, case kept; never null."),
    medium: RequiredUtmValue.optional().describe("utm_medium, trimmed, case kept; never null."),
    content: OptionalUtmValue.optional().describe("utm_content; empty or null for none."),
    term: OptionalUtmValue.optional().describe("utm_term; empty or null for none."),
  })
  .describe(
    "A campaign link's own UTM values, merge-patched; the destination is recomposed. Refused on a plain link " +
      "(utm_requires_campaign).",
  );
export type CampaignLinkUtmPatch = z.output<typeof CampaignLinkUtmPatch>;
