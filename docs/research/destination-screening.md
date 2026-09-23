# Research: screening link destinations from a Worker

Issue: sunwjy/furea#21 (part of #1; feeds *Decide: abuse controls for link creation and destinations*, #22). Date: 2026-09-23.

Question: which services can a furea Worker call to screen a link's **destination** for malware or phishing when the operator creates or edits a link, and what does each cost an operator who installs furea on a free Cloudflare plan? For each: who signs up, authentication, free quota, per-call latency from a Worker, terms that forbid or restrict the use, and whether the credentials the installer already holds (ADR 0006) suffice or a new secret is needed.

Framing that matters for every row below: furea is self-hosted, so **the operator** is the party that signs up and accepts each provider's terms, not the furea project. Only the operator creates links, so volume is tiny (tens to low thousands of checks a month). The Worker today holds exactly one credential, the `ANALYTICS_TOKEN` secret (`Account Analytics Read`, ADR 0005); the deploy token (Workers Scripts, KV, D1 Edit, Zone Read, DNS Edit) stays on the operator's machine and is never given to the Worker (ADR 0006).

Sources checked (primary only; each claim carries its URL):

- developers.google.com/safe-browsing: overview, v4 overview, v4 Lookup API, v4 usage limits, v4 get-started, v5 reference and `urls.search`, Terms of Service.
- docs.cloud.google.com / cloud.google.com: Web Risk overview, Lookup API, quickstart, pricing.
- developers.cloudflare.com: URL Scanner (Radar), URL Scanner scan limits, URL Scanner API reference (create / get), Intel API domain details and Threat Intelligence limits, Radar first request, 1.1.1.1 setup (Families), DoH JSON API, public resolver privacy, Workers limits, KV limits.
- urlhaus.abuse.ch (API, feeds, and the download files themselves), abuse.ch terms of use; openphish.com feeds and terms; phishtank.org developer and registration pages.
- Live probes from a developer machine on 2026-09-23 (`curl`), labelled as such. Nothing was measured from inside a Worker.

## TL;DR

| Option | Who signs up / auth | Free quota | Latency (see §7) | Terms problem for furea | Existing credentials? |
|---|---|---|---|---|---|
| **Google Safe Browsing v5 `urls:search`** | Operator: Google account + Cloud project + API key | Free; "default usage quota", number not published on the primary page | One HTTPS GET; ~0.6-0.8 s cold from a dev machine | **"non-commercial use only"**; raw URL sent to Google, who "may also share submitted URLs ... with third parties" | No: new secret (API key) |
| Google Safe Browsing v4 Lookup | same | same | same | same, plus **deprecated, support ends 2027-03-31** | No |
| **Google Web Risk `uris:search`** | Operator: Cloud project **with billing enabled** + API key | 100,000 calls/month free, then $0.50 / 1,000 | One HTTPS GET; ~0.5-0.9 s cold | Built for commercial use; "must not be redistributed" (fine: furea only acts on it) | No: new secret, plus a billing account |
| **Cloudflare URL Scanner** | Operator: new API token with `Account > URL Scanner` | Free plan: 5,000 **public** scans/month, **0 unlisted**, 1 req / 10 s | Asynchronous; poll every 10-30 s until done | Free-plan scans are **public** on radar.cloudflare.com: publishes every destination | No: new token + Worker secret |
| Cloudflare Intel domain API | Operator: token with `Intel Read` | **100 calls/month** on Free | One HTTPS GET | Quota too small; domain-level only | No |
| Cloudflare Radar API | Operator: token with `Account > Radar Read` | not stated | n/a | No per-URL malicious verdict exists in Radar outside the URL Scanner | No |
| **1.1.1.1 for Families DoH** (`security.cloudflare-dns.com`) | Nobody | None published; no key | One DoH GET; ~0.3 s cold from a dev machine | No usage terms found beyond the resolver's; domain-level only, verdict is a `0.0.0.0` answer | **Yes: needs nothing** |
| **URLhaus** (abuse.ch) download on Cron | Nobody for the download today; API needs a free Auth-Key | Free for "not-for-profit purposes"; fetch at most every 5 min | Zero at check time (local KV lookup) | Commercial / for-profit use "may require a paid subscription"; malware-download URLs only, no phishing | Yes for the download; new secret only for the API |
| OpenPhish community feed | Nobody | Free, 12 h refresh, ~300 URLs | local | **Forbids** "customer protection" and any "commercial purposes"; personal use only | n/a: unusable |
| PhishTank | Registration **"temporarily disabled"** | "a few downloads per day" without key | local | Cisco EULA | n/a: unusable today |

Recommendation (inferred, for #22): ship a zero-configuration default of **1.1.1.1 for Families DoH lookup of the destination host** at create/edit time, optionally joined by a **URLhaus text feed pulled into KV by the existing Cron Trigger**; offer **Google Web Risk** (or Safe Browsing v5 for non-commercial operators) as an opt-in that the operator enables by supplying their own key as a Worker secret. Do not use the Cloudflare URL Scanner on Free accounts: it publishes each destination. Details and caveats in §8.

## 1. Google Safe Browsing (v4 Lookup, v5 `urls:search`)

**Status.** The v4 overview carries a banner: "The Safe Browsing APIs (v4) are deprecated." https://developers.google.com/safe-browsing/v4 The end date is not on that page; Google's email to API users, quoted in a Brave issue, says "We will be ending support for the Google Safe Browsing v4 APIs on March 31, 2027." https://github.com/brave/brave-browser/issues/56023 (secondary relay of a first-party email; the date is not on a Google page I could find). A new integration should use v5.

**Endpoints.**
- v4: `POST https://safebrowsing.googleapis.com/v4/threatMatches:find?key=API_KEY`, "up to 500 URLs" per request. https://developers.google.com/safe-browsing/v4/lookup-api
- v5: `GET https://safebrowsing.googleapis.com/v5/urls:search`, `urls[]`: "Clients MUST NOT send more than 50 URLs." Response has `threats[]` and `cacheDuration`; "If nothing is found, the server will return an OK status (HTTP status code 200) with the `threats` field empty"; a negative result "MUST also be cached", and the client may extend a clean result's cache to at most 24 hours. https://developers.google.com/safe-browsing/reference/rest/v5/urls/search
- v5 also offers `hashes.search` (4-byte hash prefixes only, "URL Confidentiality") at the cost of client-side canonicalisation and SHA-256 suffix/prefix expressions; `urls.search` has "No URL Confidentiality: The request contains the raw URLs being checked." https://developers.google.com/safe-browsing/reference

**Who signs up, auth.** "You need a Google Account in order to create a project", "a Google Developer Console project in order to create an API key", and "You need an API key to access the Safe Browsing APIs." https://developers.google.com/safe-browsing/v4/get-started No billing step is listed. Auth is the `key=` query parameter. https://developers.google.com/safe-browsing/reference

**Cost and quota.** "There is no cost for use of this API." "Developers are allocated a default usage quota upon enabling the Safe Browsing API"; more can be requested in the Console. https://developers.google.com/safe-browsing/v4/usage-limits The number itself is not on a primary page (third-party listings say 10,000/day; unverified). For operator-created links any published default is far above need.

**Terms (quoted).**
- "The Safe Browsing API is for non-commercial use only (meaning 'not for sale or revenue generating purposes')." https://developers.google.com/safe-browsing/v4/usage-limits and "If you need to use APIs to detect malicious URLs for commercial purposes ... please refer to the Web Risk API." https://developers.google.com/safe-browsing
- ToS: "Unless you have a separate agreement with Google, you may not use the Safe Browsing API for commercial purposes." https://developers.google.com/safe-browsing/terms
- ToS, freshness: "You may not treat a URL from Google's list as an unsafe web resource, such as by showing users a warning about the site or blocking access to it, unless your application has received from Google updated information (via the applicable API method) within the past thirty minutes." Same page.
- ToS, notice: "If you indicate to users that you are providing protection against unsafe web resources, then you also agree that ... when displaying each warning about a particular site, you will provide attribution and conspicuous notice that the reliability and accuracy of the service cannot be guaranteed". Same page.
- ToS, data: "Google may use URLs and associated data submitted through the Safe Browsing API's SearchUrls method to provide, maintain, protect and improve Google's products and services ... Google may also share submitted URLs, content and metadata with third parties, including other Google customers and users." Same page.

**What this means for furea** (inferred). Nothing forbids a URL shortener as such. The blocker is "non-commercial": a company running furea for its marketing links is plausibly "revenue generating", and that judgement falls on each operator, who accepts the terms. Checking at create/edit time and refusing to save is a fresh API answer, so the 30-minute rule is met at that moment; it would bind furea if it later re-used a stored verdict to block redirects. The admin UI must carry the "cannot be guaranteed" notice with Google attribution when it shows a rejection. `urls:search` sends the raw destination (including any query-string secrets) to Google, which may share it; `hashes.search` avoids that but needs a correct canonicaliser in the Worker.

**Credentials.** New: a Google API key stored as a Worker secret (e.g. `SAFE_BROWSING_KEY`). Nothing in the installer's Cloudflare token helps.

## 2. Google Web Risk

**What it is.** The commercial sibling of Safe Browsing. Lookup: `https://webrisk.googleapis.com/v1/uris:search`, HTTP GET, auth `key=API_KEY`, `threatTypes` repeated (`MALWARE`, `SOCIAL_ENGINEERING`, ...); "To check multiple URLs, you need to send a separate request for each URL"; a clean URL returns `{}`; a match carries `expireTime`. https://docs.cloud.google.com/web-risk/docs/lookup-api

**Who signs up.** The operator: "Create a Google Cloud project", "Verify that billing is enabled for your Google Cloud project", "Enable the Web Risk API". https://docs.cloud.google.com/web-risk/docs/quickstart So a credit card on a Google Cloud billing account is required even inside the free tier.

**Cost.** Lookup API `uris.search`: "1 to 100,000 calls" per month free; "100,001 to 10,000,000 calls" $0.50 per 1,000; above that, contact sales. Update API `threatLists.computeDiff` is free but `hashes.search` is $50 per 1,000, and `uris.search` combined with the Update API is $50 per 1,000. https://cloud.google.com/web-risk/pricing For furea only the free Lookup tier is relevant.

**Terms (quoted).** "The information returned by the Web Risk must not be redistributed." It is presented as "a new enterprise security product", with the same caveat that "Google cannot guarantee that its information is comprehensive and error-free". https://docs.cloud.google.com/web-risk/docs/overview Beyond that it falls under the general Google Cloud terms; the Service Specific Terms page has no Web Risk section. https://cloud.google.com/terms/service-terms Commercial use is the stated purpose (Safe Browsing pages send commercial users here). Using the verdict to refuse a link is not redistribution (inferred).

**Credentials.** New: API key as a Worker secret, plus a Google Cloud billing account on the operator's side.

## 3. Cloudflare URL Scanner (Radar / Security Center)

**API.** `POST /accounts/{account_id}/urlscanner/v2/scan` with `url`, optional `visibility` (`Public` / `Unlisted`), `country`, `customagent`, `screenshotsResolutions`, ...; `GET /accounts/{account_id}/urlscanner/v2/result/{scan_id}`. Token permission `URL Scanner Write` or `Read`. https://developers.cloudflare.com/api/resources/url_scanner/subresources/scans/methods/create/ The docs ask for "Account > URL Scanner" at "Edit" to submit. https://developers.cloudflare.com/radar/investigate/url-scanner/

**Asynchronous.** "While the scan is in progress, the HTTP status code will be `404`; once it is finished, it will be `200`. Cloudflare recommends that you poll every 10-30 seconds." The report has `verdicts.overall.malicious`, "whether the website was considered malicious *at the time of the scan*." https://developers.cloudflare.com/radar/investigate/url-scanner/ So a create-time check means either holding the admin request for tens of seconds or a pending state checked later by Cron.

**Visibility.** "By default, the report will have a `Public` visibility level, which means it will appear in the recent scans list and in search results." Retention: "Successful scans are subject to a retention policy of 12 months." https://developers.cloudflare.com/radar/investigate/url-scanner/

**Free-plan limits.** Free/Radar: last 50 scans of history, **5,000 public scans/month, no unlisted scans**, "1 per 10 seconds". Self serve (paid plans): 5,000 public + 500 unlisted. https://developers.cloudflare.com/security-center/investigate/scan-limits/

**What this means for furea.** On a Free account every scanned destination becomes a public, searchable report on radar.cloudflare.com for 12 months. Operators shorten unlisted document links, pre-launch pages and signed URLs; publishing them is a privacy leak furea must not cause by default. The scanner also visits the page with a browser, which may trigger one-time links. Only operators on a paid plan could use `Unlisted` (500/month).

**Credentials.** New: a token with URL Scanner Edit stored as a Worker secret. The deploy token lacks the permission and is not in the Worker anyway.

## 4. Other Cloudflare options

- **Intel API domain details.** `GET /accounts/{account_id}/intel/domain?domain=...` returns `content_categories`, `risk_types`, `risk_score` (0-1), inherited categories; permission `Intel Read`. https://developers.cloudflare.com/api/resources/intel/subresources/domains/methods/get/ Limit: **100 calls/month** on Free, Pro and Business; 2,500 on Enterprise. https://developers.cloudflare.com/security-center/intel-apis/limits/ Too small to be a default and needs a new token.
- **Radar API.** Token "Account > Radar ... Read". https://developers.cloudflare.com/radar/get-started/first-request/ Radar exposes rankings and aggregate categories; the only per-URL malicious verdict under Radar is the URL Scanner above. Not a separate option.
- **1.1.1.1 for Families over DoH.** "1.1.1.1 for Families automatically blocks DNS queries to domains associated with malware, phishing, or (optionally) adult content"; malware-only DoH endpoint `https://security.cloudflare-dns.com/dns-query`; "When a queried domain is classified as malicious, Cloudflare returns the address `0.0.0.0`". https://developers.cloudflare.com/1.1.1.1/setup/ The JSON form takes `name`, `type` and header `Accept: application/dns-json`. https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/ Probe on 2026-09-23:

  ```
  malware.testcategory.com  -> "data":"0.0.0.0", "Comment":["EDE(16): Censored"]   0.30 s
  phishing.testcategory.com -> "data":"0.0.0.0", "Comment":["EDE(16): Censored"]   0.27 s
  example.com               -> real A records, no Comment                          0.22 s
  ```

  So the verdict is machine-readable (`0.0.0.0` plus Extended DNS Error 16). No key, no account, no published quota. The public resolver privacy page says logs are deleted "within 25 hours" and are not sold, but it explicitly covers the standard resolver, not Families (https://developers.cloudflare.com/1.1.1.1/privacy/public-dns-resolver/); I found no Families-specific terms of use. Limits: host-level only (a malicious path on a shared host such as a file-sharing site is invisible), and a domain that legitimately resolves to `0.0.0.0` or has no A record needs handling (check `AAAA` / treat `EDE(16)` as the signal). Calling DoH with `fetch()` from a Worker is common practice (community thread https://community.cloudflare.com/t/best-way-for-dns-lookups-by-workers/623544); not verified by me from a Worker.
- **Gateway DNS categories** (Zero Trust) would need a Zero Trust organisation, a Gateway location and a policy set up by the operator; the Families resolver already exposes the security-category verdict without any of that. Not pursued further.

## 5. Blocklist feeds on a Cron Trigger

**URLhaus (abuse.ch).**
- The API ("In order to interact with the URLhaus API, you need to obtain an `Auth-Key` first", via https://auth.abuse.ch/) covers the lookup endpoints and the dumps; datasets are regenerated "every 5 minutes", do "not fetch it more often than every 5 minutes". https://urlhaus.abuse.ch/api/
- Probe on 2026-09-23: the download files still answer **without** an Auth-Key: `https://urlhaus.abuse.ch/downloads/text_online/` (15,922 URLs, 1.41 MB), `csv_online/` (3.98 MB), `hostfile/` (11.5 KB, domains only). Each file header says "Terms Of Use: https://urlhaus.abuse.ch/api/". Given the API page, unauthenticated access should be assumed to end without notice (inferred).
- Content: the online dump is `malware_download` URLs (payload URLs, many raw IP:port); **no phishing**.
- Terms (abuse.ch): "Authenticated Users may access the Platforms for not-for-profit purposes, subject to usage limitations"; "Use of the Platforms by companies, networks, or individuals with commercial or for-profit needs may require a paid subscription, which will be managed by Spamhaus." https://abuse.ch/terms-of-use/ The URLhaus API page repeats this for the API. The feeds page adds that the ASN/country/TLD feeds "are not intended for blockling / blacklisting" (sic), pointing to the API instead. https://urlhaus.abuse.ch/feeds/
- Fit with Workers Free: "10 ms" CPU per HTTP request **and Cron Trigger**, 50 subrequests, 128 MB memory, no response body size limit. https://developers.cloudflare.com/workers/platform/limits/ KV Free: 1,000 writes/day, 25 MiB per value. https://developers.cloudflare.com/kv/platform/limits/ The 1.4 MB text list fits in one KV value; storing it by streaming `fetch().body` into `KV.put` avoids parsing in the Cron handler, and a refresh every hour costs 24 of the 1,000 daily writes. At check time, a substring search for the normalised URL in the 1.4 MB string is the cheapest lookup; whether it stays under 10 ms CPU needs a measurement (inferred). Per-row D1 ingestion (16k rows each refresh vs 100k rows written/day) does not fit.

**OpenPhish community feed.** `https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt`, refreshed every "12 hours" (300 lines on 2026-09-23). https://openphish.com/phishing_feeds.html Terms: "The Services are provided solely for your personal use." and "You agree not to use any part of the Services for any commercial purposes, including, but not limited to, security operations, threat intelligence, detection, enrichment, product development, automation, customer protection, or other business functions of any organization you are affiliated with without the prior written consent of OpenPhish." https://openphish.com/terms.html Unusable as a furea default.

**PhishTank.** Feed `http://data.phishtank.com/data/online-valid.json.bz2`; without an application key "you will be limited to a few downloads per day". https://phishtank.org/developer_info.php The registration page reads "New user registration temporarily disabled." (https://phishtank.org/register.php, 2026-09-23). Unusable today.

## 6. Credentials versus ADR 0006

- The deploy token (Workers Scripts Edit, Workers KV Storage Edit, D1 Edit, Zone Read, DNS Edit) has none of `URL Scanner`, `Intel` or `Radar`, and it never reaches the Worker. Every Cloudflare API option therefore needs a **new** token created by the operator and stored as a Worker secret, alongside `ANALYTICS_TOKEN`; it would fit the existing pattern of the `analytics-token` command (a pre-filled template URL, stored as `secret_text`, preserved by `keep_bindings`).
- Google options need a **new** Google credential (API key); Web Risk additionally needs a Google Cloud billing account.
- 1.1.1.1 for Families and the URLhaus download need **nothing**; the URLhaus API would need a free abuse.ch Auth-Key as a secret.

## 7. Latency

Measured from a developer machine (not a Worker), cold connections including TLS, three runs, invalid Google key so the endpoint answered 400 after full routing:

| Endpoint | Times |
|---|---|
| `safebrowsing.googleapis.com/v5/urls:search` | 0.75 s, 0.80 s, 0.60 s |
| `webrisk.googleapis.com/v1/uris:search` | 0.89 s, 0.49 s, 0.46 s |
| `security.cloudflare-dns.com/dns-query` | 0.31 s, 0.36 s, 0.28 s |

From a Worker these should be lower: the DoH resolver runs in the same Cloudflare location, and Google's front ends are close to most Cloudflare locations (inferred, unmeasured). Either way this cost falls only on link create/edit in the admin surface, never on the redirect path, so sub-second latency is acceptable. The URL Scanner is the outlier: tens of seconds, asynchronous.

## 8. Recommendation and open points (for #22)

1. **Default, zero-config: 1.1.1.1 for Families DoH on the destination host** at create and edit. No sign-up, no secret, no terms that single out commercial use, one subrequest. Treat `0.0.0.0` with `EDE(16)` as "flagged". Covers malware and phishing at domain level only.
2. **Optional add-on, zero-config: URLhaus `text_online` into KV via the existing `*/5` Cron Trigger** (refresh hourly), adding path-level malware-download URLs. Caveats: the not-for-profit clause makes it an operator choice, not a silent default, and the unauthenticated download may start requiring an Auth-Key. If #22 wants only terms-clean defaults, drop this and keep 1.
3. **Opt-in, operator-supplied key: Google Web Risk** (commercial-safe, 100k free lookups/month, needs billing) **or Safe Browsing v5** (free, non-commercial only). Stored as a Worker secret via a CLI command modelled on `analytics-token`. Admin UI must carry Google's attribution and "cannot be guaranteed" notice. Prefer v5 over v4 (v4 support ends 2027-03-31).
4. **Reject: Cloudflare URL Scanner** (public by default, no unlisted scans on Free, asynchronous), **Intel API** (100 calls/month), **OpenPhish** (terms forbid "customer protection"), **PhishTank** (registration closed).
5. Open, cheap to close with a smoke Worker on a Free account: (a) `fetch("https://security.cloudflare-dns.com/dns-query?...")` works from a Worker and returns the same `EDE(16)` comment; (b) substring lookup in a 1.4 MB KV value stays under the 10 ms Free CPU limit; (c) the Cron handler can stream the URLhaus body into `KV.put` within 10 ms CPU.
6. Policy question for #22, not research: screening only at create/edit leaves destinations that turn bad later; a periodic re-check by Cron would need to respect Safe Browsing's 30-minute freshness rule before it disables a link.
