---
status: accepted
date: 2026-09-14
---

# Slugs are case-sensitive, immutable, and the identity of a link

A link in furea v1 is identified by its **slug**, which is **case-sensitive** and **cannot be renamed** after creation. Generated slugs are six characters drawn from base62 minus the six look-alike characters `0 O o 1 I l` (56 symbols, about 3×10^10 combinations); custom slugs use `[A-Za-z0-9]` plus `-` and `_`, up to 64 characters, one path segment, never normalised. To change a slug, the operator creates a new link.

Decided in [Decide: domain model and slug rules](https://github.com/sunwjy/furea/issues/6).

## Considered options

1. **Case-sensitive slugs, slug is the identity** (chosen).
2. Case-insensitive slugs, lower-cased on write and read, with a smaller lowercase alphabet.
3. An opaque link id with a mutable slug (optionally keeping old slugs alive as redirects).

## Why

- Case-sensitivity keeps the full base62 space available and matches what most public shorteners do; the look-alike characters are removed from the *generated* alphabet so the remaining case distinctions (`aB3xYz`) are the unambiguous ones. Custom slugs are the operator's deliberate choice, so no characters are removed there.
- Making the slug the identity means the KV cache key, the D1 primary key, the Analytics Engine index and the public API path are all the same string. An opaque id plus a mutable slug would need old-slug redirects, cache invalidation on rename and a second lookup table, none of which v1 needs.

## Consequences

- Reversing case-sensitivity later would require a migration that resolves collisions between links differing only by case, so this decision is effectively permanent.
- **Reserved paths are matched case-insensitively** even though slugs are case-sensitive: `Admin` and `API` cannot be created as slugs, so a visitor who mistypes the case of a reserved path never lands on a link.
- Deleting a link is a hard delete and frees the slug for reuse. Clicks already recorded in Analytics Engine stay keyed by that slug, so per-link statistics must be bounded by the link's creation time.
- The redirect path does no normalisation: the incoming path segment is looked up byte-for-byte.
