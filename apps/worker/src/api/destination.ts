// A destination field as the Worker checks it: the `shared` rules plus "never this instance" (`destination_self`),
// which needs the request's host. Used by links and the root destination alike (ADR 0008).

import { BaseUrl, Destination, DESTINATION_MAX_LENGTH, hasUtmKey, type ErrorDetail } from "@furea/shared";

/** `s.example.com.` is the same host as `s.example.com`; `URL` already lower-cases it. */
const hostOf = (url: URL) => url.hostname.replace(/\.$/, "");

export function destinationFor(url: URL) {
  const ownHost = hostOf(url);
  return Destination.refine((destination) => hostOf(new URL(destination)) !== ownHost, {
    message: "Must not point at this instance.",
    params: { code: "destination_self" },
  });
}

/** A campaign's base URL as the Worker checks it: a destination as above, without `utm_*` (`base_url_has_utm`). */
export function baseUrlFor(url: URL) {
  return destinationFor(url)
    .refine((baseUrl) => !hasUtmKey(baseUrl), {
      message: "Must not carry utm_* parameters: the campaign adds them.",
      params: { code: "base_url_has_utm" },
    })
    .describe(BaseUrl.description ?? "");
}

/**
 * `rewrite_too_long` (ADR 0009) for a destination the Worker composed (ADR 0014) that is longer than 2048 characters,
 * naming the link when it already exists; `null` when it fits. The base URL already passed `baseUrlFor` and compose
 * percent-encodes every value, so length is the only way a composed destination can fail.
 */
export function composedTooLong(composed: string, field: string, slug?: string): ErrorDetail | null {
  if (composed.length <= DESTINATION_MAX_LENGTH) return null;
  return {
    field,
    code: "rewrite_too_long",
    ...(slug === undefined ? {} : { slug }),
    message: `The composed destination${slug === undefined ? "" : ` of /${slug}`} would be longer than ${DESTINATION_MAX_LENGTH} characters.`,
  };
}
