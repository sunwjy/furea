# Research: Workers Analytics Engine for click analytics

Issue: sunwjy/furea#4 (part of #1, blocks #9). Date: 2026-09-14.

Question: is Workers Analytics Engine (WAE) suitable for per-link click analytics in furea, a self-hosted URL shortener on Workers/D1/KV that is installed into an individual's or small company's own Cloudflare account, often on the Workers Free plan? Each redirect records one click (slug, country, referrer, device class; never raw IP) and the admin dashboard shows per-link totals and time series.

All claims below are from Cloudflare primary sources (developers.cloudflare.com, the Cloudflare API reference, blog.cloudflare.com for announcements only). The URL is next to each claim.

## Summary

| Topic | Finding |
|---|---|
| Free plan | Yes. Workers Free: 100,000 data points written/day, 10,000 read queries/day. Workers Paid: 10M writes/month + $0.25/M, 1M reads/month + $1.00/M. Not billed at all today. |
| Per data point | Up to 20 blobs (strings), 20 doubles, 1 index. Blobs max 16 KB total per data point; index max 96 bytes. 250 `writeDataPoint` calls per Worker invocation. |
| Sampling | Applied at write time (too many points into one index too fast) and at query time (query too complex). Counts must be computed as `sum(_sample_interval)` and are approximations, not exact. |
| Retention | 3 months. |
| SQL API | `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql`, Bearer API token with `Account > Account Analytics > Read`. Callable from a Worker with `fetch()` at request time. No documented latency figure. |
| Binding | Wrangler `analytics_engine_datasets = [{ binding, dataset }]`; script-upload metadata binding `type: "analytics_engine"` with `name` and `dataset`. |
| D1 comparison | D1 Free: 100k rows written/day, 5M rows read/day, 500 MB per DB. Exact counts, unlimited retention, but aggregations scan rows and each DB processes queries sequentially. |

## 1. Plan availability and cost

- The WAE pricing page has two columns, "Workers Free" and "Workers Paid". Workers Free includes "100,000 included per day" data points written and "10,000 included per day" read queries. Workers Paid includes "10 million included per month" data points written (+$0.25 per additional million) and "1 million included per month" read queries (+$1.00 per additional million). https://developers.cloudflare.com/analytics/analytics-engine/pricing/
- "Currently, you will not be billed for your use of Workers Analytics Engine." Pricing is published in advance so you can estimate; billing has not started. https://developers.cloudflare.com/analytics/analytics-engine/pricing/
- A "data point written" is one `writeDataPoint()` call; a "read query" is one POST to the SQL API. Query complexity and result size do not change the cost, and there is no extra charge for more dimensions or cardinality. https://developers.cloudflare.com/analytics/analytics-engine/pricing/
- GA was announced on 2024-04-01 with the same free/paid allowances. https://blog.cloudflare.com/making-full-stack-easier-d1-ga-hyperdrive-queues/

Implication for furea: on a free account one click is one data point, so 100k clicks/day is the write ceiling. That is the same number as the Workers Free request limit of 100,000 requests/day (https://developers.cloudflare.com/workers/platform/pricing/), so WAE writes will never be the first thing to run out. 10,000 dashboard queries/day is ample for a single admin.

## 2. Write and per-data-point limits

From https://developers.cloudflare.com/analytics/analytics-engine/limits/ :

- "Analytics Engine will accept up to twenty blobs, twenty doubles, and one index per call to `writeDataPoint`".
- Blobs: 16 KB maximum total size per data point.
- "Each index must not be more than 96 bytes".
- "You can write a maximum of 250 data points per Worker invocation".

From https://developers.cloudflare.com/analytics/analytics-engine/get-started/ :

- "While the `indexes` field accepts an array, you currently must only provide a single index. If you attempt to provide multiple indexes, your data point will not be recorded."
- `writeDataPoint()` returns immediately and the runtime writes in the background; you do not need to `await` it.

Suggested data point shape for furea (well within the limits):

```js
env.CLICKS.writeDataPoint({
  indexes: [slug],                                   // <= 96 bytes; the sampling key
  blobs: [slug, country, refererHost, deviceClass],  // blob1..blob4
  doubles: [1],                                      // double1 = 1 click
});
```

Using the slug as the index matters: WAE samples per index value, so one viral link cannot cause the other links' clicks to be sampled away (section 3).

## 3. Sampling and its effect on exact counts

From https://developers.cloudflare.com/analytics/analytics-engine/sampling/ :

- "At write time, we sample if data points are written too quickly into one index." Sampling happens again at query time "if the query is too complex".
- Every row carries `_sample_interval` (inverse of the sample rate; a 1% sample gives 100). It varies per row.
- Correct aggregations: count events with `sum(_sample_interval)` instead of `count()`; sums with `sum(x * _sample_interval)`; averages with `sum(x * _sample_interval) / sum(_sample_interval)`; quantiles with `quantileExactWeighted(0.5)(x, _sample_interval)`.
- Sampling is "equitable": for infrequent index values "we may write all of the data points", while high-volume index values are sampled more heavily.

From https://developers.cloudflare.com/analytics/analytics-engine/recipes/usage-based-billing-for-your-saas-product/ :

- Cloudflare's own guidance for billing use cases is to use the customer id as the index so each customer is sampled independently, to run "one query per customer" to reduce sampling, and it describes the result as "a reliable approximation of usage", not an exact figure.

Practical effect: at the volumes a personal or small-company shortener sees, most links will be stored unsampled and `sum(_sample_interval)` equals the true count. But WAE never guarantees exact counts; a link that gets a burst of traffic will have an estimated count. The dashboard should label the number as an estimate, or furea must keep an exact counter elsewhere (section 8).

The sampling page does not state the write-rate threshold, so it cannot be predicted in advance.

## 4. Data retention

- "Data written to Workers Analytics Engine is stored for three months". https://developers.cloudflare.com/analytics/analytics-engine/limits/

This is a fixed product property; no configuration or paid extension is documented. Per-link lifetime totals therefore cannot come from WAE alone once a link is older than 90 days.

## 5. SQL API

- Endpoint: `https://api.cloudflare.com/client/v4/accounts/<account_id>/analytics_engine/sql`, `POST` with the SQL statement as the request body and `Authorization: Bearer <token>`. https://developers.cloudflare.com/analytics/analytics-engine/sql-api/
- Token permission: a custom API token with `Account | Account Analytics | Read`. https://developers.cloudflare.com/analytics/analytics-engine/sql-api/ and https://developers.cloudflare.com/analytics/analytics-engine/get-started/
- The table is created automatically on first write; columns are `dataset`, `timestamp`, `_sample_interval`, `index1`, `blob1..blob20`, `double1..double20`. https://developers.cloudflare.com/analytics/analytics-engine/sql-api/
- Supported statement: `SELECT ... [FROM] [WHERE] [GROUP BY] [HAVING] [ORDER BY] [LIMIT n|ALL] [FORMAT JSON|JSONEachRow|TabSeparated]` (JSON is the default), plus `SHOW TABLES`. No maximum row count or maximum time range is documented. https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/statements/
- Time bucketing for series: `toStartOfInterval(timestamp, INTERVAL '1' HOUR[, tz])`, `toStartOfDay`, `toStartOfHour`, `toStartOfFifteenMinutes`, `toStartOfMinute`, `now()`, `toDateTime(expr[, tz])`. https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/date-time-functions/
- Calling from a Worker at request time: documented and supported. The Worker uses plain `fetch()` to the endpoint, with the account id as an env var and the token as a secret. https://developers.cloudflare.com/analytics/analytics-engine/worker-querying/
- Latency: no numeric latency figure is documented on developers.cloudflare.com. The open-beta announcement only says the ABR design makes "queries always respond within the window of interactivity". https://blog.cloudflare.com/analytics-engine-open-beta/ Treat it as an interactive external HTTP call (hundreds of milliseconds), not a sub-10 ms binding call.
- Per-request considerations on Workers Free: each SQL call is one of the 50 subrequests per request, and at most 6 connections can be waiting for response headers at once. https://developers.cloudflare.com/workers/platform/limits/

Example dashboard queries:

```sql
-- per-link totals, last 30 days
SELECT index1 AS slug, sum(_sample_interval) AS clicks
FROM furea_clicks
WHERE timestamp > NOW() - INTERVAL '30' DAY
GROUP BY slug ORDER BY clicks DESC LIMIT 100

-- daily series for one link
SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day,
       sum(_sample_interval) AS clicks
FROM furea_clicks
WHERE index1 = 'abc123' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day ORDER BY day

-- breakdown
SELECT blob2 AS country, sum(_sample_interval) AS clicks
FROM furea_clicks WHERE index1 = 'abc123' GROUP BY country ORDER BY clicks DESC
```

There is no runtime binding for reads: the Worker needs a stored API token, which is an extra installation step for a self-hosted product (the user must create a token with Account Analytics Read and store it as a secret). Writes need no token.

## 6. Binding the dataset

Wrangler config (both formats), https://developers.cloudflare.com/workers/wrangler/configuration/ :

```jsonc
{ "analytics_engine_datasets": [ { "binding": "CLICKS", "dataset": "furea_clicks" } ] }
```

```toml
[[analytics_engine_datasets]]
binding = "CLICKS"
dataset = "furea_clicks"   # optional; defaults to the binding name
```

Script upload API metadata (for installers that upload the Worker via the API rather than Wrangler), https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/ :

```json
{ "type": "analytics_engine", "name": "CLICKS", "dataset": "furea_clicks" }
```

No dataset has to be created beforehand; the table appears on the first write. https://developers.cloudflare.com/analytics/analytics-engine/sql-api/

## 7. Comparison with click rows in D1

| | Workers Analytics Engine | D1 |
|---|---|---|
| Free write allowance | 100k data points/day (https://developers.cloudflare.com/analytics/analytics-engine/pricing/) | 100k rows written/day; each index on the table adds one more row written per insert (https://developers.cloudflare.com/d1/platform/pricing/) |
| Free read allowance | 10k SQL queries/day, independent of rows scanned | 5M rows read/day; an aggregation scans every candidate row, so `SELECT count(*) ... WHERE slug = ?` over a large table without a suitable index costs the whole scan (https://developers.cloudflare.com/d1/platform/pricing/) |
| Paid overage | $0.25/M writes, $1.00/M read queries | $1.00/M rows written, $0.001/M rows read, $0.75/GB-month (https://developers.cloudflare.com/d1/platform/pricing/) |
| Storage cap | n/a | 500 MB per DB on Free, 10 GB on Paid (https://developers.cloudflare.com/d1/platform/limits/) |
| Retention | 3 months, fixed | Unlimited (until the storage cap) |
| Exactness | Approximate under sampling | Exact |
| Write path | Non-blocking `writeDataPoint()` inside the redirect; no await | `INSERT` is a query (counts against 50 queries/invocation on Free), and a single DB processes queries sequentially, so write throughput is bounded by query latency (https://developers.cloudflare.com/d1/platform/limits/) |
| Read path | External HTTPS call from the Worker with an API token | Binding call, no token |
| Time series / breakdowns | Native (`toStartOfInterval`, `GROUP BY blob`) | Full scans, or pre-aggregated rollup tables maintained by furea |
| Setup burden on the installing user | Extra API token for the dashboard | None beyond the D1 furea already needs |

The free write allowance is the same number on both products, so neither is "more free" for writes. D1's cost problem is on reads: one dashboard page showing totals for 50 links over 30 days with per-day series and country breakdowns would, without careful rollup tables, scan the click table several times. One row per click plus an index on `(slug, ts)` also doubles the rows-written cost, and the click table becomes the largest thing in the 500 MB free database.

## 8. Recommendation for furea

Default: **Workers Analytics Engine for click events, plus an exact lifetime counter per link in D1.**

- On every redirect: `env.CLICKS.writeDataPoint({ indexes: [slug], blobs: [slug, country, refererHost, deviceClass], doubles: [1] })` (no await), and increment `links.click_count` in D1 (`UPDATE links SET click_count = click_count + 1 WHERE slug = ?`). The D1 update is one row written per click, still within the 100k/day free allowance, and gives an exact all-time total that survives the 90-day WAE window. If the redirect latency budget is tight, run the counter update in `ctx.waitUntil`.
- Dashboard: totals come from D1 (`click_count`, exact, lifetime); the last-90-days time series and the country/referrer/device breakdowns come from WAE via the SQL API, always using `sum(_sample_interval)` and labelled "last 90 days".
- Never write raw IP or full URLs into blobs; store only the referrer host and a coarse device class, matching the privacy requirement in the issue.

Trade-offs the installing user should know:

1. 90-day window. Breakdowns and time series older than three months disappear. Lifetime totals are kept in D1 only.
2. Estimated, not exact, when a link is hot. WAE may sample writes for a slug that receives a burst; `sum(_sample_interval)` extrapolates and can be off. The D1 counter is the source of truth for the total.
3. Extra credential. Reading WAE requires an API token with Account Analytics Read stored as a Worker secret. Writing does not. The installer must create this token; if it is missing, the dashboard should degrade to D1 totals only.
4. Free plan ceilings. 100k writes/day for WAE (and for D1 rows written) and 10k SQL queries/day. The dashboard should cache query results (for example in KV for 60 s) so a busy admin page does not burn the read allowance.
5. Dashboard query latency. Each WAE query is an external HTTPS round trip with no published latency target; run the handful of dashboard queries in parallel (respecting the 6-in-flight connection limit) and cache.
6. Not billed today. WAE usage is currently free of charge, but Cloudflare has published the prices above and will start billing at some point; on Workers Paid the overage is $0.25 per million clicks, which is negligible for this product.

Alternative if a user wants exact per-day history forever: a D1-only mode with a daily rollup table (`slug, day, country, clicks`) updated on each click. It costs one extra row written per click, produces exact numbers, and has no retention limit, but grows the database and requires furea to own the rollup logic. A reasonable opt-in, not the default.
