# Research: reusing Cloudflare authentication from a third-party CLI

- Issue: [#2](https://github.com/sunwjy/furea/issues/2) (part of #1, blocks #10)
- Date: 2026-09-14
- Sources checked: developers.cloudflare.com, `cloudflare/workers-sdk` on GitHub (`main`, wrangler 4.131.2, `@cloudflare/workers-auth` 0.6.12), Cloudflare API reference, Cloudflare Self-Serve Subscription Agreement, `dash.cloudflare.com/.well-known/openid-configuration`.

## TL;DR

| Question | Answer |
|---|---|
| Can `npx furea` reuse wrangler's browser OAuth flow? | Technically yes in three ways, but only one is a supported interface: `wrangler auth token --json`. Importing `@cloudflare/workers-auth`, reusing wrangler's OAuth client id, or reading `~/.wrangler/config/default.toml` directly are all unsupported and fragile. |
| Is that permitted? | Reading wrangler's credential files or its published package is not prohibited by the licence (MIT/Apache-2.0) or the Self-Serve Subscription Agreement. Presenting furea to the Cloudflare OAuth server *as Wrangler* (its client id + consent page) is not something Cloudflare has authorised; the sanctioned way for a third party to get OAuth is to register its own OAuth client (GA since 2026-06-03). |
| Does wrangler expose a programmatic login? | No JS API. `wrangler login` / `wrangler auth token` (CLI) are the only supported surface. |
| Minimal API-token permission set for furea | Account: **Workers Scripts Write, Workers KV Storage Write, D1 Write, Account Analytics Read**. Zone (only if using zone routes instead of custom domains): **Workers Routes Write, Zone Read**. Optional but strongly recommended: **Account Settings Read** (account listing when `CLOUDFLARE_ACCOUNT_ID` is unset). |
| CI | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` env vars; account-owned token (`cfat_`) preferred over user token. |
| Recommendation | **Default:** furea-owned API token, created by the user via a pre-filled dashboard template URL, verified and stored by furea. **Fallback:** borrow the developer's existing wrangler session through `wrangler auth token --json` when wrangler is installed and logged in. Register a furea OAuth client later if the token-paste UX proves to be a real adoption blocker. |

---

## 1. Wrangler's browser OAuth flow

### 1.1 How it works today (primary source: `packages/workers-auth`)

Since the refactor into `@cloudflare/workers-auth`, wrangler's `src/user/user.ts` is a thin adapter: "The wrangler auth layer proper — the OAuth flow wiring, credential storage, login / logout / refresh, credential resolution, account selection, and the `requireAuth` / `requireApiToken` entry points — now lives in `@cloudflare/workers-auth/wrangler` so other Cloudflare CLIs can share it." ([wrangler/src/user/user.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/user/user.ts))

| Item | Value | Source |
|---|---|---|
| OAuth client id (production) | `54d11594-84e4-41aa-b438-e81b8fa78ee7` (staging `4b2ea6cc-9421-4761-874b-ce550e0e3def`), overridable via `WRANGLER_CLIENT_ID` | [workers-auth/src/wrangler/env.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/src/wrangler/env.ts) |
| Registered redirect URI | `http://localhost:8976/oauth/callback` (`--callback-host` / `--callback-port` change only the bind address) | [workers-auth/src/wrangler/constants.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/src/wrangler/constants.ts), [wrangler/src/user/commands.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/user/commands.ts) |
| Endpoints | `https://dash.cloudflare.com/oauth2/auth`, `/oauth2/token`, `/oauth2/revoke`, device: `/oauth2/device/auth` (env overrides `WRANGLER_AUTH_URL`, `WRANGLER_TOKEN_URL`, `WRANGLER_REVOKE_URL`, `WRANGLER_AUTH_DOMAIN`) | [workers-auth/src/env-vars.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/src/env-vars.ts) |
| Grant | Authorization Code + PKCE `S256`; `offline_access` is always appended to the requested scopes | [workers-auth/src/generate-auth-url.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/src/generate-auth-url.ts) |
| Device flow | `wrangler login --device` (RFC 8628) since workers-auth 0.6.0 | [workers-auth CHANGELOG](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/CHANGELOG.md), [wrangler general commands](https://developers.cloudflare.com/workers/wrangler/commands/general/) |
| Default scopes | `account:read user:read workers:write workers_kv:write workers_routes:write workers_scripts:write workers_tail:read d1:write pages:write zone:read ssl_certs:write ai:write ai-search:write ai-search:run websearch.run agent-memory:write queues:write pipelines:write secrets_store:write artifacts:write flagship:write containers:write cloudchamber:write connectivity:admin email_routing:write email_sending:write browser:write challenge-widgets.write` | [workers-auth/src/core/scopes.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/src/core/scopes.ts) |
| Token exchange | `grant_type=authorization_code` + `code_verifier`, response `access_token`, `expires_in`, `refresh_token`, `scope`; refresh via `grant_type=refresh_token` with rotation | [workers-auth/src/token-exchange.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/src/token-exchange.ts) |
| Storage location | `getGlobalConfigPath()`: legacy `~/.wrangler` if that directory exists, else XDG `$XDG_CONFIG_HOME/.wrangler` (default `~/.config/.wrangler`); file `config/default.toml` (named profiles: `config/<profile>.toml`) | [workers-utils/src/global-wrangler-config-path.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-utils/src/global-wrangler-config-path.ts), [workers-auth README](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/README.md) |
| File shape | `oauth_token`, `refresh_token`, `expiration_time`, `scopes[]` (legacy `api_token`) | [workers-auth/src/config-file/auth.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/src/config-file/auth.ts) |
| Encrypted option | `wrangler login --use-keyring` / `CLOUDFLARE_AUTH_USE_KEYRING=true` writes an AES-256-GCM `.enc` sibling file whose key lives in the OS keyring (macOS `security`, Linux `secret-tool`, Windows `@napi-rs/keyring`) | [workers-auth AGENTS.md](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/AGENTS.md) |
| Refresh | On every credential access the flow compares `expiration_time` with now and calls the refresh grant; in non-interactive/CI it returns `token-expired-non-interactive` instead of opening a browser | [workers-auth/src/flow.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/src/flow.ts) |
| Precedence | `CLOUDFLARE_API_KEY`+`CLOUDFLARE_EMAIL` > `CLOUDFLARE_API_TOKEN` > stored OAuth token | [workers-auth/src/credentials.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/src/credentials.ts) |

Access-token lifetime is not documented; the code only trusts `expires_in` from the token endpoint ([token-exchange.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/src/token-exchange.ts)). The 2021 launch post only says the access token is "short-lived" ([blog.cloudflare.com/wrangler-oauth](https://blog.cloudflare.com/wrangler-oauth/)).

### 1.2 Ways a third-party CLI could reuse it, ranked

**(a) `wrangler auth token` — supported.** Cloudflare added this command specifically so other tools can consume wrangler's session: it "retrieves your current authentication token or credentials for use with other tools and scripts", in priority order `CLOUDFLARE_API_TOKEN`, then API key/email (`--json` only), then the OAuth token from `wrangler login`, "automatically refreshed if expired". `--json` returns `{ "type": "oauth" | "api_token", "token": "..." }` or `{ "type": "api_key", "key", "email" }`. ([Changelog 2025-12-18](https://developers.cloudflare.com/changelog/post/2025-12-18-wrangler-auth-token/), [general commands](https://developers.cloudflare.com/workers/wrangler/commands/general/), [wrangler/src/user/commands.ts `AuthTokenInfo`](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/user/commands.ts)). Cloudflare's own docs use exactly this pattern ("`wrangler auth token` to get an auth token to replace `$CLOUDFLARE_API_TOKEN`") in the AI Gateway REST docs ([ai-gateway/usage/rest-api](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)).

Caveats: the token is an OAuth *access* token, so it expires; furea must re-run `wrangler auth token` per session rather than persist it. Wrangler must be installed (`npx wrangler auth token --json` works but downloads wrangler). The scopes are whatever the user granted at `wrangler login`; since 2026-08-22 users can decline optional scopes on the consent screen, so `d1:write` etc. may be missing ([Changelog 2026-08-22](https://developers.cloudflare.com/changelog/post/2026-08-22-wrangler-mcp-optional-oauth-scopes/)). furea can read the granted scopes from the token file's `scopes` field only via the unsupported path (b).

**(b) Read `~/.wrangler/config/default.toml` directly — unsupported.** Works today for the plaintext default, but breaks with `--use-keyring` (`.enc` file + OS keyring key), named profiles (`config/<profile>.toml`, directory bindings), the legacy-vs-XDG path fork, and does not refresh an expired token. The Profiles doc only documents that `CLOUDFLARE_API_TOKEN` overrides all profiles, not the on-disk format ([wrangler/profiles](https://developers.cloudflare.com/workers/wrangler/profiles/)).

**(c) Import `@cloudflare/workers-auth` — unsupported.** The package README states: "**Not intended for external use.** APIs may change without notice. This package is consumed only by other packages inside this monorepo." and AGENTS.md: "Internal-only — published as `prerelease: true`" ([README](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/README.md), [AGENTS.md](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/AGENTS.md)). The design is explicitly for *Cloudflare's* CLIs (`wrangler`, `cf`): each gets its own OAuth app registration, redirect port, consent pages, config dir and keyring service ([src/cf/constants.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/src/cf/constants.ts)). A third party using it would still have to supply a `clientId` and `redirectUri`, which brings us to (d).

**(d) Run the OAuth flow yourself with wrangler's client id — not authorised.** The client id is public and the code is MIT/Apache-2.0, but the OAuth *app registration* (client id, `localhost:8976` redirect, "wrangler-oauth-consent-granted" pages that tell the user they authorised *Wrangler*) belongs to Cloudflare. Nothing in the docs or terms grants third parties the right to present themselves as Wrangler on the consent screen; Cloudflare's stated route for third parties is a self-managed OAuth client (1.4). This is the option to avoid.

**(e) Shell out to `wrangler login` then (a).** Supported composition: `npx wrangler login` (or `--device`) followed by `wrangler auth token --json`. It also lets furea request a minimal scope set: `wrangler login --scopes account:read user:read workers_scripts:write workers_kv:write d1:write zone:read` ([general commands](https://developers.cloudflare.com/workers/wrangler/commands/general/)).

### 1.3 Is it permitted?

- **Self-Serve Subscription Agreement §2.3 (Credentials):** "If you permit third parties to access your Cloudflare account (e.g., by providing your API token or using OAuth)…" and "You are responsible for maintaining the confidentiality of all usernames, passwords, and other access credentials (such as API tokens and OAuth credentials)". §3 permits use of "third-party service integrations made available through the Cloudflare dashboard or APIs". §2.2.1(g) forbids reverse engineering the Services; §2.2.1(c) forbids circumventing usage limits. ([cloudflare.com/terms](https://www.cloudflare.com/terms/)) Nothing here forbids a user handing their own OAuth/API token to furea; the burden is on the user and furea to keep it confidential.
- **Cloudflare's stated third-party path:** "OAuth lets third-party applications act on behalf of a user to access their Cloudflare account. Cloudflare Developers can now create and manage their own OAuth applications to integrate with Cloudflare." ([Changelog 2026-06-03](https://developers.cloudflare.com/changelog/post/2026-06-03-public-oauth-clients/)). Existence of this program is the strongest signal that reusing *wrangler's* registration is not the intended route.
- **Licence:** `@cloudflare/workers-auth` is "MIT OR Apache-2.0" ([package.json](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/package.json)); the licence covers the code, not the OAuth app registration or the Cloudflare OAuth server's acceptance policy.

### 1.4 Does wrangler expose a programmatic login?

No. Wrangler's public JS API (`packages/wrangler/src/api/index.ts`) exports `unstable_dev`, `startWorker`, `getPlatformProxy`, `unstable_readConfig`, mTLS helpers, remote-binding helpers — no `login`, `requireAuth`, or token accessor ([wrangler/src/api/index.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/api/index.ts)). The only supported surfaces are the CLI commands `wrangler login`, `wrangler logout`, `wrangler whoami`, `wrangler auth token`, and the experimental `wrangler auth create|activate|deactivate|list|delete` profile commands ([general commands](https://developers.cloudflare.com/workers/wrangler/commands/general/)).

### 1.5 Registering furea's own OAuth client (the sanctioned alternative)

Cloudflare now lets any account create OAuth clients ([Create your OAuth client](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/), API: `POST /accounts/{account_id}/oauth_clients`, permission "OAuth Client Write" ([API ref](https://developers.cloudflare.com/api/resources/iam/subresources/oauth_clients/methods/create))). Facts relevant to a CLI:

- Flow for "Browser-based, mobile, desktop, or CLI app": Authorization Code with PKCE, `token_endpoint_auth_method: none`, PKCE required `S256`. "Clients that use PKCE do not need a client secret."
- "Cloudflare does not support Client Credentials, Implicit, Resource Owner Password Credentials, Device Authorization, or other OAuth grant types for third-party clients." (So no `--device` equivalent for furea, even though the server advertises `urn:ietf:params:oauth:grant-type:device_code` in its [openid-configuration](https://dash.cloudflare.com/.well-known/openid-configuration) — that is reserved for first-party clients.)
- `grant_types` must include `authorization_code`, may include `refresh_token`; `scopes` are dot-delimited (e.g. `workers-scripts.write`); "OAuth scope names correspond to Cloudflare API token permission names", listed by `GET /oauth/scopes`. `optional_scopes` lets users decline scopes.
- Endpoints: `https://dash.cloudflare.com/oauth2/auth`, `/oauth2/token`, `/oauth2/revoke`, `/oauth2/userinfo`, `/.well-known/openid-configuration` ([Integrate your OAuth client](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/)).
- **Visibility:** "New OAuth clients default to private visibility. Private clients can only be authorized by members of the parent Cloudflare account. Public clients allow authorization from any Cloudflare user." Going public requires client name, logo, client URL, scopes and DNS `TXT` domain verification of the client URL; "Setting a client's visibility to public is permanent."
- Not documented: access/refresh token lifetimes, whether `http://localhost:<port>/…` redirect URIs are accepted for public clients (wrangler's own registration uses one, so the server supports it, but the third-party docs do not state the policy), and rate limits.

For furea this means: a working OAuth login requires a *public* client owned by the furea maintainer's account, a verified domain, a logo, and permanent public status. It is feasible but is ongoing maintenance and a new (June 2026) product surface.

---

## 2. API-token alternative

### 2.1 Endpoints furea will call and the permission each one requires

Permission names below are quoted from the "Required API token permissions" section of each API reference page.

| Operation | Endpoint | Required permission (account-scoped unless noted) | Source |
|---|---|---|---|
| Create D1 database | `POST /accounts/{account_id}/d1/database` | D1 Write | [API ref](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/) |
| Run migrations / SQL | `POST /accounts/{account_id}/d1/database/{database_id}/query` | D1 Read or D1 Write | [API ref](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/) |
| Create KV namespace | `POST /accounts/{account_id}/storage/kv/namespaces` | Workers KV Storage Write | [API ref](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/create/) |
| Upload Worker | `PUT /accounts/{account_id}/workers/scripts/{script_name}` | Workers Scripts Write | [API ref](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/) |
| Edit script settings/bindings | `PATCH /accounts/{account_id}/workers/scripts/{script_name}/script-settings` | Workers Scripts Write | [API ref](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/edit/) |
| workers.dev subdomain | `GET /accounts/{account_id}/workers/subdomain`, `POST …/scripts/{script_name}/subdomain` | Workers Scripts Read/Write | [get](https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/get/), [create](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/) |
| Workers custom domain | `PUT /accounts/{account_id}/workers/domains` (wrangler uses `…/scripts/{name}/domains/changeset` + `/domains/records`) | Workers Scripts Write; Cloudflare "create[s] DNS records and issue[s] necessary certificates on your behalf" | [API ref](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/), [custom domains doc](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [deploy-helpers publish-routes.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/deploy-helpers/src/triggers/publish-routes.ts) |
| Zone route (alternative to custom domain) | `POST /zones/{zone_id}/workers/routes` | **Zone:** Workers Routes Write | [API ref](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/create/) |
| Zone lookup for routes (`GET /zones?name=…&account.id=…`) | `GET /zones` | **Zone:** Zone Read | [API ref](https://developers.cloudflare.com/api/resources/zones/methods/list/), [deploy-helpers zones.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/deploy-helpers/src/triggers/zones.ts) |
| Analytics Engine SQL API | `POST /accounts/{account_id}/analytics_engine/sql` | Account Analytics Read ("Account \| Account Analytics \| Read") | [SQL API doc](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/) |
| Analytics Engine writes | via Worker binding; "datasets are created automatically the first time you write to them" — no token permission | [get started](https://developers.cloudflare.com/analytics/analytics-engine/get-started/) |
| Account discovery (`GET /accounts`, `GET /accounts/{id}`) | any Workers permission satisfies `GET /accounts/{id}`; wrangler's Workers Builds token also carries Account Settings Read | [API ref](https://developers.cloudflare.com/api/resources/accounts/methods/get/), [Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) |
| Token self-check | `GET /user/tokens/verify` (user token) / `GET /accounts/{account_id}/tokens/verify` (account token) | none beyond a valid token | [user verify](https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/), [account verify](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/) |

**Minimal furea token (custom-domain deployment, workers.dev preview, analytics dashboard):**

- Account → Workers Scripts → Edit
- Account → Workers KV Storage → Edit
- Account → D1 → Edit
- Account → Account Analytics → Read

Add only if furea ever uses zone routes instead of custom domains: Zone → Workers Routes → Edit, Zone → Zone → Read. Add Account → Account Settings → Read if furea wants to list accounts by name when no `CLOUDFLARE_ACCOUNT_ID` is given (this is what Cloudflare's own Workers Builds token includes: "Account Settings (read), Workers Scripts (edit), Workers KV Storage (edit), Workers R2 Storage (edit)" + zone "Workers Routes (edit)" + user "User Details (read), Memberships (read)" — [Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)).

The generic "Edit Cloudflare Workers" template Cloudflare recommends for GitHub Actions ([external CI/CD: GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)) does **not** include D1 or Account Analytics, so furea cannot rely on it.

### 2.2 Pre-filled token creation link

Cloudflare documents template URLs that pre-fill the dashboard's token form. Permission keys are URL-encoded JSON `[{ "key": "...", "type": "read|edit|..." }]`; documented keys include `workers_scripts`, `workers_kv_storage`, `d1`, `account_analytics`, `account_settings`, `workers_routes`, `zone` ([API token template URLs](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/)).

- User token: `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=<json>&accountId=*&zoneId=all&name=furea`
- Account token: `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=<json>&name=furea`

Example JSON for furea: `[{"key":"workers_scripts","type":"edit"},{"key":"workers_kv_storage","type":"edit"},{"key":"d1","type":"edit"},{"key":"account_analytics","type":"read"}]`. "Template URLs only pre-fill the token creation form. Users must still complete the token creation process in the dashboard."

Tokens can also be minted via API (`POST /accounts/{account_id}/tokens`, requires "Account API Tokens Write"; `POST /user/tokens`), with `permission_groups` ids from `GET /accounts/{account_id}/tokens/permission_groups` ([create token](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/), [permission groups](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/subresources/permission_groups/methods/list/), [create via API](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/)). This is only useful if furea already holds a privileged token, so it is a CI/bootstrap tool, not a first-run path.

### 2.3 Account-owned vs user tokens

| | User token | Account-owned token |
|---|---|---|
| Identity | "act on behalf of a particular user and inherit a subset of that user's permissions" | "service principals with their own specific set of permissions"; `cfat_` prefix |
| Created at | My Profile → API Tokens (`/profile/api-tokens`) | Manage Account → Account API Tokens; requires Super Administrator (docs) — the template-URL page also says Administrator |
| Survives user leaving the account | no | yes ("continuity … after staff turnover") |
| User-level endpoints (`/user`, `/memberships`, `/user/tokens/verify`) | yes | no — wrangler detects an account token by `/user/tokens/verify` returning error 1000, and `/memberships` returns 9106, falling back to `/accounts` |
| Compatibility | all | Workers ✅, D1 ✅, Workers KV ✅, Account Analytics ✅; not: Intel Data Platform, Page Rules, Registrar, Super Bot Fight Mode, Turnstile, Zero Trust Client Platform |

Sources: [Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/), [Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/), [wrangler whoami.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/user/whoami.ts), [workers-auth core/factory.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/src/core/factory.ts), [memberships API](https://developers.cloudflare.com/api/resources/memberships/methods/list/).

Implication for furea: never depend on `/user` or `/memberships`. Resolve the account via `CLOUDFLARE_ACCOUNT_ID` → furea config → `GET /accounts` (works for both token kinds), exactly like wrangler's fallback. Use `/accounts/{id}/tokens/verify` when the token starts with `cfat_`, else `/user/tokens/verify`.

### 2.4 Token hygiene furea should implement

- Store under furea's own XDG config dir (e.g. `~/.config/furea/`), mode 0600; never write into `~/.wrangler`.
- Offer `expires_on` / TTL and IP conditions when generating the template link ([Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)).
- Support `CLOUDFLARE_API_TOKEN` (and honour `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_BASE_URL`) with the same names wrangler uses so CI setups are interchangeable ([system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/)).

---

## 3. Non-interactive (CI) authentication

- Cloudflare's documented CI path is an API token in `CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID`, consumed by `cloudflare/wrangler-action@v3` (`apiToken`, `accountId` inputs; global API key/email no longer supported by the action) ([GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [wrangler-action README](https://github.com/cloudflare/wrangler-action/blob/main/README.md)).
- Wrangler never opens a browser when `isNonInteractiveOrCI()` is true (no TTY on stdin/stdout, or any CI per `ci-info`); an expired OAuth token then fails with `token-expired-non-interactive` ([workers-utils/src/is-interactive.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-utils/src/is-interactive.ts), [workers-auth/src/flow.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/src/flow.ts)). furea should copy this rule: in CI, require env credentials and never prompt.
- Prefer an **account-owned token** in CI ("Ideal for CI/CD pipelines … continuity after staff turnover") ([Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)). Note Workers Builds itself still says "only user tokens are supported, with account-owned token support coming soon" for its auto-created token, so the ecosystem is mid-migration ([Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)).
- Cloudflare Access-protected accounts additionally need `CLOUDFLARE_ACCESS_CLIENT_ID` / `CLOUDFLARE_ACCESS_CLIENT_SECRET` service-token env vars; furea does not need to implement this unless it targets staging/Access-gated APIs ([system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/)).

---

## 4. Recommendation

### Default: furea-owned API token via template URL

1. `npx furea` prints/opens the pre-filled template URL (section 2.2) with exactly the four furea permissions, defaulting to the **account token** form and offering the user-token form as a flag.
2. User pastes the token; furea calls the matching `tokens/verify` endpoint, resolves the account (`CLOUDFLARE_ACCOUNT_ID` → `GET /accounts`), and stores the token in `~/.config/furea/`.
3. The same token, in `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, is the CI path — one credential model, one code path, no expiry/refresh logic, no dependency on wrangler being installed, and fully covered by Cloudflare's documented terms and product surface.

Why not "register a furea OAuth client" as default: it needs a permanently-public client with domain verification and logo, has undocumented token lifetimes and no device-code flow for third parties, and still needs the API-token path for CI. Revisit once the default has shipped and the paste-a-token UX proves to be a real adoption blocker.

### Fallback: borrow the developer's wrangler session

If `wrangler` is on PATH (or `npx wrangler` is acceptable) and `wrangler auth token --json` returns `{"type":"oauth"|"api_token"}`, furea uses that bearer token for the current run (do not persist OAuth tokens; re-run the command per session). If the token lacks a needed scope, tell the user to run `wrangler login --scopes account:read user:read workers_scripts:write workers_kv:write d1:write zone:read` (or the full default set) and retry. This is the officially "for use with other tools" surface and is how Cloudflare's own docs hand wrangler credentials to curl.

Do **not** implement: reading `~/.wrangler/config/*.toml` directly, importing `@cloudflare/workers-auth`, or running PKCE with wrangler's client id `54d11594-…`.

### Open risks

1. **Token expiry via `wrangler auth token`:** the OAuth access token lifetime is undocumented; long furea runs (migrations + deploy) could straddle expiry. Mitigation: fetch the token immediately before each API phase.
2. **Analytics Engine SQL API with an OAuth token:** the SQL API docs only describe API tokens with "Account Analytics Read"; whether wrangler's `account:read` OAuth scope ("See your account info such as account details, analytics, and memberships") is accepted by `/analytics_engine/sql` is unverified. Test before relying on the fallback for the analytics dashboard.
3. **Custom-domain permission completeness:** the API reference lists only "Workers Scripts Write" for `PUT /accounts/{id}/workers/domains`, and wrangler's `domains/changeset` / `domains/records` endpoints have no separate reference page. If Cloudflare tightens this to require Zone/DNS permissions, the minimal set grows; keep an integration test that provisions a real custom domain.
4. **Account-token quirks:** account tokens cannot call `/user` or `/memberships`; any code path that assumes a user identity (e.g. showing the email in `furea whoami`) must degrade gracefully, as wrangler does.
5. **Optional OAuth scopes:** since 2026-08-22 users can decline scopes at `wrangler login`; the fallback path must handle 403/`10000`-style authorisation errors per phase rather than assuming the default scope set.
6. **Docs churn:** `@cloudflare/workers-auth`, the `cf` CLI, self-managed OAuth clients and account-token support in Workers Builds are all 2025-2026 additions and marked experimental/prerelease in places; re-check this document before implementing #10.
