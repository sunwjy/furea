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
A link the operator has switched off without deleting it. Visitors get the same response as for an unknown slug; the link keeps its slug, destination and click history. In the public API this is the link's `enabled` field set to false.
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

**Instance overview**:
The instance-wide view of clicks: totals for today, the last 7 days and the last 30 days, and the links with the most clicks in a chosen range. Like every click breakdown it is a last-90-days estimate.
_Avoid_: Dashboard, summary, overview stats

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
The one fixed answer a visitor receives for any path that resolves to no link: a slug that does not exist, a disabled link, or a malformed path. It is never recorded anywhere and never counts as a click. See ADR 0008 for its form.
_Avoid_: 404 page, not found, error page

**Worker log**:
A structured record the Worker writes about something that went wrong or needs the operator's attention (an unhandled error, a link becoming sync pending, a repair pass). Kept by Cloudflare for a few days; it never describes a successful redirect and never holds anything about the visitor.
_Avoid_: Request log, access log, invocation log, trace

**UTM parameters**:
The standard `utm_*` query parameters (source, medium, campaign, content, term) that tell the destination site's own analytics where a visitor came from. furea keeps them only as part of a link's destination; they are never stored or counted separately.
_Avoid_: Tracking parameters, UTM tags, UTM fields

**UTM builder**:
The helper in the admin surface's link form that composes UTM parameters into a destination and reads them back out of one. It changes nothing about how a link is stored or redirected.
_Avoid_: UTM generator, URL builder, UTM tool

**Campaign**:
A named group of links that all send visitors to the same base URL and share one UTM campaign value, differing only in their other UTM parameters (typically source and medium). A link belongs to at most one campaign. The campaign is where its links' clicks are compared and combined.
_Avoid_: Group, folder, tag, collection, UTM campaign (for the group itself)

**Base URL**:
The destination a campaign's links share before their UTM parameters are added: the "main link" of the campaign.
_Avoid_: Main link, landing URL, root URL, long URL

**UTM campaign**:
The value of the `utm_campaign` parameter. Every link in a campaign carries the campaign's one UTM campaign value; outside a campaign it is just part of a destination.
_Avoid_: Campaign (for the parameter value), campaign name

**Root destination**:
An optional URL the operator sets so that visitors of the instance's bare hostname are redirected there. It follows the same rules as a link's destination, but it is not a link: a redirect to it is never a click. Without it, the root answers with the unknown-slug response.
_Avoid_: Home URL, fallback URL, default redirect, landing page

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

**Settings**:
The handful of instance-wide values an operator can change from the admin surface or the public API: the root destination and Access mode. Everything the installer provisions (domain, analytics token, version) is not a setting, only visible alongside them.
_Avoid_: Config, preferences, options

**Access mode**:
The instance setting under which Cloudflare Access, not the operator password, decides who is the operator. Turning it on hides the password login; API keys keep working.
_Avoid_: SSO mode, Zero Trust mode, enterprise mode

**Installer**:
The command-line tool (`npx furea`) an operator runs on their own machine to create, upgrade, inspect or remove an instance. It talks to Cloudflare directly; nothing of it runs inside the instance.
_Avoid_: CLI (when the instance's own API is meant), wrangler, deployer

**Deploy**:
One run of the installer that brings an instance up to the installer's own version: the same action installs a new instance and upgrades an existing one. Re-running it is always safe.
_Avoid_: Install, upgrade, publish, migrate

**Instance name**:
The name an operator gives an instance (default `furea`) that identifies every Cloudflare resource belonging to it. Several instances with different names can share one Cloudflare account.
_Avoid_: Project name, worker name, app name

**Deploy token**:
The Cloudflare API token the installer uses to create and change an instance's resources. It lives only on the operator's machine or in CI and is never placed inside the instance. Distinct from the analytics token.
_Avoid_: API token, Cloudflare token, credentials

**Local credentials**:
The one file on the operator's machine that holds deploy tokens, one per Cloudflare account. It is the installer's only local state; everything about an instance is read back from Cloudflare.
_Avoid_: Config file, project config, state file

**Live tail**:
The installer's view of what the instance is doing right now, streamed while the operator watches and stored nowhere. It shows each request's outcome and path, never who sent it.
_Avoid_: Logs (for stored Worker logs), tail worker, log stream

**Update check**:
The installer's comparison of the instance's deployed version with its own version and with the newest release, ending in one hint for the operator. It never blocks anything and the instance itself never takes part in it.
_Avoid_: Version check (for the deploy version gate), auto-update, update notifier

**Package**:
The one thing published to npm under the name `furea`: the installer together with everything an instance needs (the Worker bundle, the admin assets and the migrations) at one version. There is nothing else to install.
_Avoid_: CLI package, distribution, release artifact

**Worker bundle**:
The single built script file the installer uploads as the Worker. It is built from source at release time; an operator only ever sees the bundle, and can read it in the Cloudflare dashboard.
_Avoid_: Build, script, artifact

**Worker manifest**:
The small file built alongside the Worker bundle that tells the installer what the bundle expects from its deployment: compatibility settings and the names of its bindings. It is the only agreement between installer and Worker.
_Avoid_: Config, metadata, wrangler.toml

**Admin assets**:
The built files of the admin surface that the installer uploads as static assets so they are served under `/admin/` without touching the Worker.
_Avoid_: Frontend build, static files, SPA bundle

**Migration**:
One numbered SQL file that moves an instance's database schema forward by one step. Migrations are applied in order, each exactly once, before the Worker that needs them is uploaded, and every migration must leave the previous release's Worker working.
_Avoid_: Schema change, DB update, patch

**Release**:
One published version of the package, cut by merging the release PR that changesets prepares. A release is the only thing that moves what bare `npx furea` installs.
_Avoid_: Deploy, publish, build, version bump

**Release PR**:
The pull request changesets opens on `main` that turns pending changesets into the next version number and changelog entry; merging it is the maintainer's act of cutting a release.
_Avoid_: Version Packages PR, bump PR

**Changeset**:
The note a contributor adds to a pull request stating how the change affects the next release (patch or minor) and, when a migration is added, naming its file.
_Avoid_: Release note, changelog entry

**Snapshot**:
A throwaway version of the package published from any branch so a build can be tried on a real instance before it becomes a release. It is never promoted and never what `npx furea` resolves by default.
_Avoid_: Pre-release, beta, canary, nightly

**Test tier**:
One of the five named groups of checks (Static, Unit, E2E, Compat, Integration) that decide whether a change may merge or ship. Which tiers run where is stated in `docs/testing.md`.
_Avoid_: Test suite, test level, stage

**Compat check**:
The check that applies a change's new migrations to the previous release's schema and drives the previous release's Worker over it, proving the expand-only rule for that change.
_Avoid_: Migration test, backward-compat test, expand-only test

**CI instance**:
A throwaway instance the integration tier installs, upgrades and destroys on the CI account for one CI run; named `furea-ci-<sha>`, never an operator's instance.
_Avoid_: Test instance, staging, scratch instance

**CI account**:
The Cloudflare account, separate from any operator's, that the integration tier deploys CI instances into.
_Avoid_: Test account, staging account
