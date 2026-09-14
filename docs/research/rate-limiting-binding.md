# Research: Workers Rate Limiting binding for admin login throttling

Issue: sunwjy/furea#16 (part of #1; unblocks the "Brute force" section of ADR 0003). Date: 2026-09-14.

Question: ADR 0003 throttles operator login attempts with the Workers Rate Limiting binding, but only if it (1) is available and free on the Workers Free plan and is GA, (2) can be declared in the multipart script upload `metadata.bindings` that the installer uses (the installer never runs wrangler), (3) has semantics and limits that let us size a login endpoint, and (4) can key on something other than a raw IP. If it is unusable, name the best fallback.

Sources checked (primary only; each claim carries its URL):

- developers.cloudflare.com: Workers Rate Limiting binding page (rendered and the raw `.mdx` in `cloudflare/cloudflare-docs`), the 2025-09-19 changelog entry, Workers pricing and limits pages, the multipart-upload-metadata page, WAF rate limiting rules (availability, request-rate, API), KV and D1 limits/pricing.
- Cloudflare API reference: `PUT /accounts/{account_id}/workers/scripts/{script_name}` (Upload Worker Module) `metadata.bindings` schema.
- `cloudflare/workers-sdk` on GitHub at `main` = `14ed9afbe401cbf6b19b3f5cc4265088ec8dcd07` (wrangler `4.131.2`): `packages/workers-utils/src/config/environment.ts`, `packages/workers-utils/src/config/validation.ts`, `packages/deploy-helpers/src/deploy/helpers/create-worker-upload-form.ts`, `packages/wrangler/src/__tests__/create-worker-upload-form/bindings.test.ts`, `packages/wrangler/src/dev/miniflare/index.ts`.
- blog.cloudflare.com, for the 2024 open-beta announcement only.

## TL;DR

| Sub-question | Finding | Verified / inferred |
|---|---|---|
| (1) Status | GA since 2025-09-19 ("the `ratelimit` binding is now stable and recommended for all production workloads"). Open beta since 2024-04-04. The "wrangler >= 4.36.0" note applies only if wrangler is used. | Verified |
| (1) Free plan / cost | No Cloudflare page prices the binding or gates it by plan. The binding page, the Workers pricing page and the Workers limits page do not mention it at all. Treat as "no separate charge, no plan gate", but this is **not backed by a positive statement**; confirm once by deploying to a Free account (cheap, section 6). | Inferred (absence of evidence) |
| (2) API upload | Yes. The Upload Worker Module schema has binding `type: "ratelimit"` with required `name`, `namespace_id` (string), `simple.limit` (number), `simple.period` (number), and optional `simple.mitigation_timeout`. Wrangler serialises its `ratelimits` config entry into exactly `{ name, type: "ratelimit", namespace_id, simple }` in the same `metadata` part the installer already builds. | Verified |
| (3) Semantics | Counters are **per Cloudflare location**, cached in-process, eventually consistent and "permissive". `period` is `10` or `60` seconds only. `limit` is any number. `namespace_id` is a string holding a positive integer, unique per account; equal ids share counters across Workers. No API creates namespaces; the id is declared in the binding. | Verified |
| (4) Non-IP key | Yes. `limit({ key })` takes "any `string` value". A salted hash of the IP, a constant per-instance key, or both, are all valid; the docs actively recommend keys other than raw IP. | Verified |
| Verdict | Usable. Keep the constant-time compare + fixed delay as the floor and add two bindings: a per-hashed-IP limiter and a per-instance limiter. | Recommendation |
| Fallback | If the Free-plan smoke test fails: fixed delay (always on) + a WAF rate limiting rule for own-domain instances (Free zones get 1 rule, IP-keyed, `Path` match, 10 s period / 10 s timeout). Not KV (1,000 writes/day on Free, 1 write/s per key). D1 counter only as a last resort (100k writes/day on Free; key must be a hashed IP). | Verified limits; ranking inferred |

## 1. Availability, status and cost

- **GA.** Changelog 2025-09-19, "Rate Limiting in Workers is now GA": "Rate Limiting within Cloudflare Workers is now Generally Available ... the `ratelimit` binding is now stable and recommended for all production workloads." Existing `unsafe` bindings keep working for migration. https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/
- **Open beta** was announced on 2024-04-04 ("The Rate Limiting API in Workers is in open beta"), described as "lightning fast, backed by memcached". https://blog.cloudflare.com/workers-production-safety/
- The bindings index lists "Rate Limiting" without a beta label. https://developers.cloudflare.com/workers/runtime-apis/bindings/
- The binding page says "You must use version 4.36.0 or later of the Wrangler CLI". That is about wrangler's config validator; it is irrelevant to a direct API upload. https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- **Pricing: no statement anywhere.** The binding page (rendered and raw `.mdx`) has no pricing, billing, plan or quota text. https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ and https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/runtime-apis/bindings/rate-limit.mdx The Workers pricing page does not mention it. https://developers.cloudflare.com/workers/platform/pricing/ The Workers limits page has no per-Worker cap on rate limiting bindings or namespaces. https://developers.cloudflare.com/workers/platform/limits/ The GA changelog carries no pricing either.
- "The Rate Limiting API is backed by the same infrastructure that serves rate limiting rules." https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ The *WAF* product is plan-gated (section 5), but the binding page does not import those gates.

Inference: every other paid or plan-gated Workers binding (D1, KV, Analytics Engine, Queues, ...) has a pricing page with a Free/Paid split; the rate limiting binding has none, and its own page says nothing about plans. The most likely reading is "included with Workers, no charge, available on Free". This is the one open point, and it is cheap to close (section 6).

## 2. Declaring the binding in the multipart upload

### 2.1 API schema

The Upload Worker Module endpoint `PUT /accounts/{account_id}/workers/scripts/{script_name}` takes `metadata` as a JSON form-data part; `metadata.bindings` is "List of bindings attached to a Worker". Among the ~36 allowed `type` values is `ratelimit`, with:

| Field | Type | Required | Description (API reference wording) |
|---|---|---|---|
| `type` | `"ratelimit"` | yes | "The kind of resource that the binding provides." |
| `name` | string | yes | "A JavaScript variable name for the binding." |
| `namespace_id` | string | yes | "Identifier of the rate limit namespace to bind to." |
| `simple.limit` | number | yes | "The limit (requests per period)." |
| `simple.period` | number | yes | "The period in seconds." |
| `simple.mitigation_timeout` | number | no | "Duration in seconds to apply the mitigation action after the rate limit is exceeded. Valid values are 0 (disabled), 10, or multiples of 60 up to 86400." |

https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/

The older narrative page "multipart upload metadata" does not list `ratelimit` (it lists ai, analytics_engine, assets, browser_rendering, d1, durable_object_namespace, hyperdrive, kv_namespace, mtls_certificate, plain_text, queue, r2_bucket, secret_text, service, vectorize, version_metadata). That page lags the API schema; the schema is authoritative. https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/

### 2.2 What wrangler sends (so the installer can copy it)

`packages/deploy-helpers/src/deploy/helpers/create-worker-upload-form.ts` (the code path behind `wrangler deploy`) does:

```ts
const ratelimits = extractBindingsOfType("ratelimit", bindings);
...
ratelimits.forEach(({ name, namespace_id, simple }) => {
	metadataBindings.push({
		name,
		type: "ratelimit",
		namespace_id,
		simple,
	});
});
...
formData.set("metadata", JSON.stringify(metadata));
```

https://github.com/cloudflare/workers-sdk/blob/main/packages/deploy-helpers/src/deploy/helpers/create-worker-upload-form.ts

The unit test confirms the shape passes through untouched: input `{ type: "ratelimit", namespace_id: "rl-123", simple: { limit: 100, period: 60 } }` becomes `{ name: "MY_BINDING", type: "ratelimit", namespace_id: "rl-123", simple: { limit: 100, period: 60 } }`. https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/__tests__/create-worker-upload-form/bindings.test.ts (The test uses a non-numeric id; wrangler's validator only checks that it is a string, while the platform rule that it be an integer is documented on the binding page.)

So the installer adds to the `metadata.bindings` array it already builds for D1/KV/assets (see `docs/research/cloudflare-api-deploy.md`):

```json
{ "name": "LOGIN_IP_LIMITER", "type": "ratelimit", "namespace_id": "<int as string>", "simple": { "limit": 5, "period": 60 } }
```

`mitigation_timeout` is exposed by the API but not by wrangler's config type or validator (section 2.3), so it has less test coverage; leave it out unless the section 6 smoke test shows it works.

### 2.3 Wrangler's config type and validation (reference for allowed values)

`packages/workers-utils/src/config/environment.ts`:

```ts
ratelimits: {
	/** The binding name used to refer to the rate limiter in the Worker. */
	name: string;
	/** The namespace ID for this rate limiter. */
	namespace_id: string;
	/** Simple rate limiting configuration. */
	simple: {
		/** The maximum number of requests allowed in the time period. */
		limit: number;
		/** The time period in seconds (10 for ten seconds, 60 for one minute). */
		period: 10 | 60;
	};
}[];
```

https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-utils/src/config/environment.ts

`validateRateLimitBinding` in `packages/workers-utils/src/config/validation.ts` requires string `name`, string `namespace_id`, object `simple` with number `limit` and number `period`, rejects `period` not in `[10, 60]` ("must be either 10 or 60"), and rejects any extra key on the binding or on `simple`. https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-utils/src/config/validation.ts

No wrangler command creates or lists rate limit namespaces; the id is purely declarative. https://developers.cloudflare.com/workers/wrangler/commands/

## 3. Semantics and limits

All from https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ unless noted.

- **Runtime API.** `const { success } = await env.LIMITER.limit({ key })`. "The `limit()` API accepts a single argument — a configuration object with the `key` field." Each call increments the counter for that key ("calls to `limit()` increment this").
- **`period`**: "Must be either `10` or `60`" seconds.
- **`limit`**: "The number of allowed requests (or calls to `limit()`) within the given `period`." No documented maximum or minimum.
- **`namespace_id`**: "A string containing a positive integer that uniquely defines this rate limiting namespace within your Cloudflare account (for example, `"1001"`). Although the value must be a valid integer, it is specified as a string. This is intentional." And: "Two rate limiting bindings that share the same `namespace_id` — even across different Workers on the same account — share the same rate limit counters for a given key." Because furea is installed into the operator's own account, the installer should pick ids unlikely to collide with the operator's other Workers (a fixed large integer per limiter, recorded in the ADR), not `1001`.
- **`simple` is the only supported type.** Multiple bindings per Worker are allowed.
- **Locality (per-colo, not global).** "Rate limits that you define and enforce in your Worker are local to the Cloudflare location that your Worker runs in. ... For each unique key you pass to your rate limiting binding, there is a unique limit per Cloudflare location." The WAF product it is built on states the same: "Cloudflare does not support global rate limiting counters across the entire network. Each data center maintains its own counters." https://developers.cloudflare.com/waf/rate-limiting-rules/request-rate/
- **Accuracy.** Counters are "cached on the same machine that your Worker runs in, and updated asynchronously in the background by communicating with a backing store that is within the same Cloudflare location." Hence "permissive, eventually consistent, and intentionally designed to not be used as an accurate accounting system." A burst inside one location can briefly exceed `limit`.
- **Latency.** `await limit()` is "not waiting on a network request".
- **Monitoring.** "Rate limiting bindings are not currently visible in the Cloudflare dashboard"; observe 429s via Workers Logs or emit an Analytics Engine data point.
- **Local dev.** Miniflare emulates it and "keys rate-limit counters by namespace_id". https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/dev/miniflare/index.ts

### Sizing the login endpoint

The effective ceiling for an attacker is `limit × windows × number of locations they can reach`. Reaching many locations requires source addresses in many regions, which is the same capability that defeats any per-IP scheme. For the default operator password (24 characters from a 56-symbol alphabet, ADR 0003) the search space makes this irrelevant; for a user-chosen 12-character password a per-location ceiling of a few hundred guesses per hour is still a strong floor. Suggested layout (inferred, not Cloudflare guidance):

| Binding | Key | `limit` / `period` | Purpose |
|---|---|---|---|
| `LOGIN_IP_LIMITER` | `sha256(salt ‖ cf-connecting-ip)` | 5 / 60 | Stops one client hammering the form; the hash keeps the raw IP out of any key or log (section 4). |
| `LOGIN_GLOBAL_LIMITER` | constant, e.g. `"login"` | 30 / 60 | Caps total attempts per location regardless of source; safe because there is exactly one operator and logins happen "a few times a month" (ADR 0003). |

Call both only on `POST /admin/login` (not the GET) and reject with 429 before touching D1 or PBKDF2, so a flood also does not burn CPU. Counting attempts *before* verifying the password is the simple choice; counting only failures means calling `limit()` after a failed compare, which lets a flood reach PBKDF2.

## 4. Keying on something other than a raw IP

- "The key you provide can be any `string` value." The docs *recommend* non-IP keys: "Good choices include API keys in `Authorization` HTTP headers, URL paths or routes, specific query parameters ... and/or user IDs and tenant IDs." and "It is not recommended to use IP addresses or locations ... since these can be shared by many users". https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Therefore `limit({ key: hex(sha256(salt + ip)) })` is fully supported. The raw IP never leaves the request handler; the key lives only in Cloudflare's per-location counter store, which furea does not read. A per-instance random salt (the installer already provisions secrets) prevents reversal of IPv4 hashes by enumeration. That keys are free-form is verified; the privacy reasoning is inferred.
- A constant key (`"login"`) is also valid, and is the cleanest way to throttle a single-operator login without any identifier at all.

## 5. Fallback if the Free-plan smoke test fails

Ranked:

1. **Fixed delay (already the ADR floor).** Constant-time compare plus a fixed sleep on failure; keep it regardless, it costs nothing and needs no binding.
2. **WAF rate limiting rule (own-domain instances only).** Available on Free zones with exactly these bounds: 1 rule; expression fields `Path`, `Verified Bot`; counting characteristic `IP` only; counting period `10 s`; mitigation timeout `10 s`; "Perform action during mitigation period". Pro raises this to 2 rules, periods up to 1 min and timeouts up to 1 h; custom counting expressions (headers, cookies, `cf.colo.id`) are Business/Enterprise. https://developers.cloudflare.com/waf/rate-limiting-rules/ Rules are deployed via the Rulesets API `http_ratelimit` phase with `ratelimit: { characteristics, period, requests_per_period, mitigation_timeout }` and must be last in the ruleset. https://developers.cloudflare.com/waf/rate-limiting-rules/create-api/ Counting is per data center here too. https://developers.cloudflare.com/waf/rate-limiting-rules/request-rate/ Constraints for furea: it consumes the zone's single Free rule, the counter is Cloudflare-side raw IP (not stored by furea, so compatible with the "never stores raw IPs" rule), and it needs a zone, so it cannot cover `workers.dev`-only instances (a `workers.dev` subdomain "is treated as a Free website" but is not a zone the operator can attach rulesets to, https://developers.cloudflare.com/workers/configuration/routing/workers-dev/ ; the "cannot attach rules" part is inferred). Best delivered as documented guidance plus an optional `npx furea waf-login-rule` helper, not as an installer default.
3. **KV counter: no.** Workers Free allows "1,000 writes to different keys per day" and, on every plan, "1 per second" writes to the same key; a login counter would exhaust or collide immediately. https://developers.cloudflare.com/kv/platform/limits/
4. **D1 counter: last resort.** Free plan: "100,000 rows written / day", "5 million rows read / day". https://developers.cloudflare.com/d1/platform/pricing/ A `login_attempts(key_hash, window_start, count)` table keyed by the salted IP hash costs one write per attempt, is global rather than per-location, and stays within the "no raw IPs" rule only because the key is a hash; it also adds a D1 round trip before password verification, exactly what the binding avoids. Use only if both the binding and a WAF rule are unavailable.

## 6. Recommended next step

Close the single unverified point with a smoke test rather than more reading: from a Workers **Free** account, upload a one-file Worker through the same multipart PUT the installer uses, with one `ratelimit` binding (`limit: 2, period: 10`), and hit it four times. Expected: HTTP 200 on upload, `{ success: true }` twice then `{ success: false }`, and no charge line on the account. If the upload is rejected for plan reasons the error comes back in the PUT's `errors[]` array and the ADR falls back to section 5; otherwise ADR 0003's "Brute force" section can drop its "pending research" clause and adopt the two-binding layout from section 3.
