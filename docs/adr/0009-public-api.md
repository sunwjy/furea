---
status: accepted
date: 2026-09-23
---

# Public API: `/api/v1`, links keyed by slug with merge-patch edits, cursor lists, one error envelope, analytics as separate resources, and API keys that cannot touch authentication

furea v1 exposes one JSON API under **`/api/v1`**, used by the admin surface and by operators' own scripts alike. Links are addressed by slug with four verbs; edits (including enable/disable) are merge-patches; lists are cursor-paginated; every error is one `{"error": {...}}` envelope with a machine code; click breakdowns live on separate `stats` resources that answer `503` when no analytics token is configured; one `settings` resource carries the root destination and Access mode; and **an API key can never create, revoke or otherwise change any credential**. No CORS headers are sent.

Decided in [Decide: public API surface (resources, versioning, error format)](https://github.com/sunwjy/furea/issues/15), building on ADR 0002 (slug rules), ADR 0003 (auth), ADR 0004 (redirect cache), ADR 0005 (click analytics) and ADR 0008 (root destination).

## Versioning

- Every path starts with `/api/v1/`. Within v1 the API only ever **adds** fields, endpoints and enum values; removing or re-meaning anything requires `/api/v2`. Rejected: an unversioned `/api/`, because operators' scripts meet a new Worker every time they run `npx furea@latest deploy` and would have no way to opt out of a breaking change.
- `GET /api/v1/openapi.json` serves an OpenAPI 3.1 document, generated from the zod schemas in `packages/shared` at release time and bundled into the Worker (assembled from `z.toJSONSchema()`, ADR 0018). It needs no authentication: the API's shape is public in the npm package anyway. No viewer page ships in v1.

## Resources

All field names are camelCase; timestamps are ISO 8601 strings in UTC (stats buckets carry the requested zone's offset).

### Link

```json
{
  "slug": "Ab3xYz",
  "shortUrl": "https://s.example.com/Ab3xYz",
  "destination": "https://example.com/some/page",
  "title": "Launch post",
  "enabled": true,
  "clickCount": 1234,
  "cacheSynced": true,
  "campaign": null,
  "utm": null,
  "createdAt": "2026-09-23T04:12:09Z",
  "updatedAt": "2026-09-23T04:12:09Z"
}
```

- `campaign` and `utm` were added by the campaign amendment (see *Campaigns* below): both are `null` on a plain link, even when its destination carries UTM parameters.

- `shortUrl` is computed from the request's `Host`, so an instance reachable on both `workers.dev` and its own domain returns whichever hostname the caller used.
- `title` is `null` when unset. `clickCount` is the exact lifetime total (ADR 0005). `cacheSynced: false` is the *sync pending* state (ADR 0004), never an error.
- `enabled` is the resource's spelling of the glossary's *disabled link*: `PATCH {"enabled": false}` disables, `{"enabled": true}` re-enables. Chosen over `disabled` because a positive boolean reads naturally in both directions; the cache entry's `disabled` flag (ADR 0004) is internal and unaffected.

| Method and path | Effect | Success |
|---|---|---|
| `POST /links` | Create. Body `{destination, slug?, title?}`; with `slug` it is a custom slug, without it a generated one. | `201` + Link |
| `GET /links` | List, newest first. | `200` + page |
| `GET /links/:slug` | Read one. | `200` + Link |
| `PATCH /links/:slug` | Edit `destination`, `title`, `enabled`. | `200` + Link |
| `DELETE /links/:slug` | Hard delete; frees the slug (ADR 0002). | `204` |

- **Merge-patch semantics**: only fields present in the body change. `"title": null` clears the title. `slug` in a `PATCH` body is rejected with the field code `slug_immutable`; unknown fields are rejected with `unknown_field` (also on `POST`). An empty `{}` patch returns `200` and still rewrites the cache entry, so retrying any write repairs the cache as ADR 0004 requires.
- Rejected: `POST /links/:slug/disable` / `enable` action routes. Enable/disable is a field of the link, and one `PATCH` keeps the verb count at four.
- `PATCH` and `DELETE` on an unknown slug answer `404`; `DELETE` is deliberately not idempotent-`204` so a script can tell "deleted" from "never existed". `POST /links` with a taken custom slug answers `409 slug_taken`. Duplicate destinations always create a new link (ADR 0002); an `Idempotency-Key` header is out of v1.

### Listing

- `GET /links?limit=50&cursor=…&q=…`. Order is `createdAt desc, slug desc`. `limit` defaults to 50, maximum 200. Response: `{"items": [Link, …], "nextCursor": "…" | null}`.
- The cursor is an **opaque** base64url encoding of `createdAt|slug`; an undecodable cursor is `400 cursor_invalid`. Rejected: page numbers, which skip or repeat rows while links are created and deleted.
- `q` is a plain substring match (`LIKE '%q%'`) over slug, title and destination. No other filters in v1.
- The list reads D1 only; per-link sparklines come from the instance stats resource below, so the D1 list is never coupled to an Analytics Engine query.

### Stats (click breakdowns)

- `GET /links/:slug/stats?range=7d&tz=Asia/Seoul` returns all four breakdowns of ADR 0005 in one response: `{"range", "tz", "series": [{"start", "clicks"}], "countries": [{"country", "clicks"}], "referrerHosts": [{"host", "clicks"}], "deviceClasses": [{"deviceClass", "clicks"}]}`. `series` fills empty buckets with `0` (hourly for `24h`, daily otherwise); the three top lists hold at most 10 entries, descending.
- `GET /stats?range=7d&tz=…` is the **instance overview**: `{"today", "last7d", "last30d", "topLinks": [{"slug", "clicks"}], "seriesBySlug": {"<slug>": [{"start", "clicks"}]}}`. `seriesBySlug` covers every slug with a click in the range (one `GROUP BY index1, bucket` query), which is what the admin feed's sparklines draw from.
- `range` is one of `24h|7d|30d|90d` (default `7d`); `tz` is an IANA zone name (default `UTC`). Anything else is `validation_failed`.
- Numbers are last-90-days estimates (`sum(_sample_interval)`); the OpenAPI descriptions say so, and no per-response `estimated` flag is sent.
- **Unavailable**: when the `ANALYTICS_TOKEN` secret is missing, both endpoints answer `503 analytics_unavailable`. The settings resource exposes `analyticsConfigured` so the admin surface can hide the panels without provoking the error. Rejected: `200` with `available: false`, which scripts would mistake for empty data.

### Campaigns

Added by [Decide: public API for campaigns and UTM](https://github.com/sunwjy/furea/issues/32), building on ADR 0005 (section *Campaigns*), ADR 0012 (campaigns), ADR 0013 (screening) and ADR 0014 (UTM composition). Everything here is additive within v1.

#### Campaign resource

```json
{
  "id": "k3Xq9vTzPa2W",
  "name": "Spring launch",
  "utmCampaign": "Spring launch",
  "utmId": null,
  "baseUrl": "https://example.com/spring",
  "linkCount": 12,
  "enabledLinkCount": 11,
  "clickCount": 4821,
  "syncPendingLinkCount": 0,
  "createdAt": "2026-09-24T02:00:00Z",
  "updatedAt": "2026-09-24T02:00:00Z"
}
```

- `id` is a random 12-character string from the slug alphabet, like an API key id.
- `linkCount`, `enabledLinkCount`, `clickCount` (sum of the members' exact lifetime totals) and `syncPendingLinkCount` are computed from D1 on every read, never stored (ADR 0005 rejected a campaign counter), and are read-only (`read_only_field`). They are what the admin surface's campaign list shows without further calls.
- `utmCampaign` omitted on create defaults to the trimmed `name`, case kept (ADR 0012); no slugifying. A UTM campaign already used by another campaign is allowed and not reported by the API; the admin surface checks with `GET /campaigns?q=`.
- A campaign link's Link resource carries `"campaign": {"id", "name"}` and `"utm": {"source", "medium", "content", "term"}` (`content`/`term` may be `null`): the link's own UTM parameters. The campaign's shared values are on the campaign.

#### Endpoints

| Method and path | Effect | Success |
|---|---|---|
| `POST /campaigns` | Create. Body `{name, baseUrl, utmCampaign?, utmId?, screening?}`. | `201` + Campaign |
| `GET /campaigns` | List, `createdAt desc, id desc`, cursor-paginated exactly like `/links` (`limit` 50, max 200); `q` matches name and UTM campaign. | `200` + page |
| `GET /campaigns/:id` | Read one. | `200` + Campaign |
| `PATCH /campaigns/:id` | Merge-patch `name`, `baseUrl`, `utmCampaign`, `utmId`, `screening?`. A change to any of the last three rewrites every member link (ADR 0012). | `200` + Campaign + `"rewrittenLinkCount"` |
| `DELETE /campaigns/:id` | Delete; detaches every member, never deletes or disables links. | `204` |
| `GET /campaigns/:id/links` | All members as Link resources, unpaginated (at most 50), `createdAt asc, slug asc`. | `200` + `{"items"}` |
| `POST /campaigns/:id/links` | Bulk creation, all-or-nothing. Body `{"items": [{"utm": {source, medium, content?, term?}, "slug"?, "title"?}], "screening"?}`; also the only way to create a single campaign link. | `201` + `{"items": [Link]}` |
| `PATCH /campaigns/:id/links` | Disable all / enable all: body `{"enabled": bool}`, sets `enabled` on every member (no campaign state). | `200` + `{"updated": n}` |
| `GET /campaigns/:id/stats` | The campaign view's breakdowns (below). | `200` |

- `POST /links` stays plain-only; it has no `campaign` or `utm` field.
- `PATCH /campaigns/:id` takes no "expected link count" guard: the admin surface confirms the count it shows, and a link added meanwhile is rewritten correctly anyway.
- `PATCH /campaigns/:id/links` is a merge-patch applied to each member; `enabled` is its only field in v1. Chosen over action routes (`/disable-all`) for the same reason enable/disable is a field on a link.

#### Membership through `PATCH /links/:slug`

- `{"utm": {...}}` edits a campaign link's own UTM parameters (merge-patch inside `utm`; `source`/`medium` cannot be set to `null`); the Worker recomposes the destination with the shared ADR 0014 functions. Not screened: the host is the campaign's.
- `{"campaign": null}` **detaches**. `{"campaign": {"id": "…"}}` **adopts** a plain link; the Worker reads the UTM parameters out of its destination and rewrites it to the canonical form (ADR 0014). `campaign.name` is read-only.
- A link already in another campaign cannot be moved in one step: detach first (`409 campaign_member`). A direct move would combine two changes whose partial failure is hard to explain, and a destination rarely matches a second campaign.
- `destination` on a campaign link is refused (`destination_campaign_owned`); `utm` on a plain link is refused (`utm_requires_campaign`).
- Rejected: action routes such as `POST /campaigns/:id/adopt` and `DELETE /campaigns/:id/links/:slug` for detach. A link stays addressed by its slug alone, and a `DELETE` that does not delete the link would invite exactly the wrong mistake.

#### Campaign stats

`GET /campaigns/:id/stats?range=7d&tz=…` runs the four queries of ADR 0005 (section *Campaigns*):

```json
{
  "range": "7d", "tz": "Asia/Seoul",
  "series": [{"start", "clicks"}],
  "countries": [...], "referrerHosts": [...], "deviceClasses": [...],
  "bySlug": {"<slug>": {"clicks": 120, "series": [{"start", "clicks"}]}}
}
```

- `series` and the three top lists are combined over all current members, shaped like `/links/:slug/stats`. `bySlug` holds **every** current member, zero-filled, so the campaign comparison's rows are complete from one response (unlike `/stats`'s `seriesBySlug`, which holds only slugs with clicks).
- The comparison's UTM values, lifetime totals and enabled flags come from `GET /campaigns/:id/links`; the client joins the two by slug and folds by source or medium itself. Analytics Engine data and D1 data are never mixed in one response.
- Without the analytics token it answers `503 analytics_unavailable` like the other stats resources; the D1 responses alone still give the lifetime comparison.

#### Campaign errors

- **Bulk creation** reports every failing item in one `400 validation_failed`, conflicts included, because the request is one unit: `{"field": "items[2].slug", "code": "slug_taken"}`, `{"field": "items[4].utm", "code": "utm_combination_taken", "conflictsWith": {"slug": "Ab3xYz"}}` (or `{"item": 1}` for a collision inside the request), the message naming the colliding value as stored. Single writes keep their own classes (`409 slug_taken` on `POST /links`, `409 utm_combination_taken` on `PATCH /links/:slug`).
- **Cap**: creating or adopting past the 50-link cap (ADR 0012) is `409 campaign_link_limit`, a request-level code.
- **Campaign edit too long**: a rewrite that would push any member past 2048 characters is `400 validation_failed` with one `{"field": "baseUrl", "code": "rewrite_too_long", "slug"}` entry per offending link (ADR 0014); nothing is written.
- **Adopt refused**: `409 adopt_mismatch`; the message is the human-readable reason and `details` carries one reason code: `base_url_mismatch`, `utm_campaign_mismatch`, `utm_id_mismatch`, `utm_missing`, `duplicate_utm_key`, `utm_combination_taken`.
- **Screening** (ADR 0013): campaign creation and rewriting edits are screened; a bulk creation's items all share the base URL's host, so a flagged request's `details` is the single `{"field": "baseUrl", "host"}`.
- Field codes added: `base_url_has_utm`, `destination_campaign_owned`, `utm_requires_campaign`, `utm_combination_taken`, `rewrite_too_long`. Top-level codes added: `campaign_name_taken` 409, `campaign_member` 409, `campaign_link_limit` 409, `adopt_mismatch` 409, `utm_combination_taken` 409.

#### Not added

- No `?campaign=` filter on `GET /links` and no campaign name in its `q` (`GET /campaigns/:id/links` covers it; both stay addable within v1). `/stats` is unchanged and counts campaign links like any other link; campaigns are not in the instance overview (ADR 0005).
- No endpoint for UTM parsing, composition or previously used values (ADR 0014).

### Settings

- `GET /settings` and `PATCH /settings` on one document: `{"rootDestination": "https://…" | null, "access": {"teamDomain", "aud"} | null, "analyticsConfigured": true | false, "version": "1.2.3"}`.
- `rootDestination` follows link-destination validation and is written through to the redirect cache under the reserved `_` key (ADR 0008). `null` unsets it.
- `access` turns Access mode (ADR 0003) on or off. Enabling is refused with `409 access_requires_own_domain` when the request's `Host` ends in `.workers.dev`: the Worker holds no deploy token and cannot ask Cloudflare whether a custom domain exists, so "the operator reached the admin surface through their own domain" is the proof. It is also refused with `409 access_unreachable` when the team's public keys cannot be fetched. Disabling is allowed from any host.
- `analyticsConfigured` and `version` are read-only; sending them in a `PATCH` is `validation_failed` / `read_only_field`. The analytics token itself is a Worker secret the instance cannot set; it is placed by the installer (ADR 0006).
- Password change is its own action, `POST /password` with `{"currentPassword", "newPassword"}`, because it requires re-authentication.

### Authentication endpoints

| Method and path | Effect |
|---|---|
| `GET /auth/login` | Which door is open: `{"method": "password" \| "access"}`. Unauthenticated, so the admin surface's login page can show the Access screen before any password is typed. Added by [Prototype: admin surface screens beyond the link feed](https://github.com/sunwjy/furea/issues/20). |
| `POST /auth/login` | Body `{"password"}`. Success `204` + `Set-Cookie` (ADR 0003). Failures: `401 invalid_password`, `429 rate_limited` + `Retry-After`, `403 login_disabled` while Access mode is on. |
| `POST /auth/logout` | Deletes the session row, clears the cookie. `204`. |
| `GET /auth/session` | Who the caller is: `{"kind": "session" \| "access" \| "apiKey", "scope": "read" \| "write", "apiKey": {"id", "name"} \| null}`. |
| `GET /api-keys` | Full array, unpaginated: `{"id", "name", "prefix", "scope", "createdAt", "lastUsedAt" \| null}`. |
| `POST /api-keys` | Body `{"name", "scope"}`. `201` with the resource plus `"key": "furea_…"`, shown this once. |
| `DELETE /api-keys/:id` | Revoke. `204`, or `404`. |

- `id` is a random 12-character string from the slug alphabet, generated at creation; the 8-character `prefix` (ADR 0003) is for recognition only and may collide.

## Who may call what

The rule: **an API key cannot change authentication.** Creating or revoking API keys, changing the operator password, changing Access mode and logging out are session-only (browser session or Access JWT). A leaked `write` key can therefore alter links and the root destination but never mint itself a successor or lock the operator out.

| Endpoint | no auth | `read` key | `write` key | session |
|---|---|---|---|---|
| `GET`/`POST /auth/login`, `GET /openapi.json` | ok | ok | ok | ok |
| `GET /auth/session` | 401 | ok | ok | ok |
| `GET /links*`, `GET /campaigns*`, `GET /stats*`, `GET /settings` | 401 | ok | ok | ok |
| `POST`/`PATCH`/`DELETE /links*` and `/campaigns*`, `PATCH /settings` (`rootDestination`) | 401 | 403 | ok | ok |
| `PATCH /settings` (`access`), `/api-keys*`, `POST /password`, `POST /auth/logout` | 401 | 403 | 403 | ok |

Campaign deletion and disable-all stay at `write`: the rule concerns authentication, a disable-all does no more than a script disabling links one by one, and deleting a campaign only detaches.

`403` carries `code: "forbidden"` and a message naming the missing scope or "session required". Cookie-authenticated mutating requests must pass the `Origin` check from ADR 0003.

## Requests and errors

- Bodies are JSON only: any other `Content-Type` is `415 unsupported_media_type`; malformed JSON is `400 invalid_json`; bodies over 64 KiB are `413`.
- Titles are trimmed, at most 200 characters; an empty title is stored as `null`.
- Every error is `{"error": {"code": "<snake_case>", "message": "<English, human-readable>", "details"?: [...]}}` with the HTTP status carrying the class. Rejected: RFC 9457 Problem Details, whose `type` URIs and media type add ceremony that a shell script reading `.error.code` does not need.
- Validation errors (produced by one middleware, ADR 0018) are `400 validation_failed` with `details: [{"field", "code", "message"}]`, one entry per failing field, so a request with a reserved slug **and** a self-referencing destination reports both. Field codes: `slug_invalid`, `slug_reserved`, `slug_immutable`, `destination_invalid`, `destination_self`, `title_too_long`, `unknown_field`, `read_only_field`, plus range/tz codes for stats and the campaign field codes listed under *Campaigns*. A schema failure with no specific code (a missing or mistyped field) is reported as `invalid` ([#42](https://github.com/sunwjy/furea/issues/42)).
- Top-level codes: `validation_failed` 400, `invalid_json` 400, `cursor_invalid` 400, `unauthorized` 401, `invalid_password` 401, `forbidden` 403, `login_disabled` 403, `not_found` 404, `slug_taken` 409, `campaign_name_taken` 409, `campaign_member` 409, `campaign_link_limit` 409, `adopt_mismatch` 409, `utm_combination_taken` 409, `access_requires_own_domain` 409, `access_unreachable` 409, `payload_too_large` 413, `unsupported_media_type` 415, `destination_flagged` 422, `rate_limited` 429, `internal` 500, `analytics_unavailable` 503.
- Destination screening (ADR 0013): any write that sets a destination (links, root destination, campaigns) may answer `422 destination_flagged` with `details: [{"field", "host"}]`; a body field `"screening": "skip"` overrides the verdict and is accepted from a session only (`403 forbidden` from an API key).

## Cross-origin

The API sends **no CORS headers**. The admin surface is same-origin, and scripts run server-side with a bearer key. Opening CORS would invite operators to embed API keys in browser code on other sites; if a bookmarklet use case ever matters it is a new decision.

## Consequences

- `packages/shared` owns the zod schemas for every request and response above, and the OpenAPI document is derived from them, so the schemas are the contract for the Worker, the admin surface and the published docs alike.
- D1 gains a `settings` row for `root_destination` (ADR 0008) next to the existing auth settings, and `api_keys` gains an `id` column.
- The admin surface's remaining screens (login, API keys, settings, degraded analytics layout) can now be designed against a fixed contract.
- A campaign link's `utm` is parsed from its stored destination with the ADR 0014 functions, so the destination stays the only stored form of UTM parameters; the OpenAPI snapshot grows by the Link fields `campaign` and `utm`, the nine `/campaigns*` operations and the codes above, all additive.
- Link-creation rate limiting, if added, slots in as `429 rate_limited` on `POST /links` without changing any shape (ADR 0013 decided not to add it in v1).
