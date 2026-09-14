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

**Click facts**:
The only four things remembered about a click: the slug, the visitor's country, the referrer host and the device class. Nothing derived from the visitor's IP address is ever among them.
_Avoid_: Click event, analytics payload, tracking data

**Device class**:
A coarse label for what sent a click: `desktop`, `mobile`, `tablet`, `bot` or `unknown`. `bot` marks obvious crawlers and link-preview fetchers; it is a label, not a filter.
_Avoid_: User agent, platform, bot flag

**Referrer host**:
The hostname of the page a click came from, or `direct` when there was none. Never the full referring URL.
_Avoid_: Referrer, source, origin

**Lifetime total**:
The exact number of clicks a link has received since it was created. It is never estimated and never expires.
_Avoid_: Click count, hits, total clicks

**Click breakdown**:
Any per-period view of clicks (time series, top countries, top referrer hosts, device classes). Breakdowns cover the last 90 days and are estimates.
_Avoid_: Stats, analytics, report, insights

**Analytics token**:
The read-only credential an instance needs to compute click breakdowns. Without it the instance still counts clicks and shows lifetime totals, but no breakdowns.
_Avoid_: API token, Cloudflare token, secret

**Redirect cache**:
The copy of every link that the redirect path consults first. It mirrors the links and may lag a short time behind an edit; it is never the source of truth.
_Avoid_: KV, hot cache, edge cache, lookup table

**Cache entry**:
The redirect cache's record for one link: enough to answer a redirect or to answer a disabled link like an unknown slug, and nothing more.
_Avoid_: Cached link, KV value

**Sync pending**:
The state of a link whose latest change is saved but has not yet reached the redirect cache. The instance clears it on its own; it is a status shown to the operator, never an error.
_Avoid_: Dirty, stale, unsynced, failed

**Unknown-slug response**:
What a visitor receives for a slug that matches no link. A disabled link produces the same response. Its exact form is decided separately from the cache.
_Avoid_: 404 page, not found, error page

**Reserved path**:
A top-level path that can never be a slug because the instance uses it for itself: `admin`, `api`, `favicon.ico`, `robots.txt`, and anything starting with `_` or `.`. Reservation is checked case-insensitively, so `Admin` and `API` are reserved too.
_Avoid_: Blocked slug, system route

**Operator password**:
The single credential that opens the admin surface. The installer creates it and prints it once; the operator can change it from the admin surface or reset it from the CLI. There is no username.
_Avoid_: Admin password, login, account

**Session**:
A browser's proof that the operator has logged in, carried in a cookie and valid for a fixed period. An operator may hold several at once; changing the operator password ends all of them.
_Avoid_: Token, login token, auth cookie

**API key**:
A long secret an operator creates so a script can call the public API without a session. Shown once, identified afterwards by its name and a short prefix, revocable at any time.
_Avoid_: Token, access token, secret, credential

**Scope**:
What an API key may do: `read` (list links and read analytics) or `write` (everything). There are no finer scopes.
_Avoid_: Permission, role, grant

**Access mode**:
The instance setting under which Cloudflare Access, not the operator password, decides who is the operator. Turning it on hides the password login; API keys keep working.
_Avoid_: SSO mode, Zero Trust mode, enterprise mode
