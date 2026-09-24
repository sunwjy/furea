# Workers observability through the API deploy path

Research for issue #24 (part of #1). Date: 2026-09-23.

**Question.** What observability can a furea instance have on a **Workers Free** plan when `npx furea` deploys it with a multipart `PUT /accounts/{account_id}/workers/scripts/{script_name}` (ADR 0006), not wrangler? Specifically: how Workers Logs is switched on in the upload `metadata`, whether it is free and with what retention and daily limits, whether logs can be queried over the REST API (so `furea logs` / `furea status` could show recent errors) and with which token permission, what `wrangler tail` does under the hood and whether furea can do the same with the deploy token, and whether Logpush and Tail Workers are paid-only.

Sources are primary only: developers.cloudflare.com (product docs and API reference) and `cloudflare/workers-sdk` on GitHub at commit `d497270b2b5362dbaf9b9b51716c5a8ecd94413d` (`main`, 2026-09-23). Each claim carries its URL.

---

## Summary

| Capability | Workers Free? | Through the REST API? | Permission | furea deploy token covers it? |
|---|---|---|---|---|
| Workers Logs (persisted, queryable) | Yes. 200,000 events/day, 3-day retention | Enable: `metadata.observability`. Query: `POST .../workers/observability/telemetry/query` | Enable: Workers Scripts Write. Query: **Workers Observability Write** | Enable: yes. Query: **no** |
| Real-time logs (`wrangler tail`) | Yes (no plan restriction documented); max 10 concurrent viewers | `POST .../workers/scripts/{name}/tails` → WebSocket URL | Workers Tail Read **or** Workers Scripts Write | **Yes** |
| Tail Workers | **No**, Paid and Enterprise only | `tail_consumers` in metadata | Workers Scripts Write | n/a |
| Workers Trace Events Logpush | **No**, Paid only | `logpush: true` + Logpush job | Logs Edit | n/a |
| OpenTelemetry export (logs/traces) | **No**, "Not available" on Free | `observability.logs.destinations` | Workers Observability (destinations API) | n/a |
| Traces | Beta, free until 2026-10-01, then counted against the same Workers Logs quota on Free | `observability.traces` | Workers Scripts Write | yes |

---

## 1. Enabling Workers Logs in the upload metadata

### 1.1 Wrangler config vs. API metadata

Wrangler's documented config is:

```jsonc
{ "observability": { "enabled": true, "head_sampling_rate": 1 } }
```

`head_sampling_rate` is optional, 0–1, default 1. https://developers.cloudflare.com/workers/observability/logs/workers-logs/#enable-workers-logs

Wrangler passes the `observability` config object through to the upload metadata unchanged: `create-worker-upload-form.ts` spreads `...(observability && { observability })` into the metadata part, and `deploy.ts` sets `observability: config.observability`. https://github.com/cloudflare/workers-sdk/blob/d497270b2b5362dbaf9b9b51716c5a8ecd94413d/packages/deploy-helpers/src/deploy/helpers/create-worker-upload-form.ts, https://github.com/cloudflare/workers-sdk/blob/d497270b2b5362dbaf9b9b51716c5a8ecd94413d/packages/deploy-helpers/src/deploy/deploy.ts

So the same snake_case object goes into the `metadata` JSON part of the multipart `PUT /accounts/{account_id}/workers/scripts/{script_name}` (required permission: Workers Scripts Write). The API reference documents the metadata field as:

| Field | Type | Meaning |
|---|---|---|
| `observability.enabled` | boolean (required when object present) | "Whether observability is enabled for the Worker." |
| `observability.head_sampling_rate` | number, optional | "From 0 to 1 (1 = 100%, 0.1 = 10%). Default is 1." |
| `observability.logs.enabled` | boolean | "Whether logs are enabled for the Worker." |
| `observability.logs.invocation_logs` | boolean | Whether invocation logs (one per request) are emitted |
| `observability.logs.head_sampling_rate` | number, optional | Log-specific sampling rate |
| `observability.logs.persist` | boolean, optional | "Whether log persistence is enabled" (wrangler type: default `true`) |
| `observability.logs.destinations` | string[], optional | OTel export destinations (Paid only, §5) |
| `observability.redact_query_string` | boolean, optional | "Whether query strings are removed from request URLs in logs and traces." |
| `observability.issues.enabled` | boolean, optional | Real-time Issues |
| `observability.traces.{enabled, head_sampling_rate, persist, destinations, propagation_policy}` | | Tracing (§5) |

https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/ ; wrangler's type with defaults: https://github.com/cloudflare/workers-sdk/blob/d497270b2b5362dbaf9b9b51716c5a8ecd94413d/packages/workers-utils/src/config/environment.ts

Invocation logs can be switched off with `observability.logs.invocation_logs = false`, leaving only `console.*` output and exceptions. https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs

### 1.2 Observability is a non-versioned setting; send it explicitly on every deploy

When wrangler uses the Versions API path (existing module Worker, no DO migrations), it uploads the version and then calls `PATCH /accounts/{account_id}/workers/scripts/{script_name}/script-settings` with `tail_consumers`, `logpush` and `observability`. Its comment: "If the user hasn't specified observability assume that they want it disabled if they have it on … will remove observability if it has been removed from their Wrangler configuration file", sending `worker.observability ?? { enabled: false }`. https://github.com/cloudflare/workers-sdk/blob/d497270b2b5362dbaf9b9b51716c5a8ecd94413d/packages/deploy-helpers/src/deploy/deploy.ts, https://github.com/cloudflare/workers-sdk/blob/d497270b2b5362dbaf9b9b51716c5a8ecd94413d/packages/deploy-helpers/src/deploy/helpers/versions-api.ts

The Workers Logs page says "All newly created Workers will come with the observability setting enabled by default", but does not say whether that applies to a Worker created by a bare API `PUT` without the field. https://developers.cloudflare.com/workers/observability/logs/workers-logs/

Implication for furea: always include an explicit `observability` object in the `PUT` metadata (as `cloudflare-api-deploy.md` §3 already sketches), so the state is deterministic across installs and upgrades, and never depends on an undocumented default. Settings changed later in the dashboard will be overwritten on the next `npx furea` run; that is consistent with ADR 0006's declarative redeploy.

### 1.3 Free-plan availability, retention and limits

"Workers Logs is included in both the Free and Paid Workers plans." https://developers.cloudflare.com/workers/platform/pricing/#workers-logs

| | Log events written | Retention |
|---|---|---|
| Workers Free | 200,000 per day | 3 days |
| Workers Paid | 20 million/month included, +$0.60/million | 7 days |

(same table on https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing)

Other limits (https://developers.cloudflare.com/workers/observability/logs/workers-logs/#limits, https://developers.cloudflare.com/workers/platform/limits/#log-size):

- Max 5 billion logs per account per day; beyond that "a 1% head-based sample will be applied for the remainder of the day".
- 256 KB of log data per request (all `console.log`, exceptions, request metadata and headers together); a log over the size is truncated and `$cloudflare.truncated` is set.
- The docs do **not** state what happens on Free after 200,000 events in a day (dropped, sampled, or anything else). Treat as an open question (§8).

### 1.4 `console.log` volume and cost

- Each invocation produces one invocation log (unless `invocation_logs: false`), and each `console.log` is another event. The billing examples count "1 invocation log and 1 `console.log`" as 2 events per request. https://developers.cloudflare.com/workers/observability/logs/workers-logs/#examples
- Workers Free allows 100,000 requests/day. https://developers.cloudflare.com/workers/platform/pricing/ With invocation logs on and `head_sampling_rate: 1`, a Free instance at the request ceiling uses 100,000 of its 200,000 log events on invocation logs alone, leaving on average one `console.*` line per request. Logging nothing on the happy redirect path and logging only on error/unexpected paths keeps a Free instance well inside the quota.
- On Free there is no money cost; the only cost is the quota. On Paid, 20M events/month are included and overage is $0.60/million.
- Cloudflare recommends logging JSON objects (`console.log({ ... })`) so fields are indexed and filterable. https://developers.cloudflare.com/workers/observability/logs/workers-logs/#logging-structured-json-objects

### 1.5 Privacy (ADR 0005)

- Invocation logs contain request and response metadata and are "enriched with information available to Cloudflare in the context of the invocation". https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs
- The tail event shape (shared by real-time logs and Tail Workers) includes `event.request.headers` and `event.request.cf`. Header redaction only covers `cookie`/`set-cookie` and names containing `auth`, `key`, `secret`, `token`, `jwt`, and URL redaction replaces hex/base64-looking ID substrings. https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/ Headers such as `cf-connecting-ip` and the `cf` geolocation fields are not in the redaction list.
- Consequence: with invocation logs on, the operator's Cloudflare account likely keeps IP-derived request metadata for up to 3 days (Free). That is Cloudflare-side storage in the operator's own account, not furea's database, but ADR 0005's "nothing IP-derived stored" should say explicitly whether it covers this. Setting `observability.logs.invocation_logs: false` and logging only curated `console.error({...})` objects avoids it while keeping error visibility. Which fields actually persist in Workers Logs was not verified (§8).
- `redact_query_string: true` strips query strings from logged URLs; useful because UTM parameters on short links reach the Worker.

---

## 2. Querying Workers Logs through the REST API

The dashboard's Query Builder is backed by a public API: "You can also run the same queries programmatically using the Workers Observability REST API, which exposes endpoints to list dataset keys, run a query, and list the values for a key." https://developers.cloudflare.com/workers/observability/query-builder/

Endpoints (https://developers.cloudflare.com/api/resources/workers/subresources/observability/):

| Endpoint | Purpose | Accepted permissions |
|---|---|---|
| `POST /accounts/{account_id}/workers/observability/telemetry/query` | Run a query | Workers Observability Write |
| `POST .../workers/observability/telemetry/keys` | List keys | Workers Observability Write |
| `POST .../workers/observability/telemetry/values` | List values for a key | Workers Observability Write |
| `POST .../workers/observability/telemetry/live-tail` (+ `/heartbeat`) | Dashboard live tail | Workers Observability Write |
| `GET .../workers/observability/queries` | List saved queries | Workers Observability Write or Read |

Permissions are taken from each method page, e.g. https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/ . The telemetry endpoints accept only **Write**, even though they read.

Query body (same page):

- `queryId` (required): a saved query id, or "any identifier (e.g. an ad-hoc ID)" when `parameters` is given inline.
- `timeframe: { from, to }` (required), Unix ms.
- `view`: `"events"` (individual log lines), `"calculations"` (aggregates with group-by and time series), `"invocations"` (events grouped by request id), `"traces"`, `"agents"`.
- `limit`: max events for `view: "events"`, maximum 2000. `offset` is a cursor (`$metadata.id` of the last event).
- `parameters`: `datasets`, `filters` (key/operation/type/value, nestable groups with `and`/`or`), `filterCombination`, `calculations`, `groupBys`, `needle` (full-text search, optional regex), and more.
- `dry: true` runs without persisting the query run.

A `furea logs --errors` style query would be: `view: "events"`, last N hours, a filter on the Worker name and on level/outcome (exact key names come from `telemetry/keys`; not verified here), `limit` ≤ 2000.

**Token.** The deploy token template in ADR 0006 (Workers Scripts Edit, Workers KV Storage Edit, D1 Edit, Zone Read, DNS Edit) does **not** include Workers Observability, so the deploy token cannot query logs. Adding "Workers Observability Write" (probably shown as "Edit" in the token UI) would be needed. The public permission list at https://developers.cloudflare.com/fundamentals/api/reference/permissions/ does not list a Workers Observability group at all on the date above, even though the API reference names it; its UI name and whether it can be put in a token template URL need checking (§8). The wrangler OAuth default scopes (see `cloudflare-cli-auth.md`) contain `workers_tail:read` but no observability scope.

---

## 3. Real-time logs: what `wrangler tail` does

From `packages/wrangler/src/tail/createTail.ts`, `index.ts` and `filters.ts` (https://github.com/cloudflare/workers-sdk/tree/d497270b2b5362dbaf9b9b51716c5a8ecd94413d/packages/wrangler/src/tail):

1. `POST /accounts/{account_id}/workers/scripts/{script_name}/tails` with JSON body `{ "filters": [...] }` (the `TailFilterMessage`). Filters: `sampling_rate`, `outcome[]`, `method[]`, `header {key, query?}`, `client_ip[]`, `query` (text search), script version. Response `result: { id, url, expires_at }`.
2. Open a WebSocket to `result.url` with subprotocol `trace-v1` (`"Sec-WebSocket-Protocol": "trace-v1"`, "needs to be `trace-v1` to be accepted"). No `Authorization` header is sent on the WebSocket: the URL itself is the capability.
3. On open, send `{"debug": false}`. Each message is a JSON trace event (`outcome`, `scriptName`, `exceptions[]`, `logs[]`, `eventTimestamp`, `event.request {url, method, headers, cf}`), the same shape documented at https://developers.cloudflare.com/workers/observability/logs/real-time-logs/.
4. Client pings every 10 s (`PING_INTERVAL_MS = 10_000`). The tail has an `expires_at`; wrangler's comment: "The tail backend does not actively close this WebSocket when the expiration time is reached — log delivery just stops" (issue cloudflare/workers-sdk#14427), so a long-running client must recreate the tail itself.
5. On exit, `DELETE /accounts/{account_id}/workers/scripts/{script_name}/tails/{id}`.

API reference for the two REST calls: https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/tail/methods/create/ and https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/tail/methods/delete/ . Both accept **Workers Tail Read or Workers Scripts Write**. The permissions page describes Workers Tail Read as "Grants `wrangler tail` read permissions." https://developers.cloudflare.com/fundamentals/api/reference/permissions/

**So a third-party CLI can open a tail with an API token, and furea's existing deploy token (Workers Scripts Edit = Write) is sufficient.** Implementation needs only `fetch` plus a WebSocket client. Node 22+ has a global `WebSocket` whose constructor takes the `trace-v1` subprotocol, but it cannot set custom headers such as `User-Agent`; wrangler uses the `ws` package, which can. Whether the tail endpoint requires a `User-Agent` was not tested.

Limits (https://developers.cloudflare.com/workers/observability/logs/real-time-logs/#limits):

- No plan restriction is mentioned; real-time logs are available on Free.
- Real-time logs are not stored; they cover only what happens while connected.
- "A maximum of 10 clients can view a Worker's logs at one time", dashboard sessions and `wrangler tail` combined.
- High traffic may put the tail into sampling mode (messages dropped, with a warning).
- Not available for zones on the China Network.

Real-time logs do not require `observability.enabled`; they are independent of Workers Logs persistence.

---

## 4. Tail Workers and Logpush are paid-only

- Tail Workers: "Tail Workers are available to all customers on the Workers Paid and Enterprise tiers." Billed by CPU time. https://developers.cloudflare.com/workers/observability/logs/tail-workers/
- Workers Trace Events Logpush: "This product is available on the Workers Paid plan." Pricing: 10M requests/month included, +$0.05/million; "Workers Logpush is only available on the Workers Paid plan." Setting it up also needs a Logpush job and a token with Logs Edit. https://developers.cloudflare.com/workers/observability/logs/logpush/, https://developers.cloudflare.com/workers/platform/pricing/#workers-trace-events-logpush

Neither is usable on Free. Both are also Cloudflare's "advanced" options; Cloudflare now points new integrations to OpenTelemetry export instead.

## 5. OpenTelemetry export and traces

- OTel export (`observability.logs.destinations` / `traces.destinations`): Workers Free "Not available" for both traces and logs. Paid: 10M events/month included each, $0.05/million after. https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/#limits-and-pricing
- Traces: free during beta; "Starting on October 1, 2026, tracing will be billed … Each span in a trace represents one observability event, sharing the same monthly quota and pricing as Workers logs", i.e. on Free spans eat into the 200,000/day. https://developers.cloudflare.com/workers/observability/traces/ The same page says Cloudflare plans to enable automatic tracing when `observability.enabled = true`; furea should leave `traces.enabled` unset or `false` so a future default does not consume the Free log quota.

---

## 6. What furea can build, per option

| Option | Free plan | Extra credential | Notes |
|---|---|---|---|
| A. Enable Workers Logs at deploy, point the operator to the dashboard (Workers & Pages → furea → Observability) | Yes | None | Zero CLI work. 3-day history. |
| B. `npx furea logs` = live tail over the tail API | Yes | None (deploy token has Workers Scripts Edit) | Shows only live traffic; useful right after an install or upgrade ("hit the URL now and watch"). Counts toward the 10-viewer cap. |
| C. `npx furea logs --since 1h` / `furea status` recent errors = telemetry query API | Yes (reads Workers Logs) | **Workers Observability Write** on a token | Needs the deploy token template to grow a permission, or a separate token like the analytics token. |
| D. Tail Workers / Logpush / OTel export | No | | Out of scope for a Free-first product. |

## 7. Recommendation

1. Always send an explicit object in the deploy metadata:
   ```json
   "observability": {
     "enabled": true,
     "head_sampling_rate": 1,
     "logs": { "enabled": true, "invocation_logs": false, "persist": true },
     "redact_query_string": true
   }
   ```
   With `invocation_logs: false`, the Free quota is spent only on what furea chooses to log, and no IP-bearing request metadata is persisted by default. If the operator wants per-request logs for debugging, a flag (e.g. `--request-logs`) can flip `invocation_logs` to `true` on the next deploy. Keep the Worker quiet on the redirect hot path: log only errors and unexpected states as structured JSON (`console.error({ event, slug, err })`), never IPs.
2. Ship **option B** (`furea logs` as a live tail) first: it works on Free with the existing deploy token, has no quota impact, and needs only two REST calls plus a WebSocket.
3. Defer **option C**. It is the only way to show past errors from the CLI, but it requires a new token permission whose UI name is not yet documented. If added later, put Workers Observability in the deploy token template rather than a third credential, since querying is an operator action done from the CLI where the deploy token already lives.
4. Do not plan on Tail Workers, Logpush or OTel export; they are paid-only.

## 8. Open questions (verify with a probe on a Free account)

1. What happens on Free after 200,000 log events in a day (dropped, sampled, or Worker unaffected but logs lost)? Not documented.
2. Does a Worker created by a bare `PUT` without `observability` get Workers Logs enabled by default? (Moot if furea always sends the field.)
3. The exact token-UI name of the "Workers Observability" permission group (`GET /accounts/{account_id}/tokens/permission_groups` or `GET /user/tokens/permission_groups`), and whether it can be pre-filled in a token template URL.
4. Which request fields (headers, `cf` geolocation, client IP) appear in persisted invocation logs, and whether `invocation_logs: false` removes all of them.
5. Exact telemetry keys for filtering by Worker name and by error level/outcome (call `telemetry/keys` once against a real instance).
