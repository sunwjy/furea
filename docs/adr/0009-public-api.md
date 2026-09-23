---
status: accepted
date: 2026-09-23
---

# Public API: `/api/v1`, links keyed by slug with merge-patch edits, cursor lists, one error envelope, analytics as separate resources, and API keys that cannot touch authentication

furea v1 exposes one JSON API under **`/api/v1`**, used by the admin surface and by operators' own scripts alike. Links are addressed by slug with four verbs; edits (including enable/disable) are merge-patches; lists are cursor-paginated; every error is one `{"error": {...}}` envelope with a machine code; click breakdowns live on separate `stats` resources that answer `503` when no analytics token is configured; one `settings` resource carries the root destination and Access mode; and **an API key can never create, revoke or otherwise change any credential**. No CORS headers are sent.

Decided in [Decide: public API surface (resources, versioning, error format)](https://github.com/sunwjy/furea/issues/15), building on ADR 0002 (slug rules), ADR 0003 (auth), ADR 0004 (redirect cache), ADR 0005 (click analytics) and ADR 0008 (root destination).

## Versioning

- Every path starts with `/api/v1/`. Within v1 the API only ever **adds** fields, endpoints and enum values; removing or re-meaning anything requires `/api/v2`. Rejected: an unversioned `/api/`, because operators' scripts meet a new Worker every time they run `npx furea@latest deploy` and would have no way to opt out of a breaking change.
- `GET /api/v1/openapi.json` serves an OpenAPI 3.1 document, generated from the zod schemas in `packages/shared` at release time and bundled into the Worker. It needs no authentication: the API's shape is public in the npm package anyway. No viewer page ships in v1.

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
  "createdAt": "2026-09-23T04:12:09Z",
  "updatedAt": "2026-09-23T04:12:09Z"
}
```

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
| `GET /links*`, `GET /stats*`, `GET /settings` | 401 | ok | ok | ok |
| `POST`/`PATCH`/`DELETE /links*`, `PATCH /settings` (`rootDestination`) | 401 | 403 | ok | ok |
| `PATCH /settings` (`access`), `/api-keys*`, `POST /password`, `POST /auth/logout` | 401 | 403 | 403 | ok |

`403` carries `code: "forbidden"` and a message naming the missing scope or "session required". Cookie-authenticated mutating requests must pass the `Origin` check from ADR 0003.

## Requests and errors

- Bodies are JSON only: any other `Content-Type` is `415 unsupported_media_type`; malformed JSON is `400 invalid_json`; bodies over 64 KiB are `413`.
- Titles are trimmed, at most 200 characters; an empty title is stored as `null`.
- Every error is `{"error": {"code": "<snake_case>", "message": "<English, human-readable>", "details"?: [...]}}` with the HTTP status carrying the class. Rejected: RFC 9457 Problem Details, whose `type` URIs and media type add ceremony that a shell script reading `.error.code` does not need.
- Validation errors are `400 validation_failed` with `details: [{"field", "code", "message"}]`, one entry per failing field, so a request with a reserved slug **and** a self-referencing destination reports both. Field codes: `slug_invalid`, `slug_reserved`, `slug_immutable`, `destination_invalid`, `destination_self`, `title_too_long`, `unknown_field`, `read_only_field`, plus range/tz codes for stats.
- Top-level codes: `validation_failed` 400, `invalid_json` 400, `cursor_invalid` 400, `unauthorized` 401, `invalid_password` 401, `forbidden` 403, `login_disabled` 403, `not_found` 404, `slug_taken` 409, `access_requires_own_domain` 409, `access_unreachable` 409, `unsupported_media_type` 415, `rate_limited` 429, `internal` 500, `analytics_unavailable` 503.

## Cross-origin

The API sends **no CORS headers**. The admin surface is same-origin, and scripts run server-side with a bearer key. Opening CORS would invite operators to embed API keys in browser code on other sites; if a bookmarklet use case ever matters it is a new decision.

## Consequences

- `packages/shared` owns the zod schemas for every request and response above, and the OpenAPI document is derived from them, so the schemas are the contract for the Worker, the admin surface and the published docs alike.
- D1 gains a `settings` row for `root_destination` (ADR 0008) next to the existing auth settings, and `api_keys` gains an `id` column.
- The admin surface's remaining screens (login, API keys, settings, degraded analytics layout) can now be designed against a fixed contract.
- Link-creation rate limiting, if added, slots in as `429 rate_limited` on `POST /links` without changing any shape.
