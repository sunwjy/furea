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

/** `POST /links`. With `slug` it is a custom slug, without it a generated one. */
export const CreateLinkRequest = z.strictObject({
  destination: Destination,
  slug: CustomSlug.optional(),
  title: Title.optional(),
});
export type CreateLinkRequest = z.input<typeof CreateLinkRequest>;
export type CreateLinkBody = z.output<typeof CreateLinkRequest>;

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
