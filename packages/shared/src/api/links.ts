// The link resource of the public API (ADR 0009, *Link* and *Listing*; ADR 0002 slug rules).

import { z } from "zod";
import { isCustomSlug, isReservedPath } from "../slug.ts";

export const DESTINATION_MAX_LENGTH = 2048;
export const TITLE_MAX_LENGTH = 200;
export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 200;

/** Printable ASCII without the space: anything else could not be sent back as a `Location` header byte for byte. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

function isDestination(value: string): boolean {
  if (value.length > DESTINATION_MAX_LENGTH || !PRINTABLE_ASCII.test(value)) return false;
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
}

/**
 * An absolute `http`/`https` URL of at most 2048 characters. Whether it points back at the instance depends on the
 * request's host, so the Worker checks that (`destination_self`).
 */
export const Destination = z.string().refine(isDestination, {
  message: `Must be an absolute http or https URL of at most ${DESTINATION_MAX_LENGTH} characters, percent-encoded.`,
  params: { code: "destination_invalid" },
  abort: true,
}).describe(
  `An absolute http or https URL, at most ${DESTINATION_MAX_LENGTH} characters of printable ASCII (percent-encoded), ` +
    "not pointing at this instance.",
);

export const CustomSlug = z
  .string()
  .refine(isCustomSlug, {
    message: "Use 1 to 64 letters, digits, - or _.",
    params: { code: "slug_invalid" },
    abort: true,
  })
  .refine((slug) => !isReservedPath(slug), {
    message: "This path is reserved for the instance.",
    params: { code: "slug_reserved" },
  })
  .describe(
    "A custom slug: 1 to 64 of A-Z a-z 0-9 - _, case-sensitive, never normalised; not a reserved path " +
      "(admin, api, favicon.ico, robots.txt, or a leading _ or ., in any case). Omit it for a generated slug.",
  );

/** Trimmed, at most 200 characters; empty is stored as `null`. */
export const Title = z
  .string()
  .trim()
  .refine((title) => title.length <= TITLE_MAX_LENGTH, {
    message: `Must be at most ${TITLE_MAX_LENGTH} characters.`,
    params: { code: "title_too_long" },
  })
  .transform((title) => (title === "" ? null : title))
  .nullable()
  .describe(`Trimmed, at most ${TITLE_MAX_LENGTH} characters; empty or null means no title.`);

/**
 * Destination screening override (ADR 0013): `"skip"` saves a destination that screening flagged. Accepted from a
 * session only; an API key sending it is refused with 403. Never stored.
 */
export const ScreeningOverride = z
  .literal("skip")
  .optional()
  .describe('"skip" saves a destination screening flagged (destination_flagged); from a session only, never stored.');

/** `POST /links`. With `slug` it is a custom slug, without it a generated one. */
export const CreateLinkRequest = z.strictObject({
  destination: Destination,
  slug: CustomSlug.optional(),
  title: Title.optional(),
  screening: ScreeningOverride,
});
export type CreateLinkRequest = z.input<typeof CreateLinkRequest>;
export type CreateLinkBody = z.output<typeof CreateLinkRequest>;

/** Present in a `PATCH` body at all, with any value, it is refused: a link's slug never changes (ADR 0002). */
const ImmutableSlug = z
  .unknown()
  .refine(() => false, { message: "A link's slug cannot be changed.", params: { code: "slug_immutable" } })
  .describe("Never accepted: a link's slug cannot be changed (slug_immutable).");

/**
 * Membership (ADR 0009 *Membership*): `null` detaches, `{id}` adopts a plain link whose destination already matches
 * the campaign (`409 adopt_mismatch`). A link of another campaign is detached first (`409 campaign_member`).
 */
export const LinkMembership = z
  .strictObject({ id: z.string().min(1) })
  .nullable()
  .describe(
    "null detaches the link from its campaign, keeping its destination. {id} adopts a plain link into the campaign " +
      "when its destination already matches it (ignoring UTM order and encoding), rewriting it to the canonical form.",
  );

/**
 * `PATCH /links/:slug`, a merge-patch (ADR 0009): only the fields present change, `"title": null` clears the title,
 * and an empty `{}` still rewrites the cache entry.
 */
export const UpdateLinkRequest = z.strictObject({
  destination: Destination.optional(),
  title: Title.optional(),
  enabled: z.boolean().optional().describe("false disables the link, true enables it again."),
  campaign: LinkMembership.optional(),
  slug: ImmutableSlug.optional(),
  screening: ScreeningOverride,
});
export type UpdateLinkRequest = Omit<z.input<typeof UpdateLinkRequest>, "slug">;
export type UpdateLinkBody = Omit<z.output<typeof UpdateLinkRequest>, "slug">;

/** `GET /links` query string. `cursor` is opaque; the Worker decodes it (`cursor_invalid`). */
export const ListLinksQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
  cursor: z.string().optional(),
  q: z.string().optional(),
});
export type ListLinksQuery = z.output<typeof ListLinksQuery>;

export const LinkCampaign = z.object({ id: z.string(), name: z.string() });

export const LinkUtm = z.object({
  source: z.string(),
  medium: z.string(),
  content: z.string().nullable(),
  term: z.string().nullable(),
});

export const Link = z.object({
  slug: z.string(),
  /** Built from the request's `Host`, so it names whichever hostname the caller used. */
  shortUrl: z.string(),
  destination: z.string(),
  title: z.string().nullable(),
  enabled: z.boolean(),
  /** The exact lifetime total. */
  clickCount: z.number().int(),
  /** `false` while the link is sync pending (ADR 0004); a state, not an error. */
  cacheSynced: z.boolean(),
  /** `null` on a plain link. */
  campaign: LinkCampaign.nullable(),
  /** The campaign link's own UTM parameters; `null` on a plain link. */
  utm: LinkUtm.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Link = z.infer<typeof Link>;

/** `GET /links`: newest first; `nextCursor` is `null` on the last page. */
export const LinkPage = z.object({
  items: z.array(Link),
  nextCursor: z.string().nullable(),
});
export type LinkPage = z.infer<typeof LinkPage>;
