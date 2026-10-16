// The campaign resource of the public API (ADR 0009, *Campaigns*; ADR 0012 campaigns; ADR 0014 UTM composition).

import { z } from "zod";
import { hasUtmKey } from "../utm.ts";
import { CustomSlug, Destination, Link, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, ScreeningOverride, Title } from "./links.ts";

/** At most this many links per campaign (ADR 0012): `409 campaign_link_limit` beyond it. */
export const CAMPAIGN_LINK_LIMIT = 50;
export const CAMPAIGN_NAME_MAX_LENGTH = 100;

export const CampaignName = z
  .string()
  .trim()
  .min(1, { message: "Must not be empty." })
  .max(CAMPAIGN_NAME_MAX_LENGTH, { message: `Must be at most ${CAMPAIGN_NAME_MAX_LENGTH} characters.` })
  .describe(
    `Trimmed, 1 to ${CAMPAIGN_NAME_MAX_LENGTH} characters, unique across the instance ignoring case ` +
      "(campaign_name_taken).",
  );

/**
 * A campaign's base URL: the destination rules (the Worker adds `destination_self`) and no recognised `utm_*` key,
 * since the campaign owns the UTM part (`base_url_has_utm`). Other query parameters and a fragment are allowed.
 */
export const BaseUrl = Destination.refine((url) => !hasUtmKey(url), {
  message: "Must not carry utm_* parameters: the campaign adds them.",
  params: { code: "base_url_has_utm" },
}).describe(
  "Where every link of the campaign lands before its UTM parameters are added: a destination without utm_* " +
    "parameters (base_url_has_utm).",
);

/** A UTM value as entered: trimmed, case kept (ADR 0012). */
const UtmValue = z.string().trim();
const RequiredUtmValue = UtmValue.min(1, { message: "Required." });
/** Optional: empty, whitespace-only and `null` all mean "none". */
const OptionalUtmValue = UtmValue.transform((value) => (value === "" ? null : value)).nullable();

/** `POST /campaigns`. */
export const CreateCampaignRequest = z.strictObject({
  name: CampaignName,
  baseUrl: BaseUrl,
  utmCampaign: UtmValue.transform((value) => (value === "" ? undefined : value))
    .optional()
    .describe("The utm_campaign every link carries; omitted or empty, it is the trimmed name, case kept."),
  utmId: OptionalUtmValue.optional().describe("The optional utm_id every link carries; empty or null for none."),
  screening: ScreeningOverride,
});
export type CreateCampaignRequest = z.input<typeof CreateCampaignRequest>;
export type CreateCampaignBody = z.output<typeof CreateCampaignRequest>;

const ReadOnly = (what: string) =>
  z
    .unknown()
    .refine(() => false, { message: `${what} is computed from the links and read-only.`, params: { code: "read_only_field" } })
    .describe(`Never accepted: ${what} is computed from the links (read_only_field).`);

/** `PATCH /campaigns/:id`, a merge-patch. */
export const UpdateCampaignRequest = z.strictObject({
  name: CampaignName.optional(),
  linkCount: ReadOnly("linkCount").optional(),
  enabledLinkCount: ReadOnly("enabledLinkCount").optional(),
  clickCount: ReadOnly("clickCount").optional(),
  syncPendingLinkCount: ReadOnly("syncPendingLinkCount").optional(),
});
type ReadOnlyField = "linkCount" | "enabledLinkCount" | "clickCount" | "syncPendingLinkCount";
export type UpdateCampaignRequest = Omit<z.input<typeof UpdateCampaignRequest>, ReadOnlyField>;
export type UpdateCampaignBody = Omit<z.output<typeof UpdateCampaignRequest>, ReadOnlyField>;

/** A campaign link's own UTM parameters as sent: source and medium required, content and term optional. */
export const CampaignLinkUtm = z.strictObject({
  source: RequiredUtmValue.describe("utm_source, trimmed, case kept."),
  medium: RequiredUtmValue.describe("utm_medium, trimmed, case kept."),
  content: OptionalUtmValue.optional().describe("utm_content; empty or null for none."),
  term: OptionalUtmValue.optional().describe("utm_term; empty or null for none."),
});
export type CampaignLinkUtm = z.output<typeof CampaignLinkUtm>;

export const BulkCreateCampaignLinksItem = z.strictObject({
  utm: CampaignLinkUtm,
  slug: CustomSlug.optional(),
  title: Title.optional(),
});

/**
 * `POST /campaigns/:id/links`: all-or-nothing. Each item's destination is composed from the campaign and its `utm`
 * (ADR 0014); the (source, medium, content, term) combination is unique in the campaign ignoring case.
 */
export const BulkCreateCampaignLinksRequest = z.strictObject({
  items: z.array(BulkCreateCampaignLinksItem).min(1, { message: "Send at least one item." }),
  screening: ScreeningOverride,
});
export type BulkCreateCampaignLinksRequest = z.input<typeof BulkCreateCampaignLinksRequest>;
export type BulkCreateCampaignLinksBody = z.output<typeof BulkCreateCampaignLinksRequest>;

/** `GET /campaigns` query string, like `GET /links`'. */
export const ListCampaignsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
  cursor: z.string().optional(),
  q: z.string().optional().describe("Plain substring of the name or the UTM campaign."),
});
export type ListCampaignsQuery = z.output<typeof ListCampaignsQuery>;

export const Campaign = z.object({
  id: z.string(),
  name: z.string(),
  utmCampaign: z.string(),
  utmId: z.string().nullable(),
  baseUrl: z.string(),
  /** Computed from D1 on every read, never stored. */
  linkCount: z.number().int(),
  enabledLinkCount: z.number().int(),
  /** The sum of the members' exact lifetime totals. */
  clickCount: z.number().int(),
  syncPendingLinkCount: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Campaign = z.infer<typeof Campaign>;

/** The answer to `PATCH /campaigns/:id`: how many member destinations the edit rewrote. */
export const UpdatedCampaign = Campaign.extend({ rewrittenLinkCount: z.number().int() });
export type UpdatedCampaign = z.infer<typeof UpdatedCampaign>;

export const CampaignPage = z.object({
  items: z.array(Campaign),
  nextCursor: z.string().nullable(),
});
export type CampaignPage = z.infer<typeof CampaignPage>;

/** `GET /campaigns/:id/links` (oldest first, unpaginated) and the answer to `POST /campaigns/:id/links`. */
export const CampaignLinks = z.object({ items: z.array(Link) });
export type CampaignLinks = z.infer<typeof CampaignLinks>;
