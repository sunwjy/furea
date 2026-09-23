---
status: accepted
date: 2026-09-23
---

# Unknown slugs get a fixed uncached 404, the root path redirects to an operator-set destination, and neither is ever a click

furea v1 answers every path that resolves to no link, including a **disabled link**, with one fixed **404** response: a tiny unbranded HTML body and `Cache-Control: no-store`. The instance root `/` is not a slug; it answers with the same 404 unless the operator has set a **root destination**, in which case it answers with a `302` exactly like a link. Neither response is a click. `HEAD` mirrors `GET` everywhere; any other method on a slug path is a `405`.

Decided in [Decide: responses for unknown slugs and the root path](https://github.com/sunwjy/furea/issues/14), building on ADR 0002 (slug rules) and ADR 0004 (redirect cache).

## Unknown-slug response

- **Status 404**, `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`. The body is a fixed English document: a `<title>` and the single line `Not found`, no CSS, no images, no instance name, no link to `/admin`. It gives a slug scanner nothing to learn and leaves no 404 in a browser cache that could shadow a slug created a minute later.
- The same bytes are returned for: a slug that matches no link, a **disabled link**, any path that is not a single segment (`/abc/`, `/abc/def`; no trailing-slash normalisation, per ADR 0002), any path that fails the slug syntax, and the reserved paths starting with `_` or `.` (for example `/.well-known/...`).
- Syntax and reserved-path checks run **before** any cache or database lookup, so malformed paths cost nothing.
- **Timing is not part of the promise**: a disabled link is answered from the redirect cache and an unknown slug from D1 after a cache miss, so a careful observer can tell them apart by latency. Hiding this would need negative caching or artificial delay, both rejected in ADR 0004.
- Nothing is recorded: no Analytics Engine data point, no counter update, no cache write.

## Root path

- `/` never resolves to a link. With no root destination set, it returns the unknown-slug response.
- The operator may set a **root destination** from the admin surface or the public API (the settings resource; its exact shape belongs to the public-API decision). It obeys the same rules as a link's destination: absolute `http` or `https`, at most 2048 characters, never the instance itself. The installer has no command for it because it is instance data, not a Cloudflare resource.
- When set, `/` answers **302** with `Cache-Control: no-store`, byte-identical in shape to a link redirect. It is **not a click**: no data point, no counter.
- Storage mirrors links: the value lives in D1 (settings) and is written through to the redirect cache under a reserved key (a key beginning with `_`, which can never be a slug), so the redirect path reads only the cache and the same sync-pending repair loop from ADR 0004 covers it.

## Methods

- `HEAD` returns the status and headers of the corresponding `GET` with no body. A `HEAD` that would redirect a link **is a click**: the click definition is "answered with a redirect" and ADR 0005 already counts bots, so a per-method exception would only blur it.
- Any other method on a slug path or on `/` returns **405** with `Allow: GET, HEAD` and `Cache-Control: no-store`, before any lookup. `/api/*` and `/admin/*` are governed by their own decisions.

## Reserved files

- `robots.txt` is served by the Worker as a fixed document: `User-agent: *`, `Disallow: /admin/`, `Disallow: /api/`. Slugs stay crawlable so link-preview fetchers and search engines can follow them; the admin surface is never indexed.
- `favicon.ico` is shipped in the admin assets at the **assets root** (`dist/assets/favicon.ico`), so Cloudflare serves it before the Worker runs (ADR 0001 assets-first routing) and it costs no Worker request. ADR 0007's tarball layout gains that one root file.

## Considered options

1. **Fixed 404 + optional root destination** (chosen).
2. Operator-configured fallback URL for unknown slugs. Rejected for v1: one more setting and cache key for a rare need, and it turns every typo into a redirect to a page the visitor did not ask for.
3. Branded or customisable 404 page. Rejected: byte-identical responses for unknown and disabled slugs are easiest to guarantee with a constant body, and the redirect path should not read settings for a 404.
4. Root redirects to `/admin/`. Rejected: it advertises the admin surface to every visitor.
5. Root as a minimal landing page. Rejected: a short-link host has nothing to say there, and operators who do want a page want their own.
6. Trailing-slash normalisation. Rejected: ADR 0002 forbids normalising the incoming path.

## Consequences

- D1 gains a settings storage for the root destination (schema owned by the API decision), and the redirect cache gains one reserved key.
- The admin surface's settings page (still in the fog) gets a root-destination field.
- The spec must state that unknown-slug responses are not observable in any analytics, and that response timing is not guaranteed identical.
