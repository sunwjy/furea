# Testing furea

What each package tests, with what, and where it runs. Decided in [Decide: testing strategy per package](https://github.com/sunwjy/furea/issues/19), building on ADR 0007 (package layout, `core/db/` as the D1 test surface), ADR 0006 (expand-only migrations) and ADR 0010 / `docs/release.md` (`ci.yml` and `release.yml`).

## Tiers

Five tiers, named so that CI jobs, package scripts and this page use the same words.

| Tier | What it proves | Tooling | Runs on PR | Runs on `main` push | Runs in the release job |
|---|---|---|---|---|---|
| **Static** | The code builds and conforms: oxlint, `tsc`, esbuild/Vite builds, tarball check, migration/changeset consistency (`docs/release.md`). | turbo, `scripts/check-tarball.mjs` | yes | yes | yes |
| **Unit** | Each package behaves, in isolation, against real platform primitives where it has them. | vitest (`shared`, `cli`), `@cloudflare/vitest-pool-workers` (`worker`) | yes | yes | yes |
| **E2E** | The admin surface and the Worker work together in a browser. | Playwright (chromium) against `wrangler dev` | yes | yes | yes |
| **Compat** | New migrations leave the previous release's Worker working (ADR 0006). | `scripts/check-expand-only.mjs`, miniflare, `npm pack furea@latest` | only when `apps/worker/migrations/` changed | only when `apps/worker/migrations/` changed | yes |
| **Integration** | The installer really installs and upgrades an instance on a real Cloudflare account. | `packages/cli` against the CI account | no (secrets are not available to fork PRs) | yes, failure does not block anything | yes, **hard gate before publish** |

- **The PR gate** is Static + Unit + E2E, plus Compat when a migration file is in the diff. A green PR is one that a maintainer can merge without running anything locally.
- There is no nightly schedule. Every push to `main` runs Integration; that is frequent enough to notice Cloudflare-side changes and does not spend the CI account's free-plan daily limits on quiet days.
- No coverage threshold. Coverage is reported locally with `vitest --coverage` when someone wants it, never enforced.

### Local commands

| Command | Tiers |
|---|---|
| `pnpm test` (root, via turbo) | Static checks that live in packages plus Unit |
| `pnpm test:e2e` | E2E (starts `wrangler dev` itself) |
| `pnpm test:compat` | Compat (needs network for `npm pack`) |
| `pnpm test:integration` | Integration; refuses to start unless `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set |

In turbo, `test` does not depend on `^build` except in `packages/cli`, whose tests exercise the tarball assembly and therefore need `apps/worker` and `apps/admin` built first.

### File layout

- Unit tests are **colocated**: `foo.ts` next to `foo.test.ts`. The published tarball only carries `dist`, `bin` and `migrations` (ADR 0007), so test files never ship.
- Playwright lives in `apps/admin/e2e/`.
- CLI fixtures live in `packages/cli/test/fixtures/`.
- Compat and Integration scripts live in the repository root `scripts/`, sharing one request set in `scripts/lib/smoke.mjs`.

## `packages/shared` — plain vitest

Node environment, no bindings. `shared` is TypeScript source with Web Crypto only (ADR 0007), so its tests are the cheapest in the repo.

- **Slug rules and reserved paths** (ADR 0002): table-driven tests over accept/reject lists for generated slugs, custom slugs and the reserved-path matcher (case-insensitive, `_*` and `.*` prefixes).
- **API schemas** (ADR 0009): each zod schema has a parse test with one valid and a few invalid documents, asserting the per-field `details` that the error envelope needs.
- **Password hashing** (ADR 0003): a **golden-vector test**. A fixed password and a fixed salt produce a hash string that is written into the test verbatim; `verify` must accept it and `hash` must reproduce its exact format (algorithm tag, iteration count, salt, digest). Because the same function is used by the Worker (login) and by the CLI (`reset-password`, the installer's first password), sharing parameters is guaranteed by construction; the golden vector guards the **stored format** across releases, so an operator's password stays verifiable after an upgrade. A change that breaks this test is a `minor` changeset and needs a re-hash-on-login plan.

## `apps/worker` — everything in the Workers pool

All Worker tests run under `@cloudflare/vitest-pool-workers` with the dev-only `wrangler.jsonc`, so they see a real local D1, KV, the assets binding and the `ratelimit` limiters (miniflare). **Mocking D1 or KV is not allowed**; a test that wants a particular database state creates it through `core/db/` or with SQL.

- **Setup** applies the real migration files with the pool's `applyD1Migrations` helper, so every migration is executed on every test run.
- **`core/db/`** functions are tested directly against the `DB` binding: one file per table module, covering the row types and each query (including the `cache_synced` repair queries of ADR 0004).
- **Redirect path** through `SELF.fetch`: cache hit; cache miss with D1 fallthrough and `waitUntil` backfill (asserted by reading KV after the response); disabled link; unknown slug; reserved and malformed paths; root with and without a root destination; `HEAD` and `405` (ADR 0004, 0008). The click side effect is asserted on `links.click_count`; the Analytics Engine binding is a local no-op.
- **Public API** through `SELF.fetch`: each endpoint of ADR 0009 with session and API-key auth, scope checks, the error envelope, cursor pagination, and the `503 analytics_unavailable` path when `ANALYTICS_TOKEN` is absent. Stats queries that need the Analytics Engine SQL API are tested with an injected `fetch` that returns canned SQL API responses.
- **Manifest ↔ `wrangler.jsonc`**: the manifest is produced by a `buildManifest()` function that the build script calls. A test calls the same function and compares its binding names, `compatibility_date` and `compatibility_flags` with the parsed `wrangler.jsonc`. The two files are kept by hand; the test is what stops them drifting (ADR 0007). Generating `wrangler.jsonc` from a TypeScript source was rejected: it would put a generation step in front of `wrangler dev` and fight hand edits.
- **OpenAPI snapshot**: `GET /openapi.json` is compared with a committed `openapi.snapshot.json`. A changed snapshot shows the API diff in review, which is how the additive-only rule of ADR 0009 is judged; removals are **not** enforced mechanically, because the false positives (description edits) would need their own rules.

## `apps/admin` — build plus one Playwright smoke

No component tests in v1: the screens were validated by the admin-UI prototype and their count is small, so React Testing Library suites would cost more upkeep than they catch. The gate for `apps/admin` is `tsc`, oxlint and the Vite build (Static), plus the **E2E smoke**.

- One serial spec file, chromium only, sharing one browser session; five flows in order: log in with the seeded operator password; create a link with a custom slug and see it in the feed; open the short URL and land on the destination (302); disable the link and get the 404; open the stats page and see the "estimates unavailable" state (no analytics token).
- `globalSetup` prepares the local instance: `wrangler d1 migrations apply --local`, then inserts the operator password row with `wrangler d1 execute --local`, the hash computed in Node with the `shared` hashing function. Then it starts `wrangler dev` and waits for the port.
- Budget: the whole spec should stay under about 30 seconds; if it grows past a handful of flows, split by screen rather than by step.

## `packages/cli` — mocked API on PRs, real account on `main` and release

### Unit: fixture-replaying `fetch`

The REST client takes `fetch` as a constructor argument; tests pass a replaying `fetch` and no network library is involved (the published CLI has zero runtime dependencies, ADR 0007).

- Fixtures are **recorded, not hand-written**: `FUREA_RECORD_FIXTURES=1 pnpm test:integration` runs the real flow and writes ordered request/response pairs to `packages/cli/test/fixtures/<scenario>.json`, replacing the account id, token, resource ids and hostnames with fixed placeholders. Re-record when the Cloudflare API changes shape; the diff shows what changed.
- Scenarios, at minimum: **fresh install** on an empty account; **upgrade** of an existing instance with one pending migration (exercises the version gate, `keep_bindings`, migration listing); **resume** after an expired asset upload session (ADR 0006 failure recovery).
- These tests cover the find-or-create logic, the `create` / `reuse` / `skip` output lines, error mapping (a rejected binding is a hard error) and the tarball assembly (which is why `cli`'s `test` depends on `build`).

### Integration: the CI instance

`scripts/integration.mjs` runs the published CLI build against a real account, using the **CI account** (a Free-plan Cloudflare account owned by the maintainer, or the same account with a reserved name prefix) whose deploy token is a secret of the GitHub environment `cloudflare-ci`.

1. Sweep: delete any `furea-ci-*` instance older than one day (a warning, never a failure).
2. If a `furea@latest` exists on npm, deploy it to `--name furea-ci-<short-sha>` first and create one link through the API. This is the **upgrade path** the job exists to prove.
3. Deploy the candidate (the freshly packed tarball) on top.
4. Assert, through `scripts/lib/smoke.mjs` against the `workers.dev` URL: `status` reports the candidate version; login with the printed password; create a link via the API; the redirect answers 302; the link created under `latest` still redirects; the stats endpoint answers `503 analytics_unavailable` (no analytics token is provisioned in CI).
5. Run `deploy` a second time and assert every step prints `reuse` or `skip` (idempotency, ADR 0006).
6. `destroy` under `if: always()`.

On `main` pushes the job reports only. In `release.yml` it runs **before `changeset publish`** and a failure stops the release: a version that cannot install on a real account must never become `latest`.

### The Rate Limiting smoke script

`scripts/rate-limit-smoke.mjs` (ticket [#17](https://github.com/sunwjy/furea/issues/17)) stays a **manual tool**. The integration job already uploads a Worker with both `ratelimit` bindings, so a plan-level rejection would surface there; the limiter's own behaviour (per-location, permissive) is Cloudflare's to guarantee and would only make an assertion flaky. Run the script by hand when a plan change or an API change is suspected.

## Compat: the expand-only check

`scripts/check-expand-only.mjs` mechanises the rule of ADR 0006.

1. `npm pack furea@latest` into a temp dir. If nothing is published yet, print `skip: no previous release` and exit 0.
2. **New migrations** are the files in `apps/worker/migrations/` whose names are not in the tarball's `migrations/`.
3. Start miniflare (library) with the tarball's `dist/worker/index.js`, its `dist/assets`, a local D1, a KV namespace and the `ratelimits` option, bindings named from the tarball's `manifest.json`.
4. Apply the tarball's migrations, then the new migrations, in order, to that D1. Seed an operator password.
5. Run the shared smoke set (`scripts/lib/smoke.mjs`: login, create link, redirect, list) against the **previous** Worker on the **new** schema.
6. On failure, print the failing migration file, a link to ADR 0006 and the reminder that column drops and renames take two releases.

It runs in `ci.yml` only when the PR changes `apps/worker/migrations/` (path filter), and always in the release job.

## Considered and rejected

- A second Node vitest runner inside `apps/worker` for pure functions: the pure code lives in `shared`, and two runners in one package cost more config than they save.
- Generating `wrangler.jsonc` from the manifest source: see above.
- Component tests for the admin surface in v1: cost vs the screen count.
- Nightly schedule: `main` pushes already run Integration; a nightly would mostly spend the CI account's free-plan limits.
- Enforcing "no removals" on the OpenAPI snapshot: review of the diff is enough in 0.x.
- A coverage threshold: it would be gamed or ignored at this size.
- Promoting the rate-limit smoke to a permanent test: flaky by nature of the limiter.
