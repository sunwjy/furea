# Provisioning and deploying a prebuilt Worker via the Cloudflare API

Research for issue #3 (part of #1). Date: 2026-09-14.

**Question.** `npx furea` ships a prebuilt Worker bundle plus an admin SPA (Static Assets) and must, with no `wrangler.toml` in the user's working directory: create D1 + KV, apply D1 migrations, upload the Worker with bindings and assets, and attach a Workers Custom Domain or `workers.dev` subdomain. Upgrades rerun the same command and must apply only new migrations.

Sources are primary only: developers.cloudflare.com, the Cloudflare API reference, and `cloudflare/workers-sdk` on GitHub. Each claim carries its URL. Code observations from `workers-sdk` reflect `main` on the date above (wrangler `4.131.2` on npm).

---

## 1. Provisioning D1 and KV via the REST API

### 1.1 D1

| Operation | Endpoint | Notes |
|---|---|---|
| Create | `POST /accounts/{account_id}/d1/database` body `{ "name", "primary_location_hint"? }` → `result.uuid`, `result.name` | Requires **D1 Write**. `primary_location_hint` ∈ `wnam, enam, weur, eeur, apac, oc`. https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/ |
| List (idempotency check) | `GET /accounts/{account_id}/d1/database?name=...&page=&per_page=` | `name` is documented as "a database name to search for"; treat it as a filter and compare `name` exactly client-side. https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/list/ |
| Query | `POST /accounts/{account_id}/d1/database/{database_id}/query` body `{ "sql", "params"? }` or `{ "batch": [{sql, params}, ...] }` → `result[]` of `{ success, results, meta: { duration, changes, last_row_id, rows_read, rows_written, ... } }` | "Supports multiple statements, joined by semicolons, which will be executed as a batch." D1 Read or D1 Write. https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/ |
| Raw query | `POST .../d1/database/{database_id}/raw` | Same input; rows come back as `{ columns: [...], rows: [[...]] }` (performance-optimised). https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/raw/ |
| Bulk import | `POST .../d1/database/{database_id}/import` with `action: "init" \| "ingest" \| "poll"` (MD5 `etag`, R2 `upload_url`, `filename`, `current_bookmark`) | Intended for large SQL files; wrangler uses it only for `--file`. https://developers.cloudflare.com/d1/tutorials/import-to-d1-with-rest-api/ |

Per-query limits worth respecting in a migration runner: max SQL statement length 100 KB, max 100 bound parameters per query, 30 s query timeout, 100 columns per table; the same limits apply to each statement in a batch. https://developers.cloudflare.com/d1/platform/limits/

### 1.2 KV

| Operation | Endpoint | Notes |
|---|---|---|
| Create | `POST /accounts/{account_id}/storage/kv/namespaces` body `{ "title", "jurisdiction"? }` → `result.id`, `result.title` | Requires **Workers KV Storage Write**. `title` ≤ 512 chars. https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/create/ |
| List (idempotency check) | `GET /accounts/{account_id}/storage/kv/namespaces?page=&per_page=&order=title&direction=asc` | `per_page` 1–1000; match `title` exactly client-side. https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/list/ |

Titles are not unique server-side, so `furea` should look up by title first and only create when absent; the same applies to D1 names.

---

## 2. Applying D1 migrations remotely

### 2.1 What `wrangler d1 migrations apply --remote` actually does

From `packages/wrangler/src/d1/migrations/apply.ts` and `helpers.ts` (https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/d1/migrations/apply.ts, https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/d1/migrations/helpers.ts):

1. `initMigrationsTable` runs, via the same `executeSql` path as `wrangler d1 execute --command`:
   ```sql
   CREATE TABLE IF NOT EXISTS "<migrations_table>"(
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     name       TEXT UNIQUE,
     applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
   );
   ```
2. `getUnappliedMigrations` runs `SELECT * FROM <table> ORDER BY id`, collects `name`, and diffs against the `.sql` files in the migrations dir (sorted by numeric prefix, so `1_`, `9_`, `10_` order correctly).
3. For each unapplied file, `buildMigrationQuery` concatenates the file contents with
   ```sql
   INSERT INTO "<migrations_table>" (name) values ('<filename>');
   ```
   and sends the whole string as one `command`. The loop stops at the first failure.
4. Remote execution goes to `POST /accounts/{account_id}/d1/database/{uuid}/query` with `{ sql }` (`d1ApiPost(..., "query", { sql })` in `packages/wrangler/src/d1/execute.ts`). Wrangler's own comment there: "The D1 query API splits multi-statement SQL on `;` server-side". https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/d1/execute.ts
5. Wrangler does not wrap the SQL in `BEGIN/COMMIT`. Its `trimmer.ts` strips a leading `BEGIN TRANSACTION;`/`COMMIT;` from dump files and says: "D1 runs your SQL in a transaction for you." https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/d1/trimmer.ts The D1 docs state for batches: "Batched statements are SQL transactions... If a statement in the sequence fails, then an error is returned for that specific statement, and it aborts or rolls back the entire sequence." https://developers.cloudflare.com/d1/worker-api/d1-database/

Defaults: `DEFAULT_MIGRATION_PATH = "./migrations"`, `DEFAULT_MIGRATION_TABLE = "d1_migrations"` (https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/d1/constants.ts). Config keys are `migrations_dir`, `migrations_table`, `migrations_pattern` under each `d1_databases` entry. https://developers.cloudflare.com/d1/reference/migrations/

CLI shape: `npx wrangler d1 migrations apply <DATABASE> --remote` where `<DATABASE>` is the binding or database name from the config; also `--local`, `--preview`, `--env`. https://developers.cloudflare.com/workers/wrangler/commands/d1/

### 2.2 Reimplementing it over the HTTP API

The whole algorithm is a handful of HTTP calls and is trivial to reproduce with `fetch`:

```text
POST /query { sql: "CREATE TABLE IF NOT EXISTS d1_migrations (...)" }
POST /query { sql: "SELECT name FROM d1_migrations ORDER BY id" }
for each unapplied file (numeric-prefix order):
  POST /query { sql: "<file contents>\nINSERT INTO d1_migrations (name) values ('<file>');" }
```

Because the migration SQL and the bookkeeping `INSERT` travel in one request and D1 runs the request as a transaction (see 2.1 step 5), a failed migration leaves no row behind and is safely retried. Using the same table name and row shape as wrangler keeps the database compatible with `wrangler d1 migrations list` if a user later adopts wrangler themselves. Constraints: each statement ≤ 100 KB, and note the docs' advice to `PRAGMA defer_foreign_keys = true` inside migrations that rewrite tables with foreign keys. https://developers.cloudflare.com/d1/reference/migrations/

---

## 3. Uploading the Worker with bindings and Static Assets

### 3.1 Static Assets: upload session → bulk upload → completion JWT

Documented flow (https://developers.cloudflare.com/workers/static-assets/direct-upload/ and https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/assets/subresources/upload/methods/create/):

1. Build a manifest `{ "/path/file.ext": { "hash": "<32 hex chars>", "size": <bytes> } }`.
2. `POST /accounts/{account_id}/workers/scripts/{script_name}/assets-upload-session` with `{ manifest }` (**Workers Scripts Write**). Response: `jwt` (valid one hour) and `buckets: string[][]` — groups of hashes to upload together; hashes Cloudflare already has are omitted. If `buckets` is empty, the returned `jwt` is already the completion token.
3. For each bucket: `POST /accounts/{account_id}/workers/assets/upload?base64=true`, `Authorization: Bearer <upload jwt>`, `multipart/form-data` with one part per file, field name = the file's hash, body = base64 contents, part `Content-Type` = the served MIME type (`application/null` to omit). The final response (HTTP 201) carries the completion `jwt`.
4. Pass the completion token as `metadata.assets.jwt` on the script upload (also valid for one hour). `"keep_assets": true` reuses the previous version's assets instead.

How wrangler computes the hash (https://github.com/cloudflare/workers-sdk/blob/main/packages/deploy-helpers/src/deploy/helpers/hash.ts): `blake3(base64(contents) + extension)` hex, truncated to 32 characters. Wrangler uploads buckets with concurrency 3, up to 5 attempts with backoff, and takes `completionJwt = res.jwt || completionJwt` from each bulk response (https://github.com/cloudflare/workers-sdk/blob/main/packages/deploy-helpers/src/deploy/helpers/assets.ts). Any 32-hex-character content hash satisfies the API contract, but matching wrangler's scheme means an asset set deployed by `furea` and later by wrangler dedupes correctly.

Limits: 20,000 files per Worker version, 25 MiB per file (Free and Paid). https://developers.cloudflare.com/workers/platform/limits/

### 3.2 Script upload (multipart metadata)

`PUT /accounts/{account_id}/workers/scripts/{script_name}` as `multipart/form-data` (**Workers Scripts Write**). One part is `metadata` (JSON); the module parts use `Content-Type: application/javascript+module`. https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/ and https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/

Metadata fields relevant to `furea`:

```jsonc
{
  "main_module": "index.js",             // part name of the ES-module entry
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "bindings": [
    { "type": "d1",           "name": "DB",     "id": "<d1 uuid>" },
    { "type": "kv_namespace", "name": "KV",     "namespace_id": "<kv id>" },
    { "type": "assets",       "name": "ASSETS" },
    { "type": "plain_text",   "name": "PUBLIC_ORIGIN", "text": "https://s.example.com" },
    { "type": "secret_text",  "name": "ADMIN_TOKEN",   "text": "..." }
  ],
  "assets": {
    "jwt": "<completion token>",
    "config": {
      "html_handling": "auto-trailing-slash",
      "not_found_handling": "single-page-application",
      "run_worker_first": ["/api/*"]       // or true
    }
  },
  "observability": { "enabled": true }
}
```

Binding type strings and required keys (`d1` → `id`, `kv_namespace` → `namespace_id`, `plain_text`/`secret_text` → `text`, `assets`) are from the multipart-metadata page above. `keep_bindings` lets a re-upload retain existing secrets not resent. Wrangler itself now uploads through `POST .../workers/scripts/{name}/versions` followed by a deployment, and falls back to `PUT .../workers/scripts/{name}?excludeScript=true&bindings_inherit=strict` (https://github.com/cloudflare/workers-sdk/blob/main/packages/deploy-helpers/src/deploy/deploy.ts); the single `PUT` is the simpler and fully supported path for a tool that always deploys 100 % to the latest version.

Routing note for a shortener: by default "Cloudflare will first attempt to serve static assets if one matches the incoming request. If an appropriate static asset is not found, Cloudflare will invoke your Worker script." https://developers.cloudflare.com/workers/static-assets/routing/worker-script/ Short links like `/abc123` never match an asset, so they hit the Worker; the admin SPA under `/admin/…` is served by assets with `single-page-application` fallback. Requests served purely by assets are free and do not count toward the Workers request quota; anything matched by `run_worker_first` counts. https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/

`GET /accounts/{account_id}/workers/scripts/{script_name}` returns raw script content and can double as an existence probe (404 vs 200). https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/get/

---

## 4. Routing: workers.dev vs Custom Domain vs zone route

### 4.1 workers.dev

- Account subdomain: `GET|PUT /accounts/{account_id}/workers/subdomain` body `{ "subdomain": "my-subdomain" }` (**Workers Scripts Write**). Must exist before a per-Worker URL works; Workers run at `<worker-name>.<account-subdomain>.workers.dev`, and the name must be ≤ 63 chars, alphanumeric/dashes, not starting or ending with a dash. https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/update/ , https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/get/ , https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- Per-Worker toggle: `POST /accounts/{account_id}/workers/scripts/{script_name}/subdomain` body `{ "enabled": true, "previews_enabled": false }`. https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/
- Wrangler enables workers.dev when `workers_dev` is unset and no routes are configured (`const defaultWorkersDev = routes.length === 0`). https://github.com/cloudflare/workers-sdk/blob/main/packages/deploy-helpers/src/triggers/deploy.ts
- Cloudflare labels workers.dev as intended "for personal projects, not production workloads". https://developers.cloudflare.com/workers/configuration/routing/workers-dev/

### 4.2 Workers Custom Domain (recommended for a shortener)

- Prerequisite: an active zone on Cloudflare. Cloudflare creates the DNS record and issues the certificate automatically; the domain applies to the whole hostname regardless of path; no wildcards; cannot be created on a hostname that already has a conflicting DNS record without override. https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- API: `PUT /accounts/{account_id}/workers/domains` body `{ "hostname", "service", "environment"?, "zone_id"? | "zone_name"? }` → `{ id, cert_id, hostname, service, zone_id, zone_name }` (**Workers Scripts Write**). https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/ List/verify: `GET /accounts/{account_id}/workers/domains?hostname=&service=&zone_id=`. https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/
- Wrangler uses a richer, batch variant: `POST .../workers/scripts/{name}/domains/changeset?replace_state=true` to preview `added/removed/updated/conflicting`, then `PUT .../workers/scripts/{name}/domains/records` with `{ override_scope: true, override_existing_origin, override_existing_dns_record, origins: [{ hostname, zone_id, zone_name }] }`, prompting before overriding an existing DNS record or another Worker's domain. https://github.com/cloudflare/workers-sdk/blob/main/packages/deploy-helpers/src/triggers/publish-routes.ts The single-domain `PUT /workers/domains` is sufficient for `furea`; surface the conflict error to the user rather than overriding.
- The token must also be able to see the zone (Zone Read), and the domain flow provisions DNS on the user's behalf (wrangler's template token includes DNS Edit). https://developers.cloudflare.com/fundamentals/api/reference/permissions/

### 4.3 Zone route

`POST /zones/{zone_id}/workers/routes` body `{ "pattern": "s.example.com/*", "script": "furea" }` (**Workers Routes Write**). https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/create/ A route does not create DNS: the hostname must already resolve to a proxied (orange-cloud) record, so it is a worse fit for a one-shot installer than a Custom Domain, which handles DNS and TLS itself. Routes matter only if the user wants path-scoped attachment (e.g. `example.com/s/*`).

---

## 5. Driving wrangler instead of reimplementing

### 5.1 Wrangler as a library — not viable for deploys

The documented programmatic surface is local-only: `createTestHarness`, `getPlatformProxy`, `experimental_generateTypes`, and the deprecated `unstable_dev` / `unstable_startWorker`. None deploys to Cloudflare. https://developers.cloudflare.com/workers/wrangler/api/ The deploy logic lives in an internal package (`@cloudflare/deploy-helpers`, https://github.com/cloudflare/workers-sdk/tree/main/packages/deploy-helpers) with no stability promise.

### 5.2 Spawning wrangler with a generated config — viable

- Global flags: `--config`/`-c` ("Path to Wrangler configuration file") and `--cwd` ("Run as if Wrangler was started in the specified directory instead of the current working directory"). https://developers.cloudflare.com/workers/wrangler/commands/general
- Relative paths in the config (`main`, `base_dir`, `assets.directory`, …) resolve against the config file's directory: `path.resolve(path.dirname(configPath), rawMain)` in `normalizeAndValidateMainField`. https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-utils/src/config/validation.ts So `furea` can write `wrangler.json` into a temp dir pointing at the files inside `node_modules/furea/dist` and pass `--config <tmp>/wrangler.json`; nothing lands in the user's cwd.
- Config keys needed: `name`, `main`, `compatibility_date`, `no_bundle: true`, `assets: { directory, binding, html_handling, not_found_handling, run_worker_first }`, `d1_databases: [{ binding, database_name, database_id, migrations_dir }]`, `kv_namespaces: [{ binding, id }]`, `routes: [{ pattern, custom_domain: true }]`, `workers_dev`. https://developers.cloudflare.com/workers/wrangler/configuration/
- `--no-bundle` / `no_bundle`: "Wrangler will not process your code and some features introduced by Wrangler bundling ... will not be available." Prebuilt single-file ESM is exactly this case. https://developers.cloudflare.com/workers/wrangler/bundling/
- Auth via env: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; `WRANGLER_SEND_METRICS=false`, `WRANGLER_LOG`. https://developers.cloudflare.com/workers/wrangler/system-environment-variables/
- Commands: `wrangler d1 create <NAME> [--location]`, `wrangler kv namespace create <NAMESPACE>` (prints the id; `--update-config` only helps when there is a real project config), `wrangler d1 migrations apply <DB> --remote`, `wrangler deploy --config ...`. https://developers.cloudflare.com/workers/wrangler/commands/d1/ , https://developers.cloudflare.com/workers/wrangler/commands/kv/ , https://developers.cloudflare.com/workers/wrangler/commands/workers/
- Costs: `wrangler@4.131.2` is 15.3 MB unpacked (`npm view wrangler dist.unpackedSize`) and pulls in miniflare/workerd; the official `cloudflare` REST SDK is 65 MB unpacked (`npm view cloudflare dist.unpackedSize`), so a hand-rolled `fetch` client is the lightest option for an `npx` tool. Wrangler's `create` commands print human-oriented output (ids must be scraped) and wrangler prompts interactively on custom-domain conflicts and D1 file imports (`confirm(...)` in `execute.ts` / `publish-routes.ts`), which a wrapper must pre-empt.

---

## 6. Free-plan limits relevant to a URL shortener

| Resource | Free | Paid | Source |
|---|---|---|---|
| Worker requests | 100,000 / day (resets 00:00 UTC; Error 1027 beyond) | 10 M / month included | https://developers.cloudflare.com/workers/platform/limits/ |
| Worker CPU | 10 ms / invocation | up to 5 min | same |
| Worker script size | 64 MiB uncompressed (both) | | same |
| Static asset requests | free and unlimited; `run_worker_first` matches count as Worker requests | | https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ |
| Static assets | 20,000 files / version, 25 MiB / file | same | https://developers.cloudflare.com/workers/platform/limits/ |
| D1 rows read | 5 M / day | 25 B / month included | https://developers.cloudflare.com/d1/platform/pricing/ |
| D1 rows written | 100,000 / day | 50 M / month included | same |
| D1 storage | 5 GB / account, 500 MB / database, 10 databases | 10 GB / database | https://developers.cloudflare.com/d1/platform/pricing/ , https://developers.cloudflare.com/d1/platform/limits/ |
| D1 queries per Worker invocation | 50 | 1,000 | https://developers.cloudflare.com/d1/platform/limits/ |
| KV reads | 100,000 / day | 10 M / month included | https://developers.cloudflare.com/kv/platform/pricing/ |
| KV writes / deletes / lists | 1,000 / day each | 1 M / month each | same |
| KV storage | 1 GB | unlimited | https://developers.cloudflare.com/kv/platform/limits/ |
| KV same-key write rate | 1 / s | same | same |

Implications for `furea`:

- Every redirect is one Worker request; 100 k/day is the hard ceiling on the free plan, and hitting it returns errors rather than degrading.
- Redirect lookups should be served from KV (100 k reads/day matches the request ceiling) with D1 as the source of truth, or from D1 with an indexed `slug` lookup (1 row read per hit). A full-table scan counts every row scanned, so an unindexed slug column would burn the 5 M/day budget fast. https://developers.cloudflare.com/d1/platform/pricing/
- Click counting must not write per hit: 100 k D1 writes/day and 1 k KV writes/day (and 1 write/s per KV key) rule out `UPDATE clicks = clicks + 1` on every redirect. Batched/aggregated counting is required.
- Link creation is cheap (a few rows written per link plus one per index), so 100 k writes/day is not a practical bound for creation.

---

## 7. Recommendation

**Reimplement the deploy path directly against the REST API with `fetch`; do not spawn or embed wrangler.**

Why:

1. The entire surface `furea` needs is about nine well-documented endpoints (D1 create/list/query, KV create/list, assets-upload-session, assets bulk upload, script PUT, workers.dev subdomain, custom domain PUT), all under the same bearer token. Each is in the public API reference cited above, and the two non-trivial protocols (assets upload session, migration bookkeeping) are small and stable.
2. Wrangler has no supported library API for deploying (§5.1). Spawning it works technically (§5.2) but costs a 15 MB dependency with native workerd binaries, output scraping for resource ids, interactive prompts to suppress, and coupling to wrangler's release cadence for a tool whose users never see wrangler.
3. Matching wrangler's on-the-wire conventions (`d1_migrations` table shape, blake3-based asset hashes) preserves interoperability: a user can later run `wrangler d1 migrations list --remote` or `wrangler deploy` on the same Worker without duplicate migrations or asset re-uploads.

Risks and mitigations:

- *API drift.* The multipart metadata and assets endpoints are versioned under `/client/v4` and documented; pin `compatibility_date` in the bundle and add an integration test that deploys to a throwaway account in CI.
- *Assets upload is stateful (JWTs expire after one hour, all buckets must succeed).* Retry with backoff like wrangler (5 attempts) and re-request the session on expiry.
- *Migration atomicity relies on D1 running one `/query` request as a transaction* (documented for batches; asserted by wrangler's own trimmer). Keep each migration under the 100 KB statement limit and idempotent where cheap (`IF NOT EXISTS`), and record the migration name in the same request as the DDL.
- *Custom Domain conflicts* (existing DNS record, another Worker) surface as API errors; report them and offer `workers.dev` as a fallback instead of auto-overriding.
- *Token scope.* Document the required permissions: Workers Scripts Edit, Workers KV Storage Edit, D1 Edit, Zone Read, DNS Edit (custom domain), Workers Routes Edit only if zone routes are supported. https://developers.cloudflare.com/fundamentals/api/reference/permissions/
- *Free-plan ceilings* are product constraints, not deploy constraints; the data model must avoid per-hit writes (§6).

Fallback: if the API path proves brittle, `wrangler --config <tmpdir>/wrangler.json deploy --no-bundle` with wrangler as an optional dependency is a viable escape hatch and still needs no wrangler.toml in the user's project.
