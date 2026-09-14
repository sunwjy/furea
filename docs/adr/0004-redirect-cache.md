---
status: accepted
date: 2026-09-14
---

# Redirect cache: KV mirrors D1 write-through, self-heals with a dirty bit, and every redirect is an uncached 302

furea v1 keeps **every link mirrored in KV** (the *redirect cache*) and treats **D1 as the source of truth**. Link writes go to D1 first and then to KV in the same request; a KV write that still fails after retries does **not** fail the operator's request but marks the link *sync pending* in D1, and the instance repairs it on its own. The redirect path answers from KV alone, falls through to D1 only on a cache miss, never caches unknown slugs, and always replies with an uncacheable **302**.

Decided in [Decide: D1/KV consistency and cache semantics](https://github.com/sunwjy/furea/issues/8).

## Write path

- **Create / edit / disable / enable**: `INSERT`/`UPDATE` in D1, then `put` the link's cache entry into KV. **Delete**: `DELETE` in D1, then `delete` the KV entry. Disabling rewrites the entry with `disabled: true` rather than deleting it, so a disabled link is answered from KV without touching D1.
- Every write handler always writes KV regardless of whether the D1 row changed, so retrying any operation repairs the cache.
- **KV failure after the D1 commit**: retry the KV write a few times (three attempts) inside the request. If it still fails, the API **responds with success** and sets the link's `cache_synced = 0` in D1. A single "sync one link to KV" function is reused by (a) the write path, (b) the tail of every write API request, which resyncs a handful of pending links, and (c) a **Cron Trigger** running every five minutes as the safety net. The link resource exposes `cacheSynced: false` while pending and the admin surface shows a small badge; it is a state, not an error.
- Cache entries have **no expiration TTL**. A TTL long enough not to burn the free plan's 1,000 KV writes/day would leave stale entries alive for days, which is a worse promise than the dirty-bit repair.

## Read path (redirect)

- Look the slug up in KV with the default `cacheTtl` (60 s). On a hit, **no D1 query is made for the lookup**. Whether a click also writes to D1 (the exact `click_count`) is settled in the analytics data model, not here.
- On a miss, query D1. If the link exists, answer and backfill KV via `ctx.waitUntil`. If it does not exist, answer the unknown-slug response and **write nothing to KV**: negative caching would let slug scanners spend the free plan's daily KV write budget. Unknown-slug lookups cost one D1 read each, well inside 5M rows/day.
- A disabled link's cache entry answers exactly like an unknown slug.

## Cache entry shape

A small JSON document, not a bare destination string: `{"to": "<destination>", "disabled": false}`. The flag is what lets disabled links be answered from KV; the object form leaves room for per-link options later without changing the value format.

## What the spec promises

Edits, disables and deletes are usually visible immediately and are visible **worldwide within a few minutes**: KV propagation (up to about 60 s) plus the edge read cache (`cacheTtl` 60 s) bound the normal case, and the five-minute cron bounds the KV-outage case. No stronger guarantee is made.

## Redirect response

- **Status 302 for every link**, never 301/308. A permanent redirect is cached by browsers, so an edited or disabled link would keep sending returning visitors to the old destination forever and those clicks would never reach the Worker to be counted. Per-link status codes are out of v1.
- `Cache-Control: no-store` on every redirect response, so no browser or intermediate cache short-circuits a click. Click counting and the staleness promise both rely on every click reaching the Worker.

## Considered options

1. **Write-through plus lazy backfill, dirty-bit repair** (chosen).
2. Lazy-only population (D1 writes only; redirect path fills KV on miss). Rejected: every edit still needs a KV delete, so it saves nothing, and the first click after each edit pays a D1 round trip.
3. Fail the operator's request when the KV write fails. Rejected: the link is already saved, so the error misleads, and retrying a create collides with its own slug.
4. Expiration TTL on cache entries as the safety net. Rejected as the sole mechanism (staleness window of days); unnecessary once the dirty bit exists.
5. Negative caching of unknown slugs. Rejected: unbounded KV writes driven by strangers.

## Consequences

- D1 `links` gains a `cache_synced` column, and the installer must register a **Cron Trigger** (`*/5 * * * *`) alongside the script upload (one more API call on the deploy path).
- The free-plan KV write budget (1,000/day) is consumed only by operator actions, backfills and repairs, all bounded by the number of links. Clicks never write to KV.
- The redirect module needs only the KV binding, the D1 binding for misses, and the cache-entry format; it stays independent of the admin/API module as ADR 0001 requires.
