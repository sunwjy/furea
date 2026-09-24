---
status: accepted
date: 2026-09-20
---

# Installer: one declarative, idempotent `deploy`; migrations first and expand-only; no local instance state

furea v1's CLI has **one command that installs and upgrades**: `npx furea deploy` (bare `npx furea` is an alias). It resolves every resource **by instance name** on Cloudflare, creates what is missing, applies pending D1 migrations **before** uploading the Worker, then re-declares bindings, Cron Trigger and hostname on every run. The only local state is the credentials file; re-running the same command is the recovery procedure for every failure.

Decided in [Decide: installer UX flow and upgrade behaviour](https://github.com/sunwjy/furea/issues/10).

## Command surface

| Command | Purpose |
|---|---|
| `deploy` (default) | Install or upgrade an instance. First run asks for the hostname choice and prints the operator password once; later runs ask nothing. |
| `status` | Report the deployed version, hostname, resource ids, the number of sync-pending links and any drift (missing binding, Cron Trigger or domain, observability settings). Non-zero exit when something is wrong. |
| `logs` | Stream live Worker events through Cloudflare's tail API (`--errors`, `--json`); headers and IP-derived fields are never printed (ADR 0011). |
| `login` / `logout` | Add or remove a deploy token in the local credentials file. |
| `domain set <hostname>` / `domain unset` | Attach or detach a Workers Custom Domain after install. |
| `analytics-token` | Create or replace the read-only analytics token stored as the `ANALYTICS_TOKEN` Worker secret. |
| `reset-password` | Write a fresh operator-password hash straight into D1 (ADR 0003). |
| `access enable` / `access disable` | Switch Cloudflare Access mode (ADR 0003). |
| `destroy` | Delete the instance. |

Every prompt has a flag or environment-variable equivalent (`--account`, `--hostname`, `--workers-dev`, `--workers-subdomain`, `CLOUDFLARE_API_TOKEN`, `FUREA_ANALYTICS_TOKEN`). When stdin is not a TTY nothing is asked: a missing required value names the flag and fails.

## Instance name and local state

- Every command takes `--name <instance name>` (default `furea`). The Worker script, the D1 database and the KV namespace all carry exactly that name, so several instances (`furea`, `furea-staging`) can coexist in one account. Names follow the workers.dev rules: at most 63 characters, alphanumerics and dashes, no leading or trailing dash.
- The CLI keeps **no record of the instance** locally. `~/.config/furea/credentials.json` (mode 0600) maps account id to deploy token; `login` adds an entry, `--account` picks one, a single entry is picked automatically. D1 uuid, KV id, hostname and version are read back from Cloudflare by name on every run, so a second machine or CI needs only the token, and a lost config directory loses nothing.
- The deployed version lives in a `plain_text` binding `FUREA_VERSION` on the script. Rejected: a `settings` row in D1, because a run that migrated but failed to upload would leave the two out of step; the binding is only ever written together with the code it describes.

## Deploy token

The pre-filled token template grants **Workers Scripts Edit, Workers KV Storage Edit, D1 Edit, Zone Read and DNS Edit** (all zones). Zone and DNS permissions are included up front so the own-domain path, which is the primary path, never sends the operator back to the dashboard for a second token. The analytics token (`Account Analytics Read`) stays a separate credential (ADR 0005) and is never placed in the deploy token.

## `deploy` step order

1. Load the token, verify it, resolve the account.
2. Find or create the D1 database and KV namespace by instance name. Fetch the current script, if any, and read `FUREA_VERSION`.
3. **Version gate**: if the deployed version is newer than the package, stop unless `--allow-downgrade` is given.
4. **Apply pending D1 migrations** (wrangler-compatible `d1_migrations` table, one `/query` request per file so DDL and bookkeeping commit together).
5. Upload the admin SPA assets (wrangler-compatible hashes; re-open the session on JWT expiry).
6. `PUT` the script with the full declarative binding set (`DB`, `KV`, `ASSETS`, `CLICKS`, the two `ratelimit` limiters, `FUREA_VERSION`) and `keep_bindings: ["secret_text"]` so `ANALYTICS_TOKEN` survives without being resent. The same metadata always carries the explicit `observability` object of ADR 0011.
7. Register the Cron Trigger `*/5 * * * *`.
8. Hostname: on first install ask **own domain or workers.dev**; afterwards reuse whatever is attached. Own domain: find the zone by trimming labels of the hostname, then `PUT /workers/domains`; when attached, the workers.dev route is **disabled**. workers.dev: if the account has no subdomain, ask for one (`--workers-subdomain`) rather than inventing it, since the name is account-wide.
9. First install only: generate the operator password, store its hash in D1, print it once.
10. Offer to set the analytics token now (opens the read-only template URL) or skip; `analytics-token` does the same later.

Each step prints one line of `create` / `reuse` / `skip`, so a re-run shows what it reused.

## Migrations are applied before the code and must be expand-only

Because step 4 runs before step 6, the **previous Worker version keeps serving on the new schema** until the upload lands, and a failed migration leaves the old code untouched. The rule this imposes on contributors: every migration must be compatible with the previous release's Worker. Adding tables, columns with defaults and indexes is fine; dropping or renaming a column takes two releases (stop using it, then drop it). Rejected: uploading first, which would run new code on an old schema and push the compatibility burden into runtime checks.

## Failure recovery

There is no rollback and no `--dry-run`. Every step looks resources up by name and re-declares configuration, so **re-running `deploy` resumes wherever the last run stopped**: created resources are reused, applied migrations are skipped, an expired asset session is reopened, Cron and domain are re-asserted. `status` is the pre-flight check.

Custom-domain problems (zone not in the account, hostname already used by a DNS record or another Worker) **stop the run** with the cause; nothing is overridden. The CLI then offers, once and only interactively, to open the instance on workers.dev for now, so the operator can fix DNS and run `domain set` later.

## Worker knows its origin from the request

No `PUBLIC_ORIGIN` binding. The Worker derives its public origin from the `Host` header, which both Workers Custom Domains and workers.dev guarantee, so `domain set` and `domain unset` never re-upload the script.

## `destroy`

Deletes the custom domain, the Worker, the KV namespace and the D1 database. The operator must type the instance name to confirm; `--keep-database` leaves the D1 database in place. The local token is untouched (`logout` removes it).

## Considered options

1. **Single idempotent `deploy`, name-resolved resources, no local instance state** (chosen).
2. Separate `init` and `deploy` commands. Rejected: two commands for one declarative outcome, and "re-run to upgrade" is the promise the destination makes.
3. Local instance file holding resource ids. Rejected: a second source of truth that drifts and does not travel to CI.
4. Automatic fallback to workers.dev on domain conflicts. Rejected: silently changing the public hostname of a shortener is worse than stopping.

## Consequences

- The package that ships the CLI must also carry the migrations directory and the built assets; how they are laid out is decided in *Decide: monorepo package boundaries and how the Worker bundle ships inside the npm package*.
- Migration authors follow the expand-only rule; a test that applies the new migrations to the previous release's schema and boots the previous Worker against it would enforce it.
- The Cloudflare Rate Limiting binding is verified to upload and work on a Workers Free account ([#17](https://github.com/sunwjy/furea/issues/17)); `deploy` therefore declares the two `ratelimit` bindings of ADR 0003 unconditionally and treats a rejected binding as a hard error (a malformed binding or an API change, not a plan limit).
