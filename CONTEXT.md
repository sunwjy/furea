# furea

A single-tenant, self-hosted URL shortener that a person or small company installs into their own Cloudflare account with one command. This file is the glossary; specs and decisions live elsewhere (`docs/adr/`).

## Language

**Instance**:
One installed copy of furea living in one Cloudflare account, owned by one operator.
_Avoid_: Tenant, deployment, site

**Operator**:
The person who installs and administers an instance.
_Avoid_: Admin user, owner, tenant

**Worker**:
The single Cloudflare Worker script that an instance runs; it serves redirects, the public API and the admin surface.
_Avoid_: Backend, server, redirect worker / admin worker (there is only one)

**Redirect path**:
The part of the Worker that resolves a slug to its destination and answers with a redirect. The only latency-critical path.
_Avoid_: Hot path, resolver

**Admin surface**:
The web UI an operator uses to manage links, served under the reserved `/admin` path of the instance.
_Avoid_: Dashboard, console, admin app

**Public API**:
The HTTP API under the reserved `/api` path, used by the admin surface and by operators' own scripts.
_Avoid_: Backend API, internal API

**Link**:
A slug paired with a destination, owned by the instance. The slug is the link's identity and never changes; the destination and title can be edited.
_Avoid_: Short link, short URL, redirect, entry

**Slug**:
The single path segment after the instance hostname that identifies a link (`/Ab3xYz`). Slugs are case-sensitive: `abc` and `ABC` are two different links. See ADR 0002 for the allowed syntax.
_Avoid_: Short code, key, alias, path

**Generated slug**:
A slug the instance picks at random when a link is created without one. Six characters from the 56-character alphabet (base62 minus `0 O o 1 I l`).
_Avoid_: Random slug, auto slug

**Custom slug**:
A slug the operator chooses when creating a link. Same character rules as a generated slug plus `-` and `_`; never normalised.
_Avoid_: Vanity slug, alias

**Destination**:
The absolute `http` or `https` URL a link redirects to. Must not point back at the instance itself.
_Avoid_: Target, long URL, original URL, redirect URL

**Title**:
An optional one-line label the operator gives a link so it can be recognised in the admin surface. Never shown to visitors.
_Avoid_: Name, description, note, label

**Disabled link**:
A link the operator has switched off without deleting it. Visitors get the same response as for an unknown slug; the link keeps its slug, destination and click history.
_Avoid_: Paused, archived, inactive, soft-deleted

**Click**:
One request to the redirect path that was answered with a redirect to a link's destination. Bots and link-preview crawlers count as clicks; telling them apart is an analytics concern.
_Avoid_: Hit, visit, view, request

**Reserved path**:
A top-level path that can never be a slug because the instance uses it for itself: `admin`, `api`, `favicon.ico`, `robots.txt`, and anything starting with `_` or `.`. Reservation is checked case-insensitively, so `Admin` and `API` are reserved too.
_Avoid_: Blocked slug, system route
