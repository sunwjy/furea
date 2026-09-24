---
status: accepted
date: 2026-09-14
---

# Click analytics: Analytics Engine for breakdowns, an exact lifetime counter in D1, no IP-derived data at all

furea v1 records every click twice: as one **Workers Analytics Engine (WAE) data point** carrying four dimensions, and as a **`+1` on the link's `click_count` column in D1**. The admin surface shows the exact lifetime total from D1 and everything else (time series, countries, referrers, device classes) from WAE, labelled as a last-90-days estimate. No value derived from the visitor's IP address is ever written anywhere, so there is no unique-visitor count.

Decided in [Decide: analytics data model and dashboard queries](https://github.com/sunwjy/furea/issues/9), building on [Research: Workers Analytics Engine for click analytics](https://github.com/sunwjy/furea/issues/4).

## What a click records

- **WAE data point** (dataset `furea_clicks`, binding `CLICKS`): `indexes: [slug]`, `blobs: [slug, country, referrerHost, deviceClass]`, `doubles: [1]`. The slug is the index so a burst on one link is sampled independently of the others. `writeDataPoint()` is not awaited.
- **D1 counter**: `UPDATE links SET click_count = click_count + 1 WHERE slug = ?` inside `ctx.waitUntil`, after the redirect response is returned. A failed update is ignored: the redirect has already been answered and the total simply misses one click. The spec therefore defines the lifetime total as "clicks whose counter update succeeded", which in practice is all of them.
- The four dimensions and nothing else:
  - `country`: `request.cf.country`, `XX` when absent.
  - `referrerHost`: the host of the `Referer` header, lower-cased, `direct` when absent or unparsable. Never the full URL.
  - `deviceClass`: one of `desktop`, `mobile`, `tablet`, `bot`, `unknown`, derived from the User-Agent by simple substring rules. `bot` comes from a short list of obvious crawler markers (`bot`, `crawler`, `spider`, `facebookexternalhit`, `Slackbot`, `Twitterbot`, `WhatsApp`, `curl`, `python-requests`, …). This is "mark the obvious crawlers", not bot detection; Cloudflare's bot signals are not on the free plan.
  - Timestamp comes from WAE itself.
- Rejected dimensions: UTM parameters (ADR 0002 ignores the short URL's query string), browser/OS names (needs a UA parser on the redirect path), region/city (identification risk), language.

## Bots

Bots **are** clicks (see the glossary) and are counted in `click_count` and in every WAE aggregate. `deviceClass = bot` is what lets the admin surface show the bot share in the device breakdown. Rejected: excluding bots from the counter, which would make the "exact" total depend on a heuristic list.

## Write budget

The free plan's 100k D1 rows/day is shared by the counter and by operator edits. The Workers Free request cap is also 100k/day, so clicks cannot exhaust it on their own, and operator writes are a rounding error. On Workers Paid the counter costs $1 per million clicks. Rejected: batching the counter from WAE aggregates (approximate and more moving parts) and dropping the counter (totals would be estimates and vanish after 90 days).

## What the admin surface shows

- **Per link**: exact lifetime total (D1); daily series for the chosen range (WAE); top 10 countries; top 10 referrer hosts; device-class breakdown.
- **Instance**: clicks today / last 7 days / last 30 days (WAE); top 10 links for the chosen range (WAE).
- **Ranges**: 24 h (hourly buckets), 7 d, 30 d, 90 d (daily buckets).
- Every per-link WAE query carries `index1 = <slug> AND timestamp >= <link.created_at>` so a reused slug never inherits the deleted link's clicks (ADR 0002).
- Every WAE-derived number is labelled "last 90 days, estimated" and computed with `sum(_sample_interval)`.
- Day boundaries use the **browser's time zone**, passed as a `tz` query parameter and applied with `toStartOfInterval(timestamp, INTERVAL ..., tz)`. It is a request parameter, not an instance setting. Rejected: UTC-only buckets.
- No query result caching in v1. One operator cannot reach the free plan's 10k reads/day, and a KV cache would eat the 1,000 KV writes/day budget. Rejected: KV cache (budget), Cache API (unnecessary yet).

## Campaigns

Amended by [Decide: campaign analytics queries](https://github.com/sunwjy/furea/issues/31), building on ADR 0012 and [Research: aggregating Analytics Engine clicks across a set of slugs](https://github.com/sunwjy/furea/issues/30) ([`docs/research/wae-slug-set-aggregation.md`](../research/wae-slug-set-aggregation.md)).

- **Membership is read at query time.** A campaign's clicks are the clicks of the links that belong to it *now*, over their whole history. Adopting a link brings its earlier clicks in; detaching or deleting it takes them all out. Nothing about campaigns is written at click time: the click facts stay four, the cache entry (ADR 0004) is unchanged, and adopt/detach cost no KV write.
- **Lifetime total**: `SUM(click_count)` over the campaign's current links in D1, computed on every read. No separate campaign counter.
- **Breakdowns**: the same ranges (24 h, 7 d, 30 d, 90 d), `tz` handling and "last 90 days, estimated" labelling as a link. The Worker reads the member slugs and their `created_at` from D1 and writes them into the SQL as one bound per link, `(index1 = ? AND timestamp >= ?) OR ...`, AND-ed with the range. At most 100 links (ADR 0012) keeps this to a few kilobytes; the SQL API documents no length limit, so a smoke test confirms a 100-link query is accepted.
- **Four queries per campaign page**, never one per link:
  1. `GROUP BY index1, bucket`: from it the Worker derives each link's series (sparkline) and range total and the combined series.
  2. to 4. combined top 10 countries, top 10 referrer hosts and the device-class breakdown over all member links (not per link).
  Every query also selects `count()`; v1 does not expose it.
- **Campaign comparison**: one row per link (slug, its UTM values, range clicks, lifetime total, sparkline), including links with no clicks and disabled links (marked). The admin surface can fold the rows into one per source or per medium, grouping case-insensitively, from the rows it already has: no extra query. Folding reads the links' **current** UTM values, so a link whose source was edited counts entirely under the new source. Content/term folding and a source × medium matrix are not offered.
- **Not in the instance overview.** Campaigns get no tile and no "top campaigns" list; the campaign list shows link count and lifetime total from D1 only and runs no Analytics Engine query.
- **Without the analytics token** the campaign page keeps the combined lifetime total and the comparison on lifetime totals (source/medium folding included) and hides ranges, series, top lists and sparklines with the usual hint.
- Rejected: writing a campaign id into each click (as a blob, as the index, or into a second dataset). WAE rows cannot be rewritten, so membership would be frozen at click time, the cache entry would need the id, and adopt/detach would each cost a KV write; an index per campaign would also undo per-slug sampling. Rejected: one query per link (Workers Free allows 50 subrequests per request), a D1 campaign counter (it would disagree with the members' totals after any detach), and top campaigns in the overview (one query per campaign).

## Analytics read token

Reading WAE needs an API token with `Account Analytics Read`. It is a **separate, read-only token** stored as the Worker secret `ANALYTICS_TOKEN`; the installer's deploy token (Workers Scripts Edit and friends) is never placed inside the Worker. When the secret is missing the admin surface **degrades**: it shows D1 totals and hides the WAE panels with a hint. How the installer obtains the token is decided in *Decide: installer UX flow and upgrade behaviour*.

## The no-IP guarantee

The function that records a click never sees the `Request`. The redirect path builds a small value object with exactly `slug`, `country`, `referrerHost`, `deviceClass`; only the function that builds it reads request headers, and a unit test pins its output to those four fields. Nothing is derived from the IP address, not even a salted hash, so **unique visitors are not offered** in v1: any such count would be IP-derived and break the promise.

The guarantee also covers **Cloudflare-side storage that furea configures**. `deploy` keeps Workers Logs' invocation logs off (they would persist request headers, including the client IP, and `cf` location data for days), and the Worker's own log lines never contain a request header, an IP address or anything derived from either. A setting the operator changes in the Cloudflare dashboard is reverted on the next `deploy`. See ADR 0011.

## Considered and rejected

- **D1 daily roll-up table** (exact, permanent history) as an opt-in: out of v1. It doubles the per-click D1 writes and needs a dashboard that merges two stores. The v1 promise is deliberately simple: exact and permanent totals, estimated 90-day breakdowns.
- **Unique visitors**: see above.

## Consequences

- D1 `links` gains `click_count INTEGER NOT NULL DEFAULT 0`; the installer must declare the `analytics_engine` binding in the script upload metadata and, optionally, the `ANALYTICS_TOKEN` secret.
- The public API must expose the lifetime total on the link resource and the WAE-backed aggregates as separate resources that can be absent when the token is missing; the exact shape is decided in *Decide: public API surface*.
- The redirect path gains one `waitUntil` D1 write per click; the KV-only lookup from ADR 0004 is unchanged.
