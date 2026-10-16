// A destination field as the Worker checks it: the `shared` rules plus "never this instance" (`destination_self`),
// which needs the request's host. Used by links and the root destination alike (ADR 0008).

import { BaseUrl, Destination, hasUtmKey } from "@furea/shared";

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
