# Research: the `cf` CLI against furea's wrangler touchpoints

- Issue: [#35](https://github.com/sunwjy/furea/issues/35) (part of #1, blocks #36)
- Date: 2026-09-30
- Sources checked: the launch post ([blog.cloudflare.com/cloudflare-cf-cli-launch](https://blog.cloudflare.com/cloudflare-cf-cli-launch/), 2026-09-28), the changelog entry ([Cloudflare CLI is now in beta](https://developers.cloudflare.com/changelog/post/2026-09-28-cloudflare-cli-beta/)), the `cf` docs under [developers.cloudflare.com/cf](https://developers.cloudflare.com/cf/), the `cf` npm package (`cf@1.0.0-beta.6`, tarball unpacked and installed), [`cloudflare/cf`](https://github.com/cloudflare/cf) at [`ac05496`](https://github.com/cloudflare/cf/tree/ac05496067199275379bcf957a510dec30b82d06), and [`cloudflare/workers-sdk`](https://github.com/cloudflare/workers-sdk) at [`89061a4`](https://github.com/cloudflare/workers-sdk/tree/89061a40fb20157acf6c947034a74ece357992f0) (`@cloudflare/workers-auth`, `@cloudflare/deploy-helpers`, `@cloudflare/vitest-plugin`, wrangler 4.145.0 changelog).
- Framed against: [cloudflare-api-deploy.md](./cloudflare-api-deploy.md), [cloudflare-cli-auth.md](./cloudflare-cli-auth.md), ADR 0003, ADR 0006, ADR 0007.

Link text such as `cf/src/...` is a path under `cloudflare/cf/packages/cli/` at the commit above, and `wsdk/...` is a path under `cloudflare/workers-sdk/packages/` at the commit above.

## TL;DR

| Touchpoint | Key facts |
|---|---|
| Installer engine | `cf` is a CLI only: no documented library API. `cf deploy --prebuilt` uploads a directory in the **Build Output Specification** (`.cloudflare/output/v0/`, marked a draft "v0") without `cloudflare.config.ts`. It accepts furea's full binding set in a dry run. It does **not** apply D1 migrations as part of deploy. Install is about 219 MB (it bundles Miniflare and `workerd`). Needs Node 22+. |
| Auth fallback | `cf auth login` uses **its own** OAuth client and stores credentials separately from wrangler (`<config dir>/cloudflare/config/<profile>.json`). There is **no `cf auth token`** equivalent. `cf` honours `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, not the Global API Key. |
| Compatibility and dev tooling | `cf d1 migrations apply` is deliberately wire-compatible with wrangler's `d1_migrations` table and ordering. `cf deploy` uses wrangler's extracted deploy code, including the same blake3 asset hash. `@cloudflare/vitest-pool-workers` was renamed to `@cloudflare/vitest-plugin` 1.x, which still depends on `wrangler`. `cf dev` does not run a dev server itself. It hands off to the Vite plugin 2.0 beta or to `wrangler` ≥ 4.136.0. |
| Timeline | The open beta started on 2026-09-28. Beta versions are published under npm `latest`. No GA date or GA criteria have been published. When the beta ends, a final wrangler major points users to `cf`, and wrangler then gets 18 months of maintenance. Wrangler 4.145.0 is still being released and still documents `wrangler auth token`. |

---

## 1. Installer engine (ADR 0006: `npx furea` calls the REST API directly)

### 1.1 What `cf` is, as a package

| Fact | Source |
|---|---|
| npm package `cf`, `bin: { cf, cloudflare }`, license MIT OR Apache-2.0, `engines.node >=22`. The docs require Node 22.18 or later and say Bun is not supported. | `npm view cf`; [cf/package.json](https://github.com/cloudflare/cf/blob/ac05496067199275379bcf957a510dec30b82d06/packages/cli/package.json); [Get started](https://developers.cloudflare.com/cf/get-started/) |
| Versions: `0.0.4` on 2026-04-13 through `0.15.0` on 2026-09-25, then `1.0.0-beta.0` on 2026-09-25 through `1.0.0-beta.6` on 2026-09-30. Versions `0.0.1` to `0.0.3` are an unrelated 2013 package under the same name. The only dist-tag is `latest`, and it points to `1.0.0-beta.6`. | `npm view cf time dist-tags` |
| The cf changeset says the betas publish "under the `beta` npm dist-tag", but the registry shows only `latest`. | [.changeset/first-public-beta.md](https://github.com/cloudflare/cf/blob/ac05496067199275379bcf957a510dec30b82d06/.changeset/first-public-beta.md); `npm view cf dist-tags` |
| Install footprint: the `cf` tarball unpacks to 23.3 MB and 295 files. `npm install cf@1.0.0-beta.6` produced 219 MB of `node_modules` in 24 packages on darwin-arm64. Of that, `@cloudflare/workerd-darwin-arm64` is 128 MB and `miniflare` is 23 MB, pulled in by the runtime dependency `miniflare@5.20260926.0-alpha`. | Measured locally on 2026-09-30; `npm view cf dependencies` |
| Programmatic surface: `exports["."]` is `dist/index.mjs`, which exports `buildCli`, `main`, `runMain` and `CliExit`. Source comments describe `runMain` as "Used by integration tests". The only other subpath is `cf/config` (`defineConfig`, `bindings`, `triggers`) for authoring `cloudflare.config.ts`. **No documented programmatic API.** The README and docs describe the CLI only. | [cf/src/index.ts](https://github.com/cloudflare/cf/blob/ac05496067199275379bcf957a510dec30b82d06/packages/cli/src/index.ts); [cf/package.json](https://github.com/cloudflare/cf/blob/ac05496067199275379bcf957a510dec30b82d06/packages/cli/package.json) |
| `npx`/dependency use is documented. `npx cf <command>` runs the copy installed in the project. A global `cf` also hands off ("delegates") to a copy pinned in the project. Explicit one-shot runs (`npx cf@<version>`, `pnpm dlx`) are not handed off. | [Use cf in CI](https://developers.cloudflare.com/cf/ci/); [cf/src/lib/delegate.ts](https://github.com/cloudflare/cf/blob/ac05496067199275379bcf957a510dec30b82d06/packages/cli/src/lib/delegate.ts) |
| Telemetry is on by default and can be turned off with `CF_SEND_TELEMETRY=0` or `DO_NOT_TRACK=1`. | [Environment variables](https://developers.cloudflare.com/cf/environment-variables/) |

### 1.2 JSON output contract

- In the docs, results go to stdout as JSON, and progress and errors go to stderr. "Lists print a JSON array and return one page", and JSON is "indented, whether or not standard output is a terminal" ([Use cf with coding agents](https://developers.cloudflare.com/cf/agents/)). The launch post says JSON is "pretty printed for humans and condensed for agents". The docs page (last updated 2026-09-29) contradicts this and says output is always indented.
- Null mutation results leave stdout empty. There is no global `--json`/`--ndjson`/`--format`, and those names are reserved for the future ([cf/AGENTS.md](https://github.com/cloudflare/cf/blob/ac05496067199275379bcf957a510dec30b82d06/packages/cli/AGENTS.md) "Global Flags").
- **Stability promise: none.** "`cf` is in beta. Commands, configuration, and Build Output can change before the stable release" ([cf docs home](https://developers.cloudflare.com/cf/)). Most commands are generated from the pinned public OpenAPI schema, and their surface "changes with the pinned public OpenAPI release" ([package README](https://www.npmjs.com/package/cf)).
- `cf` project commands (`deploy`, `build`) print human progress through clack and not a JSON result. `cf previews deploy` is the one project command documented to print a JSON result ([Develop, build, and deploy](https://developers.cloudflare.com/cf/projects/)). A known bug, "versions upload no JSON output", is tracked in the repo ([test_bugs/](https://github.com/cloudflare/cf/tree/ac05496067199275379bcf957a510dec30b82d06/test_bugs)).

### 1.3 Deploying a prebuilt bundle with `cf`

`cf deploy` "builds by default and then uploads that output". `--prebuilt` reuses existing Build Output and "also skips automatic configuration" ([Develop, build, and deploy](https://developers.cloudflare.com/cf/projects/#deploy-a-prebuilt-build)). In code, `--prebuilt` calls `readBuildOutput(process.cwd())`, converts the Worker config to wrangler's config shape (`convertToWranglerConfig`) and calls `deploy()` from `@cloudflare/deploy-helpers` ([cf/src/commands/deploy/shared.ts](https://github.com/cloudflare/cf/blob/ac05496067199275379bcf957a510dec30b82d06/packages/cli/src/commands/deploy/shared.ts), [cf/src/lib/build-output.ts](https://github.com/cloudflare/cf/blob/ac05496067199275379bcf957a510dec30b82d06/packages/cli/src/lib/build-output.ts)).

**Build Output Specification layout** (from `@cloudflare/build-output-utils@0.8.2`, whose README says it is "not yet stable enough for external use"):

```
.cloudflare/output/v0/config.json                          # { buildContext: { isPreview, mode? }, accountId?, complianceRegion? }
.cloudflare/output/v0/workers/default/worker.config.json   # name, compatibilityDate, env (bindings), triggers, domains, assets, manifest
.cloudflare/output/v0/workers/default/bundle/<modules>     # manifest: { type: "complete", mainModule, modules: { file: { type: "esm" } } }
.cloudflare/output/v0/workers/default/assets/...           # static assets
```

The code comment is `BUILD_OUTPUT_VERSION = "v0"`, "Initial draft version of the Build Output Specification. Will move to `v1` when the spec stabilises."

**Hand-written Build Output with furea's binding set (tested, dry run only).** I wrote the tree above by hand with no `package.json` and no `cloudflare.config.ts`. The bindings were: D1 by name, KV with no id, ASSETS, an Analytics Engine dataset, a `rate-limit` binding, a text var, a secret, plus `domains: ["go.example.com"]`, `workersDev: false`, a `*/5 * * * *` scheduled trigger and `assets.notFoundHandling: "single-page-application"`. `cf deploy --prebuilt --dry-run` (1.0.0-beta.6, `CI=1`, no credentials) read the assets, listed every binding and exited with "Dry run complete". I did **not** run a real upload, so account-side behaviour is unverified.

**Which furea needs map to `cloudflare.config.ts` / Build Output fields** ([Wrangler to cf reference](https://developers.cloudflare.com/cf/wrangler/reference/); `@cloudflare/config@0.20.0` types):

| furea need (ADR 0006) | `cf` field | Notes |
|---|---|---|
| D1 `DB` | `bindings.d1({ name?, id? })` | `id` is "not required". |
| KV `KV` | `bindings.kv({ id? })` | No name or title field. |
| Static Assets + SPA | `bindings.assets()`, `worker.assets.notFoundHandling` | The assets directory is a build setting and is not in `cloudflare.config.ts`. |
| Analytics Engine `CLICKS` | `bindings.analyticsEngineDataset({ name })` | — |
| Rate limiting | `bindings.rateLimit({ namespace, simple: { limit, period: 10 \| 60 } })` | — |
| `FUREA_VERSION` | `bindings.text(value)` | — |
| `ANALYTICS_TOKEN` secret | `bindings.secret()` | deploy-helpers always uploads with `keepSecrets: true` ([wsdk/deploy-helpers/src/deploy/deploy.ts](https://github.com/cloudflare/workers-sdk/blob/89061a40fb20157acf6c947034a74ece357992f0/packages/deploy-helpers/src/deploy/deploy.ts)). |
| Custom domain | `worker.domains: string[]` | — |
| workers.dev on/off | `worker.workersDev` | — |
| Cron | `triggers.scheduled({ schedule })` | — |
| Observability object (ADR 0011) | `worker.observability` | — |

**Provisioning and adopting by name.** "`cf deploy` can provision missing resources for bindings that omit resource identifiers. It does not write provisioned identifiers back to `cloudflare.config.ts`" ([Develop, build, and deploy](https://developers.cloudflare.com/cf/projects/#deploy)). The provisioning code ([wsdk/deploy-helpers/src/deploy/helpers/provision-bindings.ts](https://github.com/cloudflare/workers-sdk/blob/89061a40fb20157acf6c947034a74ece357992f0/packages/deploy-helpers/src/deploy/helpers/provision-bindings.ts)) works like this:

- **D1**: a binding with `database_name` and no id is looked up by name and connected when it exists (`getDatabaseInfoFromIdOrName`). If the lookup returns error 7404 it is created. A same-named binding already on the deployed script is inherited.
- **KV**: if the deployed script already has a KV binding with the same binding name, it is inherited. Otherwise the namespace is provisioned. **There is no lookup by title**, because KV `name` is always `undefined` in the handler.
- The **D1 migrations are not part of deploy**. They are a separate command (§3.1). This matters for ADR 0006's order, which applies migrations before the upload.

**Account selection.** The order is `CLOUDFLARE_ACCOUNT_ID`, then `accountId` in `cloudflare.config.ts` or the Build Output root config, then the account saved for this project, then the only accessible account. Non-interactive runs fail when there are several accounts. The saved account lives in `node_modules/.cache/cloudflare/cloudflare-account.json` or `.cloudflare/cache/` ([Get started § Select an account](https://developers.cloudflare.com/cf/get-started/#select-an-account)).

**Resource commands take IDs, not names.** An example is `cf d1 query <DATABASE_ID>` ([cf for Wrangler users](https://developers.cloudflare.com/cf/wrangler/)). Raw script upload has no generated command: "the raw upload operations are SDK-only" ([cf/AGENTS.md](https://github.com/cloudflare/cf/blob/ac05496067199275379bcf957a510dec30b82d06/packages/cli/AGENTS.md)).

**Commands `cf` does not have yet:** live tail (`npx wrangler tail` is the documented workaround) and setting a single secret (`npx wrangler secret put`, or `--secrets-file` on deploy) ([Wrangler to cf reference § Commands not yet supported](https://developers.cloudflare.com/cf/wrangler/reference/#commands-not-yet-supported)). Both map to furea commands: `logs` (ADR 0011) and `analytics-token`.

**Warning in the docs about automatic configuration:** running `cf dev`/`build`/`deploy` without `--prebuilt` in a directory without `cloudflare.config.ts` runs "automatic configuration". In CI, or without a terminal, that step "installs packages and edits project files without asking" ([Use cf in CI](https://developers.cloudflare.com/cf/ci/)).

---

## 2. Auth fallback (research #2: furea token by default, `wrangler auth token --json` as fallback)

### 2.1 How `cf` logs in and where it stores credentials

`cf` uses the same shared auth library as wrangler, bound to a separate identity. The source says: "This is the exact same auth machinery wrangler uses (`@cloudflare/workers-auth/wrangler`), differing only in the descriptor below" ([wsdk/workers-auth/src/cf/index.ts](https://github.com/cloudflare/workers-sdk/blob/89061a40fb20157acf6c947034a74ece357992f0/packages/workers-auth/src/cf/index.ts)). `cf` pins `@cloudflare/workers-auth@0.9.4` and bundles it.

| Item | `cf` | Source |
|---|---|---|
| OAuth client id | `cbca97e7-c331-4cdd-8fd8-e25a451b98bf` (single app, no staging app), overridable via `CLOUDFLARE_CLIENT_ID` | [wsdk/workers-auth/src/cf/env.ts](https://github.com/cloudflare/workers-sdk/blob/89061a40fb20157acf6c947034a74ece357992f0/packages/workers-auth/src/cf/env.ts) |
| Redirect URI | `http://localhost:8877/oauth/callback` (wrangler uses 8976) | [wsdk/workers-auth/src/cf/constants.ts](https://github.com/cloudflare/workers-sdk/blob/89061a40fb20157acf6c947034a74ece357992f0/packages/workers-auth/src/cf/constants.ts) |
| Default flow | **Device authorization** (`useDeviceFlowByDefault: true`). `cf auth login` "prints a link and a one-time code, and opens the link". `--no-browser` prints the link without opening it, and `--no-device` switches to the localhost callback flow. | [cf/index.ts](https://github.com/cloudflare/workers-sdk/blob/89061a40fb20157acf6c947034a74ece357992f0/packages/workers-auth/src/cf/index.ts); [Get started § Sign in](https://developers.cloudflare.com/cf/get-started/#sign-in); [cf/src/commands/auth/login.ts](https://github.com/cloudflare/cf/blob/ac05496067199275379bcf957a510dec30b82d06/packages/cli/src/commands/auth/login.ts) |
| Default scopes | Every requestable scope in cf's client registration (`DefaultScopeKeys = [...CF_REQUESTABLE_SCOPES]`, several hundred), including `d1:write`, `workers_scripts:write` and `account_api_tokens:create`. `--scopes` narrows the request. | [wsdk/workers-auth/src/cf/scopes.ts](https://github.com/cloudflare/workers-sdk/blob/89061a40fb20157acf6c947034a74ece357992f0/packages/workers-auth/src/cf/scopes.ts) |
| Config directory | `xdgAppPaths("cloudflare").config()` with no leading dot and no legacy `~/.cloudflare` fallback. The docs name `~/.config/cloudflare` on Linux and `~/Library/Preferences/cloudflare` on macOS (in the `--local` state section). | [wsdk/workers-auth/src/cf/paths.ts](https://github.com/cloudflare/workers-sdk/blob/89061a40fb20157acf6c947034a74ece357992f0/packages/workers-auth/src/cf/paths.ts); [Develop, build, and deploy § Local resource data](https://developers.cloudflare.com/cf/projects/#local-resource-data) |
| Credential file | `<config dir>/config/<profile>.json` (JSON, not TOML). The default profile is `default.json`. An opt-in keyring mode writes an encrypted `.enc` sibling whose key is held under OS keyring service `"cloudflare"`. **The on-disk location is not documented** on the docs site, so this row comes from source only. | [wsdk/workers-auth/src/cf/auth-config-file.ts](https://github.com/cloudflare/workers-sdk/blob/89061a40fb20157acf6c947034a74ece357992f0/packages/workers-auth/src/cf/auth-config-file.ts); [wsdk/workers-auth/src/credential-store/file-store.ts](https://github.com/cloudflare/workers-sdk/blob/89061a40fb20157acf6c947034a74ece357992f0/packages/workers-auth/src/credential-store/file-store.ts) |
| Profiles | `cf auth create/activate/deactivate/delete/list`. A profile can be bound to a directory. | [Get started § Use named profiles](https://developers.cloudflare.com/cf/get-started/#use-named-profiles) |
| Separation from wrangler | "`cf` keeps its own credentials and does not reuse a Wrangler login." | [Get started](https://developers.cloudflare.com/cf/get-started/#sign-in); [cf for Wrangler users](https://developers.cloudflare.com/cf/wrangler/) |

### 2.2 Credential precedence and env vars

1. `CLOUDFLARE_API_TOKEN`, which can also be read from a `.env` file in the current directory.
2. The profile selected with `--profile`.
3. The profile bound to the directory.
4. The default profile.

"`cf` does not support the Global API Key" (`allowGlobalAuthKey: false`). There are no `--api-token`/`--account-id` flags. `CLOUDFLARE_ACCOUNT_ID` selects the account and overrides `accountId` in config ([Get started § Credential order](https://developers.cloudflare.com/cf/get-started/#credential-order); [Environment variables](https://developers.cloudflare.com/cf/environment-variables/); [cf/src/lib/auth.ts](https://github.com/cloudflare/cf/blob/ac05496067199275379bcf957a510dec30b82d06/packages/cli/src/lib/auth.ts)). The docs state: "In automation, both tools read `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`."

### 2.3 Can a third-party tool borrow a `cf` session?

- **No `auth token` command.** `cf auth` has exactly these subcommands: `login`, `logout`, `whoami`, `create`, `delete`, `activate`, `deactivate`, `list` ([cf/src/commands/auth/index.ts](https://github.com/cloudflare/cf/blob/ac05496067199275379bcf957a510dec30b82d06/packages/cli/src/commands/auth/index.ts)). `cf auth whoami` reports the auth source and account but not the token. `cf access token` exists, but it prints a Cloudflare **Access** application JWT through cloudflared, which is not an API credential ([.changeset/access-token.md](https://github.com/cloudflare/cf/blob/ac05496067199275379bcf957a510dec30b82d06/.changeset/access-token.md)).
- **No statement** in the docs, README or repo sanctions or forbids third-party use of the `cf` session. This is undocumented.
- **Reading the credential file directly** depends on internal, unstable storage. `@cloudflare/workers-auth` says "**Not intended for external use.** APIs may change without notice" ([wsdk/workers-auth/README.md](https://github.com/cloudflare/workers-sdk/blob/89061a40fb20157acf6c947034a74ece357992f0/packages/workers-auth/README.md)). The format already differs from wrangler's (JSON vs TOML, different directory), and keyring mode encrypts it.
- **A supported command path exists but is untested.** `cf accounts tokens create` is a generated command ("Create a new Account Owned API token"), and the default `cf` login scope set includes `account_api_tokens:create`. A user logged into `cf` could therefore mint a scoped account token with the CLI and pass it on, and the API response would carry the token `value`. I did not run this against a live account. Whether the user granted that scope depends on the consent screen.
- The reverse direction is documented: a furea-owned token given to `cf` via `CLOUDFLARE_API_TOKEN` takes priority over every profile.

### 2.4 Wrangler's borrow path is unchanged for now

Wrangler 4.145.0 is the current release, and the Wrangler docs still document `wrangler auth token` ([Wrangler general commands](https://developers.cloudflare.com/workers/wrangler/commands/general/)). No deprecation of the command has been announced. Wrangler's remaining lifetime is covered in §4.

---

## 3. Compatibility and dev tooling (wrangler-compatible `d1_migrations` and asset hashes; wrangler as `apps/worker` devDependency)

### 3.1 D1 migrations

`cf d1 migrations create|list|apply` is a hand-written subgroup. Its file header says it is "Ported from `wrangler/src/d1/migrations/helpers.ts` … Every value here is part of a wire contract with a live `d1_migrations` table, so repos can switch between `wrangler d1 migrations apply` and `cf d1 migrations apply` mid-project … Keep this file behaviourally identical to Wrangler's" ([cf/src/commands/d1/migrations/bookkeeping.ts](https://github.com/cloudflare/cf/blob/ac05496067199275379bcf957a510dec30b82d06/packages/cli/src/commands/d1/migrations/bookkeeping.ts)).

| Aspect | `cf` behaviour |
|---|---|
| Table | Default `d1_migrations` with columns `id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL`. `--table` overrides the name. |
| Files | Default `./migrations`, pattern `<dir>/*.sql`. Names are recorded relative to the directory. |
| Ordering | Numeric by the leading integer of each path segment, then lexical. `NNNN_name.sql` therefore sorts as in wrangler. |
| Per-file request | The file SQL plus `INSERT INTO d1_migrations (name) values ('<file>')` go in one request. The code comment says atomicity is "unverified: D1 has no transactions … which would make wrangler's 'the migration will be rolled back' promise untrue for both CLIs". |
| Target | The database is identified **by ID only** (UUID or 32-hex). "Names and binding names are deliberately not resolved" ([test_bugs/d1-migrations-no-new-config-path.md](https://github.com/cloudflare/cf/blob/ac05496067199275379bcf957a510dec30b82d06/test_bugs/d1-migrations-no-new-config-path.md)). |
| Local | `--local` works for `list` and `apply` (§3.3). |

The docs confirm that D1 `migrations_dir`, `migrations_pattern` and `migrations_table` become `--dir`, `--pattern` and `--table` flags ([Wrangler to cf reference](https://developers.cloudflare.com/cf/wrangler/reference/)).

### 3.2 Static Assets hashing and upload

`cf deploy` calls `@cloudflare/deploy-helpers` (`0.18.1` pinned in cf). That is the same package wrangler's deploy was extracted into, and it is the package whose hashing [cloudflare-api-deploy.md](./cloudflare-api-deploy.md) documented. Its `hashFile` is still `blake3(base64(contents) + extension)` hex truncated to 32 characters, and it still uses the `assets-upload-session` endpoint ([wsdk/deploy-helpers/src/deploy/helpers/hash.ts](https://github.com/cloudflare/workers-sdk/blob/89061a40fb20157acf6c947034a74ece357992f0/packages/deploy-helpers/src/deploy/helpers/hash.ts), [assets.ts](https://github.com/cloudflare/workers-sdk/blob/89061a40fb20157acf6c947034a74ece357992f0/packages/deploy-helpers/src/deploy/helpers/assets.ts)). A furea-deployed asset set therefore dedupes the same way under `cf deploy` as under `wrangler deploy`. deploy-helpers describes itself as "Internal … Not intended for external use".

### 3.3 Pointing `cf` at a furea-deployed instance

- **Resource commands work on any instance in any directory.** Examples are `cf d1 list`, `cf workers scripts ...` and `cf d1 migrations list <DB_ID> --dir ...`. They need the resource ID ([cf for Wrangler users § Use cf alongside a Wrangler project](https://developers.cloudflare.com/cf/wrangler/)).
- **Taking over deploys** requires a `cloudflare.config.ts`, or a Build Output, with the same Worker `name`. For D1, a binding named by database name is connected to the existing database. For KV, the existing namespace is inherited only when the live script already has a KV binding with the **same binding name** (§1.3).
- `cf migrate` converts only `wrangler.json[c]`/`wrangler.toml`. It has no path from an already-deployed script. furea keeps its `wrangler.jsonc` in `apps/worker` for development only (ADR 0007), and that file is not in the published package.

### 3.4 Local dev and local D1 migrations

- **`cf dev` runs no dev server itself.** "`cf` does not run a dev server or bundler itself." It runs the framework's own command. Failing that, it runs "the Cloudflare build tool declared in the project's `package.json`": the Cloudflare Vite plugin, "or Wrangler 4.136.0 or later when the Vite plugin is not declared" ([Develop, build, and deploy § How cf runs your project](https://developers.cloudflare.com/cf/projects/#how-cf-runs-your-project)). The allowlist is in [cf/src/commands/dev/known-impls.ts](https://github.com/cloudflare/cf/blob/ac05496067199275379bcf957a510dec30b82d06/packages/cli/src/commands/dev/known-impls.ts): `@cloudflare/vite-plugin` `>=2.0.0-0 <3.0.0-0` (binary `cf-vite`) and `wrangler` `>=4.136.0` as fallback (binary `cf-wrangler.js`, which wrangler 4.145.0 ships as the `cf-wrangler` bin). There are also Python and Rust entries.
- **What "delegates to wrangler for JS builds" means in practice.** A project that declares `wrangler` and not the Vite plugin gets `cf dev`/`cf build` spawned as `wrangler`'s `cf-wrangler` binary. That binary writes the Build Output, and `cf deploy` uploads it. Build settings for these projects go in an experimental `wrangler.config.ts` ([Wrangler to cf reference § Build settings](https://developers.cloudflare.com/cf/wrangler/reference/#build-settings)). The Vite plugin 2.0 beta "does not depend on Wrangler". `cf dev`/`build`/`deploy` read only `cloudflare.config.ts` and "do not read `wrangler.jsonc` or `wrangler.toml`" ([cf for Wrangler users](https://developers.cloudflare.com/cf/wrangler/)).
- **Local D1 migrations:** `cf d1 migrations apply <ID> --local` and `cf d1 raw --local` run against a short-lived Miniflare over cf's own state. That state is `<cf config dir>/state/v3`, shared across all projects, and `--persist-to` changes it. The docs add: "This is not the data your dev server uses. The Cloudflare Vite plugin 2.0 beta keeps development data in the project, under `.cloudflare/state/`" ([Develop, build, and deploy § Local resource data](https://developers.cloudflare.com/cf/projects/#local-resource-data)). The help text for the same flag shows the default as `~/.config/cloudflare/state`, while the docs say `~/Library/Preferences/cloudflare/state/v3` on macOS. That is a minor inconsistency.

### 3.5 `@cloudflare/vitest-pool-workers` under `cf`

- **Renamed.** `@cloudflare/vitest-plugin` 1.0.0 says: "Rename `@cloudflare/vitest-pool-workers` to `@cloudflare/vitest-plugin` for the v1 release". The codemod is `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin` ([wsdk/vitest-plugin/CHANGELOG.md](https://github.com/cloudflare/workers-sdk/blob/89061a40fb20157acf6c947034a74ece357992f0/packages/vitest-plugin/CHANGELOG.md)). On npm, `@cloudflare/vitest-pool-workers` stops at `0.22.0` and `@cloudflare/vitest-plugin` is at `1.3.x` (first published 2026-08-20). The launch post calls it "our Vitest plugin".
- **It still depends on wrangler.** `@cloudflare/vitest-plugin` has `dependencies: { wrangler: "4.144.0", miniflare, esbuild, ... }` and lazy-imports `wrangler` for config reading, `unstable_splitSqlQuery` in its D1 helper, and the ASSETS binding ([wsdk/vitest-plugin/src/pool/config.ts](https://github.com/cloudflare/workers-sdk/blob/89061a40fb20157acf6c947034a74ece357992f0/packages/vitest-plugin/src/pool/config.ts), [d1.ts](https://github.com/cloudflare/workers-sdk/blob/89061a40fb20157acf6c947034a74ece357992f0/packages/vitest-plugin/src/pool/d1.ts)).
- **Stated path under `cf`:** version 1.1.0 added "an experimental `newConfig` option for loading the Worker's configuration from `cloudflare.config.ts`", and it "cannot be combined with `wrangler`" (the wrangler-config option). No further migration statement was found in the docs.

---

## 4. Timeline

| Event | Date / status | Source |
|---|---|---|
| First `cf` release by Cloudflare on npm (`0.0.4`) | 2026-04-13 | `npm view cf time` |
| `1.0.0-beta.0` published | 2026-09-25 | `npm view cf time` |
| Open beta announced (blog + changelog) | 2026-09-28 | [launch post](https://blog.cloudflare.com/cloudflare-cf-cli-launch/), [changelog](https://developers.cloudflare.com/changelog/post/2026-09-28-cloudflare-cli-beta/) |
| Latest at research time | `1.0.0-beta.6`, 2026-09-30 | `npm view cf` |
| GA date / GA criteria | **Not published.** Neither the blog, the changelog, the `cf` docs nor the repo README/AGENTS gives a date or exit criteria. The docs say only that things "can change before the stable release". | all of the above |
| Wrangler after the beta | "When the open beta ends we will release a final major version of Wrangler that directs you and your agent to use cf. We'll continue to provide maintenance support for Wrangler for 18 months after the beta ends." The window starts when the beta ends, and that date is not set. | [launch post § Migrating from Wrangler](https://blog.cloudflare.com/cloudflare-cf-cli-launch/) |
| Wrangler today | 4.145.0 is still being released. Its changelog already carries experimental `cloudflare.config.ts` and Build Output (`--experimental-new-config`, `--experimental-cf-build-output`) and imports `cf/config`. | [wrangler CHANGELOG](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/CHANGELOG.md) |
| Features still delegated to wrangler during beta | Live tail, single-secret put, esbuild-based JS builds, and Rust/Python Worker builds | [Wrangler to cf reference](https://developers.cloudflare.com/cf/wrangler/reference/#commands-not-yet-supported); launch post |

---

## Implications for Decide: furea's relationship to the cf CLI

These are facts the decision (#36) has to weigh. They are not decisions.

1. **Embedding `cf` as the installer engine means running a CLI binary.** There is no documented JS API. That adds a dependency of about 219 MB (Miniflare and `workerd`), requires Node ≥ 22.18, and sends telemetry by default. The project-command output furea would parse is human progress text, not JSON. Nothing in the beta is covered by a stability promise.
2. **A prebuilt furea bundle can be expressed as Build Output and deployed with `cf deploy --prebuilt`** without a `cloudflare.config.ts`, and every furea binding validates in a dry run. The format is a "v0" draft that "can change before the stable release". D1 migrations would still be a separate `cf d1 migrations apply <ID>` step that furea orders itself. KV adoption by name is not supported, only inheritance from the live script's binding.
3. **`cf` gives no replacement for the `wrangler auth token --json` fallback.** Its session is separate from wrangler's, stored in an internal and undocumented file format, and there is no token-export command. The only supported way to turn a `cf` login into a credential for another tool is to mint an account API token with `cf accounts tokens create`, which is untested here. Both CLIs accept a furea-provided `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. **furea's wrangler-compatibility choices carry over to `cf` unchanged.** `cf d1 migrations` keeps the `d1_migrations` table and ordering by design. `cf deploy` uses the same blake3 asset hash code. A user moving a furea instance to `cf` addresses the database by ID and needs a `cloudflare.config.ts` with the same Worker name.
5. **Dev tooling still runs through wrangler for now, under new names.** `@cloudflare/vitest-pool-workers` is now `@cloudflare/vitest-plugin` 1.x and still depends on `wrangler`. `cf dev` for a non-Vite Worker spawns wrangler ≥ 4.136.0. Only the Vite plugin 2.0 beta path is free of wrangler.
6. **The wrangler 18-month window has not started.** It starts when the beta ends, and no end date or GA criteria have been published. Until then wrangler 4.x ships normally and `wrangler auth token` is still documented.
