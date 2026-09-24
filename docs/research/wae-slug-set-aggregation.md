# Research: aggregating Analytics Engine clicks across a set of slugs

Issue: sunwjy/furea#30 (part of #1, blocks #31). Date: 2026-09-24.

Question: how can the admin surface compute click breakdowns for a **set** of slugs (a campaign's links) from Workers Analytics Engine (WAE), and what does each approach cost? The baseline is ADR 0005: one data point per click, `indexes: [slug]`, `blobs: [slug, country, referrerHost, deviceClass]`, `doubles: [1]`, dataset `furea_clicks`, breakdowns via the SQL API with `sum(_sample_interval)`, and every per-link query bounded by `timestamp >= link.created_at`. Earlier WAE facts are in `docs/research/workers-analytics-engine.md` and are not repeated unless they matter here.

Every claim about Cloudflare below is quoted or paraphrased from a Cloudflare primary source, linked next to it. All pages were read on 2026-09-24 (the WAE pages show "Last updated Apr 23, 2026"). Where the docs say nothing, this file says "not documented" and does not guess.

## Summary

| Topic | Finding |
|---|---|
| `IN (...)` filter | Supported: `column IN ('a', 'list', 'of', 'values')` and `NOT IN` are documented comparison operators. Works on `index1` and on blobs alike. |
| Max query length / list size | **Not documented.** No maximum SQL text size, `IN` list length, result row count or time range appears on the WAE limits, SQL API or SQL reference pages. |
| Per-query cost | Flat. One POST to the SQL API is one read query, "no extra cost for more or less complex queries, and no extra cost for reading only a few rows of data versus many rows of data". |
| Row-scan limit | No numeric limit is documented. Instead, ABR sampling at read time caps the rows scanned per query: a costlier query is answered from a lower-resolution copy of the data rather than failing. |
| Sampling across many indexes | Cloudflare warns that reading many index values in one query lowers resolution ("possibly unusably low" at the extreme) and that "you may only be able to query for one host at a time (or all of them) and expect accurate results". No threshold is documented. |
| `GROUP BY` over a slug list | Supported for every ADR 0005 breakdown (time buckets, country, referrer host, device class), including grouping by `index1` and a blob together so one query yields both per-link and combined numbers. `sumIf` allows several filtered sums in one row. |
| Campaign id at click time | Possible within limits (20 blobs, 16 KB blobs, 96-byte index), but it freezes the campaign membership at click time, needs the campaign id in the cache entry (a KV write per link on adopt/detach), and adds a fifth click fact. Putting it in the index would undo ADR 0005's per-slug sampling. |
| Free-plan read quota | 10,000 SQL queries/day, each costing the same. A campaign page costs about 4-5 queries with a slug-list query, versus 4 x (links + 1) if each link were queried separately. |

## 1. SQL API limits relevant to `WHERE index1 IN (...)`

### 1.1 The operator exists

The SQL reference lists `IN` and `NOT IN` among the comparison operators: "`IN` true if the preceding expression's value is in the list `column IN ('a', 'list', 'of', 'values')`". `BETWEEN` and the boolean operators `AND`, `OR`, `NOT` are also supported. https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/operators/

`index1` and `blob1..blob20` are all `string` columns in the table, so `index1 IN (...)` and `blob1 IN (...)` are the same operator on the same type. https://developers.cloudflare.com/analytics/analytics-engine/sql-api/ (table structure). Whether filtering on `index1` is faster than filtering on `blob1` is **not documented**; the docs only say the index "is used as the key for sampling" (same page).

`WHERE` takes "any expression that evaluates to a boolean", combining comparison and boolean operators. https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/statements/ This matters because ADR 0005's `timestamp >= <link.created_at>` bound is per link, so a campaign query needs one bound per slug:

```sql
WHERE (index1 = 'spring-fb'  AND timestamp >= toDateTime('2026-09-01 10:00:00'))
   OR (index1 = 'spring-ig'  AND timestamp >= toDateTime('2026-09-03 08:30:00'))
   OR ...
```

which is valid under the documented grammar. The query text grows linearly with the number of links.

### 1.2 Length, list size, rows, cost

- **Maximum query length: not documented.** The SQL API page describes the request only as "Submit the query text in the body of a `POST` request". https://developers.cloudflare.com/analytics/analytics-engine/sql-api/ The limits page lists only write-side limits (blobs, doubles, index size, data points per invocation) and retention. https://developers.cloudflare.com/analytics/analytics-engine/limits/
- **Maximum `IN` list size: not documented** (operators page above and limits page above).
- **Maximum result rows: not documented.** `LIMIT <n>|ALL` exists, where `ALL` means "no restriction"; `OFFSET <n>` exists. https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/statements/
- **Per-query cost: flat.** "Every time you post to Workers Analytics Engine's SQL API, this counts as one read query. Each read query costs the same amount. There is no extra cost for more or less complex queries, and no extra cost for reading only a few rows of data versus many rows of data." https://developers.cloudflare.com/analytics/analytics-engine/pricing/
- **Row-scan limit: none published as a number.** Instead, read-time sampling (ABR) bounds the work: "irrespective of the volume of data involved, we need to limit the total number of rows scanned to provide an answer to the query", and "The query's complexity is determined by the number of rows to be retrieved and the probability of the query completing within a specified time limit of N seconds." N is not given. https://developers.cloudflare.com/analytics/analytics-engine/sampling/ So an expensive query is not rejected; it is answered from a lower-resolution copy.
- **Only one table per query.** "queries can only operate on a single table. `UNION`, `JOIN` etc. are not currently supported." Subqueries in `FROM` are allowed. https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/statements/ So the slug list cannot come from a join against another table; the Worker must write the list (read from D1) into the SQL text.
- **API rate limit.** The Cloudflare API allows "1200/5 minutes" per user/account token and "200/second" per IP, and exceeding it blocks all calls for five minutes. https://developers.cloudflare.com/fundamentals/api/reference/limits/ Whether the WAE SQL endpoint counts against this global limit, or has its own, is **not documented** (it is not in that page's list of separately limited APIs).
- **Worker-side limits** when the admin Worker fans out queries: on Workers Free, 50 subrequests per request and 6 connections simultaneously waiting for response headers. https://developers.cloudflare.com/workers/platform/limits/

Practical reading: a campaign has at most tens of links, so an `IN` list or an `OR` of per-link bounds is a few kilobytes of SQL at most. Nothing documented forbids it, but nothing documented guarantees an upper bound either. If furea wants certainty, a one-off smoke test (like `scripts/wae-oauth-smoke.mjs`) sending a query with a few hundred literals would settle it empirically; this research did not run one.

### 1.3 Does filtering on many `index1` values keep sampling sane?

What is documented:

- Write-time sampling is per index value: "At write time, we sample if data points are written too quickly into one index." Equitable sampling "equalize[s] the number of events we store for each unique index value". https://developers.cloudflare.com/analytics/analytics-engine/sampling/ Because ADR 0005 already indexes by slug, every link in a campaign is sampled independently at write time, whatever the query looks like later.
- Read-time sampling (ABR) depends on the query: "queries that cover longer time ranges will retrieve data from a higher sample interval". https://developers.cloudflare.com/analytics/analytics-engine/sampling/
- Reading many indexes at once lowers resolution. From the FAQ: "reading across many indices is slow. In practice, due to how ABR works, reading from many indices in one query will result in low-resolution data – possibly unusably low." And: "There is no hard and fast rule for when sampling starts at read time, but in practice reading longer periods (or more index values) will result in a higher sample interval." https://developers.cloudflare.com/analytics/faq/wae-faqs/
- Listed trade-off of an index choice: "You may not be able to run accurate queries across multiple indices at once. For example, you may only be able to query for one host at a time (or all of them) and expect accurate results." https://developers.cloudflare.com/analytics/analytics-engine/sampling/
- Cloudflare's billing recipe, for the same reason, suggests "executing one query per customer. This can result in less sampling than querying multiple customers at once." https://developers.cloudflare.com/analytics/analytics-engine/recipes/usage-based-billing-for-your-saas-product/
- How to tell whether a result was read-time sampled: sample intervals that are "multiples of powers of 10, for example `20` or `700`". As an accuracy check, count the rows actually read with `count()`: "If you are extrapolating from only one or two rows, it is unlikely you have a representative result; if you are extrapolating from thousands of rows, it is very likely that your results are quite accurate." https://developers.cloudflare.com/analytics/faq/wae-faqs/
- Write-time threshold: "There is no fixed rule"; Cloudflare observed "about 100 data points per second" per index value before sampling is noticeable on CDN-like workloads. https://developers.cloudflare.com/analytics/faq/wae-faqs/

What is **not documented**: how many index values, rows or seconds of range make ABR drop to a lower resolution. Cloudflare's own phrasing ("reading from many indices") is qualitative.

What this means for furea (inference, labelled as such): the ADR 0005 instance overview already reads *all* slugs in one query ("top 10 links"), which is the "all of them" case the sampling page calls accurate. A campaign query reads a small subset of slugs from a small dataset. Because ABR selects resolution by the number of rows to scan, a personal or small-company instance with thousands to low millions of rows in 90 days will most likely be answered at full resolution for either query shape. This is not a documented guarantee. The cheap safeguard is to also select `count()` next to `sum(_sample_interval)` so the admin surface can tell when an estimate rests on few rows (FAQ above).

## 2. `GROUP BY` over a slug list for the ADR 0005 breakdowns

All the building blocks are documented:

- `SELECT ... FROM ... WHERE ... GROUP BY <expression>, ... HAVING ... ORDER BY ... LIMIT ... OFFSET ... FORMAT`. `GROUP BY` accepts "Multiple expressions or column names ... separated by commas", and a "complex expression" rather than only a column. https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/statements/
- Time buckets with a time zone: `toStartOfInterval(timestamp, INTERVAL ..., tz)` and `toStartOfDay`, `toStartOfHour`, etc. https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/date-time-functions/
- Aggregates: `sum`, `count`, `countIf`, `sumIf`, `topK`, `topKWeighted(N)(column, weight_column)` and others. `sumIf(<expr>, <expr>)` sums the first expression over rows where the second is true. `topKWeighted` "returns the most common `N` values of a column, weighted by a second column", with `_sample_interval` as the documented weight example. https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/aggregate-functions/ Whether `topK`/`topKWeighted` are exact or approximate is **not documented** on that page, so `GROUP BY ... ORDER BY sum(_sample_interval) DESC LIMIT 10` is the safer form for "top 10".
- `if(<condition>, <true>, <false>)` is the only documented conditional function. https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/conditional-functions/

So each ADR 0005 breakdown has a campaign form. Combined (all links together):

```sql
-- combined daily series for a campaign, browser time zone
SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY, 'Asia/Seoul') AS day,
       sum(_sample_interval) AS clicks,
       count() AS rows_read
FROM furea_clicks
WHERE <per-link bounds: (index1 = ? AND timestamp >= ?) OR ...>
  AND timestamp >= NOW() - INTERVAL '30' DAY
GROUP BY day ORDER BY day

-- combined top 10 countries (same shape for blob3 referrer host, blob4 device class)
SELECT blob2 AS country, sum(_sample_interval) AS clicks
FROM furea_clicks
WHERE <per-link bounds> AND timestamp >= NOW() - INTERVAL '30' DAY
GROUP BY country ORDER BY clicks DESC LIMIT 10
```

Per-link comparison in one query, grouping by the index as well:

```sql
-- per-link totals for the range: one row per link
SELECT index1 AS slug, sum(_sample_interval) AS clicks
FROM furea_clicks
WHERE <per-link bounds> AND timestamp >= NOW() - INTERVAL '30' DAY
GROUP BY slug

-- per-link x country: the Worker can derive both per-link and combined top-N
SELECT index1 AS slug, blob2 AS country, sum(_sample_interval) AS clicks
FROM furea_clicks
WHERE <per-link bounds> AND timestamp >= NOW() - INTERVAL '30' DAY
GROUP BY slug, country
```

The two-key form returns up to links x distinct-values rows and has to be reduced to a top 10 in the Worker, because the documented grammar has no per-group `LIMIT` (`LIMIT BY` is not in the statements page). Its result size is bounded by the (undocumented) maximum result size, and grouping on more keys may raise read-time sampling (section 1.3), so separate combined queries are the more conservative choice.

The existing sampling example on the SQL API page groups by `index1` and describes it as the case where "an exact count can be calculated even in the case that the data has been sampled". https://developers.cloudflare.com/analytics/analytics-engine/sql-api/ That supports grouping by slug for the per-link comparison.

## 3. Alternative: a campaign identifier written at click time

### 3.1 As a blob

`blobs: [slug, country, referrerHost, deviceClass, campaignId]` fits easily: "up to twenty blobs, twenty doubles, and one index per call", blobs "must not exceed 16 KB" in total per data point. https://developers.cloudflare.com/analytics/analytics-engine/limits/ There is no extra cost for more blobs or higher cardinality: "There is no extra cost to add dimensions or cardinality, and no additional cost for writing more data in a single data point." https://developers.cloudflare.com/analytics/analytics-engine/pricing/ A campaign query would then be `WHERE blob5 = '<campaignId>'`, a single short predicate.

Consequences for furea:

- **History is frozen at click time.** WAE has no update or delete statement: the only documented statements are `SHOW TABLES`, `SHOW TIMEZONES`, `SHOW TIMEZONE` and `SELECT`. https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/statements/ A link adopted into a campaign contributes only clicks after adoption; a detached link keeps contributing its earlier clicks to the old campaign; clicks recorded before a campaign is deleted keep its id. Whether that is a bug or the desired meaning ("clicks that happened while in the campaign") is a product decision for #28/#31, but it cannot be changed after the fact. Data expires after three months, which bounds the inconsistency. https://developers.cloudflare.com/analytics/analytics-engine/limits/
- **Sampling is unchanged, but filtering is on a non-index field.** Write-time sampling still happens per slug. The sampling page lists "Filter on most fields" as supported but warns that "You may not be able to observe very rare values of fields not in the index" and the FAQ says a small subgroup filtered out of a larger read "may not be present due to sampling". https://developers.cloudflare.com/analytics/analytics-engine/sampling/ , https://developers.cloudflare.com/analytics/faq/wae-faqs/ A `blob5 = ?` filter scans the whole dataset for the range, so it is subject to the same read-time resolution as the instance overview, not better than a slug list.
- **The redirect cache entry must carry the campaign id.** ADR 0004 answers clicks from the KV entry `{"to": ..., "disabled": ...}` without touching D1, so the id would become a new field (the object form was chosen to "leave room for per-link options later", ADR 0004). Adopting or detaching a link then needs a KV write for that link, exactly like an edit; the free plan's 1,000 KV writes/day is spent only by operator actions today (ADR 0004), so a bulk adopt of N links costs N writes. The cache-miss path would also need the id from D1. This is a coupling between campaign membership and the redirect path that ADR 0001's separation currently avoids.
- **Glossary impact.** `CONTEXT.md` defines *Click facts* as "The only four things remembered about a click"; a campaign id would be a fifth, and ADR 0005's unit test that pins the value object to four fields would change.

### 3.2 As the index

Replacing the slug index with the campaign id (or `campaignId:slug`, which the FAQ allows: "It is possible to concatenate multiple values in your index field", https://developers.cloudflare.com/analytics/faq/wae-faqs/ ):

- A campaign index concentrates all its links' writes into one index value, so a busy campaign reaches the write-sampling threshold sooner than any single link would, and per-link numbers inside the campaign become estimates from the campaign's shared sample. This reverses ADR 0005's reason for indexing by slug ("a burst on one link is sampled independently").
- The index "must not be more than 96 bytes" (https://developers.cloudflare.com/analytics/analytics-engine/limits/); `campaignId:slug` fits only if both are short.
- A concatenated index can be filtered by prefix with `LIKE 'campaignId:%'` (documented pattern matching, https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/operators/), but it has the same frozen-history problem as 3.1, and the plain-link queries in ADR 0005 would all change.

### 3.3 Double-writing to a second dataset

The FAQ says: "it may make sense to write the same dataset with different indices. It is a common misconception that one should avoid 'double-writing' data." https://developers.cloudflare.com/analytics/faq/wae-faqs/ A second dataset indexed by campaign id would give campaign queries a single index to read. Cost: each campaign click becomes two data points against the 100,000/day free write allowance (https://developers.cloudflare.com/analytics/analytics-engine/pricing/), a second binding, and still the cache-entry and frozen-history consequences of 3.1. The 250 data points per invocation limit is not a concern (https://developers.cloudflare.com/analytics/analytics-engine/limits/).

## 4. Free-plan read quota

- Workers Free: 10,000 read queries/day; Workers Paid: 1 million/month included, then $1.00 per million. Each query costs the same regardless of complexity or rows. https://developers.cloudflare.com/analytics/analytics-engine/pricing/
- "Currently, you will not be billed for your use of Workers Analytics Engine." (same page). The daily free allowance is the relevant ceiling; how it is enforced when exceeded is **not documented** on the pricing or limits pages.

Queries per campaign page load for one range:

| Approach | Queries | Page loads per day within 10k |
|---|---|---|
| Slug list, combined breakdowns (series, countries, referrers, devices) + one per-link `GROUP BY index1` | 5 | 2,000 |
| Slug list, per-link x dimension queries reduced in the Worker (series, countries, referrers, devices, each grouped by slug too) | 4 | 2,500 |
| Campaign blob or campaign index | 5 (same shapes, shorter `WHERE`) | 2,000 |
| One query per link per breakdown (Cloudflare's "one query per customer" advice), 10-link campaign | 4 x 10 + combined 4 = 44 | about 227 |

The per-link fan-out also collides with Workers Free's 50 subrequests per request and 6 connections waiting for headers (https://developers.cloudflare.com/workers/platform/limits/): 44 SQL calls plus D1 calls would exceed 50 for a 10-link campaign in one request. The slug-list and campaign-blob approaches cost the same number of read queries; the query budget does not distinguish them. ADR 0005's conclusion ("One operator cannot reach the free plan's 10k reads/day") still holds for a few queries per page.

## 5. What could not be verified

- Maximum SQL text size, maximum `IN` list length, maximum result rows, maximum time range: not documented.
- The number of index values, rows or seconds at which ABR lowers resolution: not documented ("no hard and fast rule").
- Whether filtering on `index1` is cheaper than filtering on a blob: not documented.
- Whether the WAE SQL endpoint counts against the Cloudflare API's global 1,200 requests per 5 minutes: not documented.
- Whether `topK`/`topKWeighted` are exact: not documented.
- What happens when the free 10,000 queries/day is exceeded (errors, throttling, or nothing while billing is off): not documented.

No empirical test was run against a real account for this research.

## 6. Recommendation

**Filter by the slug list at query time. Do not write a campaign identifier at click time.**

- The data needed is already there: ADR 0005 indexes by slug, `IN` / `OR` filters and multi-key `GROUP BY` are documented, and every ADR 0005 breakdown has a direct campaign form (section 2). The Worker reads the campaign's slugs and `created_at` values from D1 and builds `WHERE (index1 = ? AND timestamp >= ?) OR ...`, so each link keeps its own reuse bound from ADR 0002/0005.
- Query-time membership matches the D1 model. Adopting, detaching or deleting a link changes what the campaign page shows immediately and retroactively, with no data rewrite (WAE cannot rewrite anyway). A campaign blob would freeze membership at click time, which only matters if #28 decides that history must stay with the campaign a click happened under; if it does, that is the one reason to revisit this.
- It costs nothing on the hot path: no new click fact, no new cache-entry field, no KV write on adopt/detach, no coupling of the redirect module to campaigns, no extra data points.
- Budget is identical to the blob approach: about 4-5 SQL queries per campaign page, far inside 10,000/day, and within the Workers Free subrequest and connection limits.
- Sampling: per-slug write sampling is kept. Reading several indexes in one query can lower read resolution, but Cloudflare publishes no threshold, and a small instance's dataset is small. Use combined queries (not per-link fan-out), and return `count()` alongside `sum(_sample_interval)` so the admin surface can flag an estimate based on few rows. Do not adopt Cloudflare's "one query per customer" pattern for campaigns: it multiplies query count by the number of links and hits the 50-subrequest limit on Workers Free.
- Open for #31: pick combined queries per breakdown (4) plus one `GROUP BY index1` per-link comparison, or two-key `GROUP BY slug, dimension` reduced in the Worker. The first is more conservative about read-time sampling and result size. If certainty about query length is wanted, add a small smoke test with a few hundred slug literals before settling the maximum campaign size.
