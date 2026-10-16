# furea

A self-hosted URL shortener that installs into your own Cloudflare account with one command.

furea runs as a single Cloudflare Worker with one D1 database, one KV namespace and, where the account allows it, Workers Analytics Engine. It is single-tenant: one instance, one operator, your domain. At a small company's scale it fits inside the Cloudflare Workers Free plan.

- **Short links** on your own domain (or a `workers.dev` hostname to try it out), with generated or custom slugs, each answered with a `302` from the redirect cache.
- **An admin surface** at `/admin/` on the same hostname: create, edit, disable and delete links, search them, and see exact lifetime totals and estimated 90-day click breakdowns (countries, referrer hosts, device classes).
- **A UTM builder** in the link form that composes UTM parameters into a destination without touching anything else in it.
- **Campaigns**: up to 50 links that share one base URL and one UTM campaign and differ by source and medium. Create them in bulk, edit the campaign once to rewrite them all, and compare the channels side by side.
- **A public API** under `/api/v1` with `read` or `write` API keys, described by `GET /api/v1/openapi.json`.
- **No visitor tracking**: nothing derived from a visitor's IP address is stored anywhere.

## Install

You need a Cloudflare account (the Free plan is enough) and Node.js 20 or newer.

```sh
npx furea
```

The installer:

1. Opens a pre-filled Cloudflare token form for a **deploy token** (Workers Scripts Edit, Workers KV Storage Edit, D1 Edit, Zone Read, DNS Edit) and asks you to paste it. The token is stored only in `~/.config/furea/credentials.json` (mode 0600), never inside the instance.
2. Creates the D1 database and KV namespace, applies the database migrations, uploads the admin surface and the Worker, and registers a Cron Trigger that repairs the redirect cache every five minutes.
3. Asks where the instance should live: **your own domain** or a **`workers.dev` hostname** (see below).
4. Prints the **operator password once**. Store it in your password manager; the instance is locked from the moment it exists.
5. Offers to set the read-only **analytics token** that turns on click breakdowns. You can skip this and run `npx furea analytics-token` later.

Then open `https://<your hostname>/admin/` and log in.

Every step prints `create`, `reuse` or `skip`. If a run fails half-way (a network error, an expired upload session, a typo), fix the cause and run the same command again: it resumes where it stopped. There is no rollback and nothing to clean up by hand.

### Own domain or workers.dev

- **Own domain** (recommended): give a hostname such as `s.example.com` whose zone is in the same Cloudflare account. furea attaches it as a Workers Custom Domain (no DNS editing) and then turns the `workers.dev` route off, so your links have exactly one public hostname. If the zone is not in the account or the hostname is already used by a DNS record or another Worker, the run stops and tells you why; furea never overrides anything. Interactively, it then offers once to put the instance on `workers.dev` for now, so you can fix DNS and run `npx furea domain set <hostname>` later.
- **workers.dev**: the instance is served at `<name>.<your subdomain>.workers.dev`. If the account has no `workers.dev` subdomain yet, the installer asks you to choose one (it is account-wide, so furea never invents it). Good for trying furea out. Cloudflare Access mode is not available here.

You can move between the two at any time with `npx furea domain set <hostname>` and `npx furea domain unset`, without redeploying.

### Several instances

Every command takes `--name <instance>` (default `furea`). The Worker, the D1 database and the KV namespace all carry that name, so `furea` and `furea-staging` can live side by side in one account. Names follow the `workers.dev` rules: up to 63 letters, digits and dashes, not starting or ending with a dash.

### CI and non-interactive use

Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead of logging in. For CI, prefer an **account-owned token** (`npx furea login --account-token` opens that form; only a Super Administrator can create one), so the pipeline survives staff turnover. Every prompt has a flag or environment-variable equivalent (`--account`, `--hostname`, `--workers-dev`, `--workers-subdomain`, `FUREA_ANALYTICS_TOKEN`); when stdin is not a terminal nothing is asked, and a missing value fails with the name of the flag to pass.

## Upgrade

```sh
npx furea@latest deploy
```

Use `@latest`: a plain `npx furea` may run an older installer from the npx cache. Upgrading applies any new database migrations first, while the running Worker keeps serving, and then uploads the new Worker. It asks nothing and keeps your hostname, analytics token, links and settings.

`deploy` refuses to install an older version over a newer one unless you pass `--allow-downgrade`. `npx furea status` and the end of `deploy` tell you when a newer release exists. While furea is at `0.x`, a minor version bump (`0.1` to `0.2`) means something you should read about first, and `status` links the release notes in that case: see [GitHub Releases](https://github.com/sunwjy/furea/releases).

## Commands

All commands accept `--name <instance>` and `--account <account id>` (needed only when several deploy tokens are stored).

| Command | What it does |
|---|---|
| `deploy` (default) | Install or upgrade an instance. Flags: `--hostname <hostname>`, `--workers-dev`, `--workers-subdomain <name>`, `--allow-downgrade`, `--no-update-check`. |
| `status` | Show the deployed version, hostname, resource ids, the number of links waiting for the redirect cache (*sync pending*) and any drift from what `deploy` declares (a missing binding, Cron Trigger or domain, changed observability settings), plus whether a newer release exists. Exits non-zero when something is wrong; a newer release is never "wrong", and neither is a missing Analytics Engine binding, which is shown as information. `--no-update-check` skips the registry lookup. |
| `logs` | Stream what the Worker is doing right now: time, outcome, method, path without its query string, and the Worker's own log lines and exceptions. Request headers, IP addresses and Cloudflare location data are dropped before printing. `--errors` shows only failures, `--json` prints one JSON object per line. Nothing is stored; past logs are in the Cloudflare dashboard (Workers & Pages → your instance → Observability). |
| `login` / `logout` | Add or remove a deploy token in the local credentials file, one per account. `login --account-token` opens the account-owned token form instead of the user-token form. |
| `domain set <hostname>` / `domain unset` | Attach your own domain, or go back to `workers.dev`. |
| `analytics-token` | Create or replace the read-only analytics token (`Account Analytics Read`), stored as a Worker secret that survives every `deploy`. `--account-token` opens the account-owned token form. |
| `reset-password` | Set a new operator password directly in the database, log out every session and print the new password once. Access to your Cloudflare account is the proof of ownership. |
| `access enable` / `access disable` | Turn Cloudflare Access mode on (with your Access team domain and application AUD) or off, even when you are locked out of the admin surface. Refused on a `workers.dev`-only instance. |
| `destroy` | Delete the instance: custom domain, Worker, KV namespace and D1 database. You confirm by typing the instance name. `--keep-database` keeps the D1 database and its data. Your local deploy token stays (`logout` removes it). |

`npx furea --help` lists the commands; `--version` prints the installer's version.

### The update check

`status` and the end of `deploy` fetch the `latest` version of `furea` from the npm registry: one unauthenticated request with a 2-second timeout, using `npm_config_registry` when it is set. When it fails, nothing is printed. `--no-update-check` or `FUREA_NO_UPDATE_CHECK=1` turns the lookup off. The instance itself never contacts the npm registry or any other service you did not configure (apart from the destination screening resolver, see [Abuse and operator responsibility](docs/abuse.md)).

## Click analytics

Every click (a request answered with a redirect, including bots and link-preview fetchers) is counted twice:

- an **exact lifetime total** per link in D1, which never expires and needs nothing beyond the install;
- a data point in **Workers Analytics Engine** with exactly four facts: the slug, the visitor's country, the referrer host (never the full referring URL, `direct` when there was none) and a device class (`desktop`, `mobile`, `tablet`, `bot`, `unknown`). The admin surface turns these into **breakdowns** for the last 24 hours, 7, 30 or 90 days, labelled as estimates.

Breakdowns need two things: the account must accept the Analytics Engine binding, and the instance needs the analytics token. Without either, the instance keeps counting clicks and shows lifetime totals, and the admin surface says which one is missing. Some accounts, Workers Free among them, refuse the binding; `deploy` then installs without it and prints a link to [the Analytics Engine workaround](docs/analytics-engine.md).

## What furea promises

- **Nothing IP-derived is stored.** No IP address, no hash of one, no unique-visitor count, anywhere: not in D1, not in Analytics Engine, not in the logs furea configures. `deploy` turns Workers Logs' per-request invocation logs off (they would keep request headers, including the client IP) and reverts that setting if you change it in the dashboard. The Worker's own log lines carry only failure events with slugs and counts, never a destination, a header or an IP address. The login rate limiter keys on a salted IP hash that exists only inside Cloudflare's rate-limiting counters and is never written to storage.
- **Redirects are always `302` with `Cache-Control: no-store`**, so edits and disables take effect for returning visitors and every click reaches the Worker. Edits, disables and deletes are visible worldwide within a few minutes, usually at once.
- **Unknown slugs are invisible.** A slug that does not exist, a disabled link, a malformed or multi-segment path, and reserved paths all get the same small, unbranded, uncached `404 Not found`. These responses are never recorded: they do not appear in click totals, in breakdowns or in Analytics Engine at all. **Response timing is not promised identical**: a disabled link is answered from the redirect cache and an unknown slug from the database, so a careful observer may tell them apart by latency.
- **The root path** (`https://<hostname>/`) answers the same `404` unless you set a root destination in **Settings**; then it redirects there. A root redirect is not a click.
- **`robots.txt`** disallows `/admin/` and `/api/` and leaves slugs crawlable, so link previews work.
- **The public API only grows within `/api/v1`.** Fields and endpoints are added, never removed or changed in meaning, so your scripts survive upgrades. There are no CORS headers: API keys are for scripts and servers, not for web pages.
- **No lock-in to the installer.** The migration history (the `d1_migrations` table) and the asset hashes are compatible with Cloudflare's own CLI, **wrangler or `cf`**, so you can manage an instance deployed by furea with either of them later. furea itself never runs or requires wrangler or `cf`, and never borrows their login.

## Free-plan limits

furea is designed to stay inside the Cloudflare Workers Free plan for one operator at a small company's scale. The limits that matter:

| Limit (Free plan) | What spends it |
|---|---|
| 100,000 Worker requests per day | Every redirect, admin page load and API call. This is the practical ceiling on clicks per day. |
| 1,000 KV writes per day | Only your own actions: creating, editing, disabling and deleting links, campaign rewrites (one write per link), cache backfills and repairs. Clicks never write to KV, and unknown slugs are never cached. Past the budget, changes are still saved and shown as *sync pending* until the next day's repair. |
| 100,000 D1 rows written per day | One per click (the lifetime total) plus your edits. |
| 5,000,000 D1 rows read per day | Cache misses and the admin surface. |
| 100,000 Analytics Engine data points per day, 10,000 queries per day | One data point per click; queries only when you look at breakdowns. |
| 10,000 characters per Analytics Engine SQL query | A campaign's breakdown queries name every link in it; with the KV write budget, this is why a campaign holds at most 50 links. |

Analytics Engine keeps data for 90 days, which is why breakdowns cover the last 90 days only; lifetime totals in D1 are kept forever. Login rate limiting is a brake (per Cloudflare location, not exact), backed by a fixed delay on every failed attempt.

## More

- [Abuse and operator responsibility](docs/abuse.md): what destination screening does and does not catch, and what to do when a key leaks.
- [Analytics Engine is not enabled on this account](docs/analytics-engine.md): the dashboard workaround.
- Design decisions: [`docs/adr/`](docs/adr/); glossary: [`CONTEXT.md`](CONTEXT.md); planning: [the v1 spec](https://github.com/sunwjy/furea/issues/40).

## Development

Requires Node 24 and pnpm (version pinned in `package.json`).

```sh
pnpm install
pnpm test          # Static (oxlint, tsc, builds) + Unit, as CI runs them
pnpm --filter @furea/worker dev   # wrangler dev; apply migrations first with
                                  # pnpm --filter @furea/worker exec wrangler d1 migrations apply DB --local
```

Workspace packages (ADR 0007): `apps/worker` (the Worker), `apps/admin` (the admin surface), `packages/shared` (slug rules and other code shared by all three), `packages/cli` (the installer, published to npm as `furea`). Test tiers are described in `docs/testing.md`; releasing in `docs/release.md`.

## Licence

MIT
