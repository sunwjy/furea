---
status: accepted
date: 2026-09-24
---

# UTM composition touches only the UTM pairs: everything else in a destination is kept byte for byte

The **UTM builder** and the campaign rewrite (ADR 0012) share one pair of pure functions in `packages/shared`: *parse* reads the UTM parameters out of a destination, *compose* writes them into one. Compose never re-serialises the URL: every byte outside the six recognised `utm_*` pairs is kept as entered, and the UTM pairs are removed and re-appended in one fixed order and one fixed encoding. The same inputs therefore always give the same destination string, in the browser and in the Worker.

Decided in [Decide: UTM builder composition rules](https://github.com/sunwjy/furea/issues/29), building on ADR 0002 (destination rules), ADR 0009 (public API) and ADR 0012 (campaigns).

## Recognised parameters

- Exactly six keys, **lowercase only**: `utm_id`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`. Analytics tools only read lowercase keys, so `UTM_Source` is not a UTM parameter to furea: it is kept as ordinary query, and the builder warns that the destination site will likely ignore it.

## Parse

- The destination must first pass ADR 0002 validation (WHATWG `URL` is used to validate, never to rebuild the string).
- The query (between `?` and `#`) is split on `&`; each pair on its first `=`.
- Values are decoded form-style: `+` and `%20` both read as a space. A malformed percent sequence (`%zz`) leaves the value shown raw, with a warning.
- A key present more than once shows its **first** value, with a warning; composing collapses it to one.
- An empty value (`utm_term=`) reads as an empty field.

## Compose

1. Take the destination (or, for a campaign link, the campaign's base URL) and remove every pair whose key is one of the six recognised keys. All other pairs keep their bytes and their order; the path, host and `#fragment` are untouched.
2. Trim every value; drop empty ones. Case is preserved (ADR 0012).
3. Append the remaining UTM pairs **after** the existing query and **before** the `#fragment`, in the order `utm_id, utm_source, utm_medium, utm_campaign, utm_term, utm_content` (the order of Google's Campaign URL Builder).
4. Encode each value with `encodeURIComponent` (a space becomes `%20`, never `+`).
5. Separators: `?` if the query is empty, `&` otherwise, never doubled when the query already ends in `?` or `&`; no `?` at all when no pairs remain.

Example: base URL `https://ex.com/p?ref=a#top`, source `news letter`, medium `email`, campaign `spring` →
`https://ex.com/p?ref=a&utm_source=news%20letter&utm_medium=email&utm_campaign=spring#top`.

- The result must still pass ADR 0002 (at most 2048 characters). A campaign edit whose rewrite would push **any** member link over the limit is refused as a whole (the ADR 0012 D1 batch never starts) and names the offending links.
- A destination produced by compose is the **canonical form** of its UTM parameters.

## Admin form

- **Plain links**: the builder is a collapsed "UTM parameters" section, opened automatically when the destination contains a lowercase `utm_*` key. No field is required; when any field is filled but source, medium or campaign is empty, the form warns that most analytics tools need all three.
- **Two-way sync**: typing or pasting a destination re-parses it into the fields; editing a field re-composes the destination. Nothing is re-composed until a field is touched, so a pasted destination is saved byte for byte.
- **Campaign links**: the section is always open; the campaign's fields and the destination are read-only; source and medium are required (ADR 0012).
- **No suggestion service**: previously used values come only from the browser's own form autocomplete. Each field carries a stable `name` (the parameter name) so that autocomplete works across links. There is no API for existing UTM values.

## API boundary

- The plain-link API (ADR 0009) keeps taking a `destination` string only; the builder composes in the browser and sends the string. Scripts build their own URLs.
- Structured UTM values are accepted only by the campaign-link API, where the Worker composes with the same shared functions.

## Adopt (amends ADR 0012)

- A plain link matches a campaign when its non-UTM part (everything compose would keep, byte for byte, including pair order and fragment) equals the campaign's base URL, and its decoded UTM values equal the campaign's shared values plus some source/medium (and optional content/term) unique in the campaign. A destination with a duplicate UTM key or a case-variant `UTM_*` key never matches.
- On adopt the destination is rewritten to the canonical form (one D1 write and the usual KV write-through, ADR 0004). The visitor lands on the same page with the same parameter values; only order and encoding of the UTM pairs may change. ADR 0012's "adopting never rewrites a destination" becomes "adopting never changes where a visitor lands". Screening (ADR 0013) still does not run: the host is unchanged.

## Considered options

1. **Keep non-UTM bytes, re-append UTM pairs in a fixed order** (chosen).
2. Parse and re-serialise with `URL` / `URLSearchParams`. Rejected: it lowercases hosts, punycodes IDNs, rewrites path escapes and turns spaces into `+`, so passing through the builder would silently change parts of a URL the operator never touched.
3. Rewrite UTM pairs in place where they already were. Rejected: order would depend on the input, so a campaign rewrite would not be deterministic.
4. Normalising `UTM_Source` to `utm_source`. Rejected: the builder would be guessing at the operator's query.
5. A value-suggestion endpoint scanning stored destinations (or a table of used values). Rejected: extra API surface for a nudge the browser's autocomplete already gives; case-insensitive uniqueness inside a campaign (ADR 0012) remains the hard guard.
6. Byte-exact match for adopt. Rejected: a URL made by another tool with a different parameter order would be refused although it is the same link.
7. Structured `utm` input on the plain-link API. Rejected: it widens the ADR 0009 link resource for something a script does in one line.
