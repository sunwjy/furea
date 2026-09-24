---
status: accepted
date: 2026-09-24
---

# Observability: Workers Logs on without invocation logs, a quiet Worker, `furea logs` as a live tail

furea v1 gives an operator three ways to see what an instance is doing wrong: **Workers Logs** holding only the few structured events the Worker chooses to write, **`npx furea logs`** streaming live traffic through Cloudflare's tail API, and **`npx furea status`** reporting sync-pending links and observability drift. Per-request logs are never persisted, nothing IP-derived reaches any log, and no new token permission is needed.

Decided in [Decide: observability for an installed instance](https://github.com/sunwjy/furea/issues/25), from [`docs/research/workers-observability.md`](../research/workers-observability.md).

## Deploy declares observability explicitly

Every `deploy` sends this object in the script upload metadata, so the state never depends on Cloudflare's undocumented default for API-created Workers and a dashboard change is reverted on the next run (ADR 0006's declarative redeploy):

```json
"observability": {
  "enabled": true,
  "head_sampling_rate": 1,
  "logs": { "enabled": true, "invocation_logs": false, "persist": true },
  "traces": { "enabled": false },
  "redact_query_string": true
}
```

- **Invocation logs off.** An invocation log carries request headers (including `cf-connecting-ip`) and `cf` location data, which Cloudflare's redaction does not remove, and on Free it would spend half the 200,000 events/day quota at the 100,000 requests/day ceiling. With it off, the quota is spent only on what the Worker writes.
- **Traces off explicitly.** From 2026-10-01 spans count against the same quota, and Cloudflare plans to turn tracing on automatically when `observability.enabled` is true.
- **No opt-in for per-request logs.** The CLI keeps no local instance state, so a `--request-logs` flag would silently revert on the next plain `deploy`; the live tail covers per-request debugging without storing anything.

## What the Worker logs

The redirect path logs **nothing** when it succeeds. Everything else is one structured JSON object per event (`console.error` for failures, `console.warn` for the rest), with an `event` field:

| `event` | When | Fields besides `event` |
|---|---|---|
| `unhandled_error` | An exception escapes a handler | route kind (`redirect`, `api`, `admin`, `cron`), message, stack |
| `cache_sync_failed` | A KV write still fails after three retries and the link becomes sync pending (ADR 0004) | slug |
| `cache_repair` | A repair pass (cron or write-request tail) repaired or failed at least one link; a pass with nothing to do logs nothing | repaired count, failed count |
| `redirect_fallback_failed` | The D1 fallback on a redirect-cache miss fails | slug |
| `click_write_failed` | The WAE data point or the D1 `click_count` increment fails | slug, store (`wae` or `d1`) |
| `login_rate_limited` | A login attempt is refused by a rate limiter (ADR 0003) | limiter (`per_client` or `global`) |
| `screening_overridden` | A session saved a flagged destination with `"screening": "skip"` (ADR 0013) | slug (or `_` for the root destination) |
| `screening_unavailable` | The screening lookup failed and the write proceeded (ADR 0013) | slug when known |

Field rules: a **slug may appear** (it is the operator's own data and not visitor-derived). A **destination never appears**, because it may carry secrets in its query. **No request header, IP address or value derived from either** ever appears. Failed logins that are not rate-limited are not logged.

## `npx furea logs`

A live tail through `POST /accounts/{account_id}/workers/scripts/{name}/tails` and its `trace-v1` WebSocket, authorised by the deploy token's Workers Scripts Edit. It shows only what happens while it is connected and spends no Workers Logs quota.

- Each line shows the time, outcome, method, path with the query string removed, and the Worker's own log lines and exceptions. Request headers, the client IP and `cf` fields are **dropped before printing**; there is no `--raw` mode.
- `--errors` keeps only events whose outcome is not `ok` or that carry an exception (tail `outcome` filter). `--json` prints one JSON object per line with the same fields.
- The CLI recreates the tail when it reaches `expires_at` (the backend just stops delivering), and deletes it on exit.
- If Cloudflare's limit of 10 concurrent viewers is reached, the CLI says so and exits.

Past logs are viewed in the Cloudflare dashboard (Workers & Pages → the instance → Observability); `logs` prints that pointer.

## `npx furea status`

Adds two checks to ADR 0006's drift report, both counted as "something is wrong" (non-zero exit):

- the number of links in **sync pending**, read with a D1 query through the deploy token (D1 Edit);
- the script's observability settings differing from the object above.

The admin surface gains nothing new: its sync-pending badge, notice and Retry now (prototype variant F) already cover the operator's question. No "last repair" timestamp is kept, since it would add one D1 write every five minutes for no decision the operator makes.

## Considered options

1. **Workers Logs with invocation logs off, curated Worker events, live tail in the CLI** (chosen).
2. Invocation logs on. Rejected: persists IP-bearing request metadata in the operator's account for three days and spends half the Free quota.
3. Workers Logs off. Rejected: an operator would lose the only record of cron repairs and unhandled errors outside a live tail.
4. `logs --since` / `status` showing past errors through the telemetry query API. Rejected for v1: it needs *Workers Observability Write*, absent from the deploy token template and without a documented token-UI name; the dashboard covers the need.
5. Tail Workers, Logpush, OpenTelemetry export, or an external error reporter (Sentry and the like). Rejected: the first three are paid-only, and a reporter adds a third-party account, a DSN setting and bundle weight to a Free-first product.

## Consequences

- ADR 0005's no-IP guarantee extends to Cloudflare-side storage that furea configures (amended there).
- ADR 0006 gains the `logs` command and the two `status` checks (amended there); the deploy token template is unchanged.
- The Worker needs one small logging module that only accepts the fields above, so a slug-only, header-free log line is enforced in one place and unit-testable.
- The Workers Logs Free quota is effectively never at risk: only failure events are written.
