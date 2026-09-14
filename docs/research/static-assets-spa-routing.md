# Does the Static Assets SPA fallback stay confined to `/admin/*`?

Research for issue #12 (part of #1). Date: 2026-09-14.

**Question.** ADR 0001 keeps Cloudflare's default assets-first routing: the admin SPA lives under `/admin/` as Workers Static Assets with `not_found_handling: single-page-application`, and every other path (`/abc123`) must reach the Worker's redirect handler. Does that actually hold?

Sources are primary only: developers.cloudflare.com and `cloudflare/workers-sdk` on GitHub (`main` on the date above). Each claim carries its URL. The runtime routing logic lives in `packages/workers-shared` (the "router Worker" and "asset Worker" that Cloudflare deploys in front of every Worker with assets); the same code runs locally in Miniflare, so it is the authoritative description of the routing rules.

---

## Summary

| # | Question | Answer |
|---|---|---|
| 1 | Does `/abc123` reach the Worker with `run_worker_first` unset? | **Only for non-navigation requests, or when no `/index.html` exists at the assets root.** With `single-page-application` and a compatibility date ≥ 2025-04-01, a browser navigation (`Sec-Fetch-Mode: navigate`) to `/abc123` is served the root `/index.html` with `200` and never invokes the Worker. |
| 2 | Can the SPA fallback be confined to `/admin/*`? | **No.** The fallback is global and hard-coded to `/index.html` at the assets root. `html_handling` only rewrites near-matches to existing files; it does not scope the fallback. |
| 3 | Minimal `run_worker_first` to keep `/admin/*` on assets and everything else Worker-first? | `["/*", "!/admin/*"]` (negative rules win). Everything except `/admin/*` is then a billable Worker request, including navigations that would otherwise have been free. But see the recommendation: furea does not need `run_worker_first` at all. |
| 4 | Multipart `assets.config` vs `wrangler.json`? | Same fields, same semantics. Wrangler copies `html_handling`, `not_found_handling` and `run_worker_first` verbatim into `metadata.assets.config`; the rule parser and limits are identical. |

**Recommendation.** Keep default assets-first routing (no `run_worker_first`), but drop `single-page-application` mode: set `not_found_handling: "none"` and let the Worker serve the admin shell for `/admin/*` deep links through the `ASSETS` binding. Details in §5.

---

## 1. Routing rule when a Worker script is present and `run_worker_first` is unset

### 1.1 Documented rule

"If you have both static assets and a Worker script configured, Cloudflare will first attempt to serve static assets if one matches the incoming request. ... If an appropriate static asset if not found, Cloudflare will invoke your Worker script." https://developers.cloudflare.com/workers/static-assets/routing/worker-script/

That sentence is incomplete for SPA mode. The SPA page adds: "If you have a Worker script (`main`), have configured `assets.not_found_handling`, and use the `assets_navigation_prefers_asset_serving` compatibility flag (or set a compatibility date of `2025-04-01` or greater), *navigation requests* will not invoke the Worker script. A *navigation request* is a request made with the `Sec-Fetch-Mode: navigate` header, which browsers automatically attach when navigating to a page." It then warns: "if you navigate to `/api/date` in your browser, you will be served an HTML file." https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/#navigation-requests

The compatibility-flag entry says the same: navigation requests "will prefer to be served by our asset-serving logic, even when an exact asset match cannot be found ... the fallback pages of `200 /index.html` and `404 /404.html` will be served ahead of invoking a Worker script." Default as of `2025-04-01`; disable with `assets_navigation_has_no_effect`. https://developers.cloudflare.com/workers/configuration/compatibility-flags/#navigation-requests-prefer-asset-serving

The full decision diagram on the SPA page encodes the order: `run_worker_first` match → Worker; negative match → assets; otherwise "Request matches asset?" → yes: assets; no: "Worker script present?" → yes: "Request is navigation request?" → yes: asset serving (SPA rewrite to `/index.html`); no: Worker. https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/#reference

### 1.2 The code

Router Worker (`packages/workers-shared/router-worker/src/worker.ts`), after the `static_routing` and `invoke_user_worker_ahead_of_assets` branches:

```ts
const assetsExist = await this.env.ASSET_WORKER.unstable_canFetch(new Request(request.url, { headers, method }));
if (config.has_user_worker && !assetsExist) {
    return await routeToUserWorker({ asset: "none" });
}
return await routeToAssets({ asset: assetsExist ? "found" : "none" });
```
https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-shared/router-worker/src/worker.ts

Asset Worker `canFetch` (`packages/workers-shared/asset-worker/src/handler.ts`) decides whether the not-found fallback participates in that check:

```ts
const shouldKeepNotFoundHandling =
    configuration.has_static_routing ||
    (flagIsEnabled(configuration, SEC_FETCH_MODE_NAVIGATE_HEADER_PREFERS_ASSET_SERVING) &&
        request.headers.get("Sec-Fetch-Mode") === "navigate");
if (!shouldKeepNotFoundHandling) {
    configuration = { ...configuration, not_found_handling: "none" };
}
```
https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-shared/asset-worker/src/handler.ts

and the SPA branch of `notFound` looks for exactly one file:

```ts
case "single-page-application": {
    const eTag = await exists("/index.html", request);
    if (eTag) { return { asset: { eTag, status: OkResponse.status }, ... }; }
    return null;
}
```
(same file). When `getIntent` returns `null`, `getResponseOrAssetIntent` returns `NoIntentResponse`, `canFetch` returns `false`, and the router dispatches to the user Worker.

The unit tests pin this down: with `not_found_handling: single-page-application` and no static routing, `canFetch("/bar")` is `false` (Worker) for a plain request, and the navigation table `[{}, false], [{ "Sec-Fetch-Mode": "navigate" }, true], [{ "Sec-Fetch-Mode": "cors" }, false]` shows that only `navigate` flips it. https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-shared/asset-worker/tests/handler.test.ts

### 1.3 Consequence for furea's `/abc123`

Under ADR 0001 as written (assets directory contains the admin SPA, `single-page-application`, compat date 2026):

| Request for `/abc123` | Root `/index.html` in assets? | Result |
|---|---|---|
| Browser click / address bar (`Sec-Fetch-Mode: navigate`) | yes | **`200` root `index.html`, Worker never runs, redirect broken** |
| Browser navigation | no | falls through to Worker (fallback finds nothing) |
| `curl`, bots, `fetch()`, link previews (no `navigate` header) | either | Worker |

A short-link service's core traffic is exactly the navigation case, so ADR 0001's assumption that "every other path must reach the Worker" is false whenever a root `/index.html` is present.

---

## 2. Is the SPA fallback scoped to the assets' path prefix?

**No.** `not_found_handling` is a single global setting per Worker, and the SPA fallback file is hard-coded to `/index.html` at the root of the assets directory (code in §1.2; diagram label "Request rewritten to /index.html" on https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/#reference). There is no per-prefix configuration for it in `wrangler.json` (https://developers.cloudflare.com/workers/wrangler/configuration/#assets) or in the upload metadata (https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/).

Two corollaries for an SPA that lives at `/admin/`:

- If the assets directory is `dist/` containing `admin/index.html` and `admin/assets/*`, there is no `/index.html`, so the SPA fallback never fires: `/admin/links` (a client-side route) gets no asset intent and falls through to the Worker. `single-page-application` mode contributes nothing in this layout.
- The `404-page` mode, by contrast, *does* walk up the directory tree (`while (cwd) { cwd = cwd.slice(0, cwd.lastIndexOf("/")); exists(`${cwd}/404.html`) }`), so a `/admin/404.html` would be found for `/admin/anything`. But it returns `404`, not `200`, so it is not an SPA fallback (same `handler.ts`).

The "Serving a subdirectory" page is about a Worker attached to a *route* such as `example.com/blog/*`; assets must mirror the path (`dist/blog/index.html`), and it notes that files outside the routed path "will not be served, unless it is part of the `assets.not_found_handling`", i.e. the root `/index.html` fallback still applies under the routed prefix. It does not offer a way to move the fallback. https://developers.cloudflare.com/workers/static-assets/routing/advanced/serving-a-subdirectory/

**`html_handling` does not interact with scoping.** It runs first (`getIntent` switches on `html_handling` and only calls `notFound` at the end of each branch) and only redirects or rewrites requests to files that *exist*: `/admin` → `307 /admin/` when `/admin/index.html` exists, `/admin/index.html` → `307 /admin/`, and so on. https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/ With `html_handling: "none"`, unmatched paths go straight to `not_found_handling` (the doc's table: "Depends on `not_found_handling`"). Neither value changes which file the SPA fallback serves.

---

## 3. Minimal `run_worker_first` that keeps `/admin/*` on assets and everything else Worker-first

### 3.1 Semantics

`run_worker_first` is `boolean | string[]`; array entries "must begin with `/` or `!/`", support `*` globs, at most 100 entries. https://developers.cloudflare.com/workers/wrangler/configuration/#assets The API reference adds: "At least one non-negative rule must be provided, and negative rules have higher precedence than non-negative rules" and "`true` ... is equivalent to `["/*"]`". https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/

Router order (`router-worker/src/worker.ts`, §1.2 link): negative (`asset_worker`) rules are evaluated first and short-circuit to assets; then positive (`user_worker`) rules short-circuit to the Worker; only unmatched requests continue to the `canFetch` logic. The glob matcher is `^` + rule with `*` → `.*` + `$` against the pathname (`generateGlobOnlyRuleRegExp` in https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-shared/asset-worker/src/utils/rules-engine.ts), so `/*` matches `/` and every deeper path, and `/admin/*` matches `/admin/` and below but **not** `/admin` without the slash.

Parser rules (`parseStaticRouting`, https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-shared/utils/configuration/parseStaticRouting.ts, "translated from assets/staticrouting.go", the server-side implementation): reject an empty list, more than 100 rules, negative-only lists, duplicates, rules over the length limit, and a rule made redundant by a glob *in the same list* (positive and negative lists are validated separately, so `/*` with `!/admin/*` is accepted; tests in https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-shared/utils/tests/parseStaticRouting.test.ts).

### 3.2 Minimal configuration

```jsonc
"assets": {
  "directory": "./dist/",
  "binding": "ASSETS",
  "not_found_handling": "single-page-application",
  "run_worker_first": ["/*", "!/admin/*"]
}
```

Add `"!/admin"` if the slash-less URL should also stay on assets (it would otherwise hit the Worker, which can redirect it). With any array set, `has_static_routing` is true and `canFetch` keeps `not_found_handling` for *all* requests (§1.2), so the SPA fallback for `/admin/*` no longer depends on the `navigate` header. But the fallback file is still the root `/index.html` (§2), so this only works if the build is laid out with the admin shell at `dist/index.html` and its hashed bundles under `dist/admin/...` (Vite `base: "/admin/"` plus moving `index.html` up one level in furea's manifest builder).

### 3.3 Billing consequence

"Requests to static assets are free and unlimited. Requests to the Worker script ... are billed according to Workers pricing." "When using `run_worker_first`, requests matching the specified patterns will always invoke your Worker script. If you exceed your free tier request limits, these requests will receive a 429 (Too Many Requests) response instead of falling back to static asset serving. Negative patterns (patterns beginning with `!/`) will continue to serve assets correctly." https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ "Requests are only billable if a Worker script is invoked." https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/#reference

With `["/*", "!/admin/*"]`: every `/admin/*` request (shell, JS, CSS, deep links) is free; `/`, `/abc123`, `/admin` (no slash), and any junk path are Worker requests. For a shortener that is the traffic you want to reach the Worker anyway, so the billing profile is the same as the default routing would give *if* it worked. The router's `limitedAssetsOnly` branch returns `429` for any Worker dispatch on an exhausted free tier, static routing or not (`router-worker/src/worker.ts`).

---

## 4. Multipart `assets.config` vs `wrangler.json`

They are the same object. Wrangler's upload form copies the values verbatim:

```ts
const assetConfig: AssetConfigMetadata = {
    html_handling: assets?.assetConfig?.html_handling,
    not_found_handling: assets?.assetConfig?.not_found_handling,
    run_worker_first: assets?.run_worker_first,
    _redirects: assets?._redirects,
    _headers: assets?._headers,
};
// ... metadata: { assets: { jwt, config: assetConfig }, ... }
```
https://github.com/cloudflare/workers-sdk/blob/main/packages/deploy-helpers/src/deploy/helpers/create-worker-upload-form.ts

`run_worker_first` is uploaded as the raw array ("raw static routing rules for upload. routerConfig.static_routing contains the rules processed for dev", https://github.com/cloudflare/workers-sdk/blob/main/packages/deploy-helpers/src/deploy/helpers/assets.ts); the split into positive/negative lists happens server-side (`staticrouting.go`, mirrored by `parseStaticRouting`). The API reference documents `metadata.assets.config.{html_handling, not_found_handling, run_worker_first}` with the same enums and rule constraints (https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/), and the multipart-metadata page lists `html_handling` and `not_found_handling` under `assets.config` (https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/). The only wrangler-side extras are client validation (`Cannot set run_worker_first without a Worker script`, a warning when `run_worker_first: true` is set without `binding`) in `deploy-helpers/src/deploy/helpers/assets.ts`; the platform enforces the same rule-syntax constraints on upload. A deprecated `serve_directly` boolean (`true` = assets first) still exists in the API and should not be sent.

Compatibility date matters equally in both paths: the API defaults to `2021-11-02` when `compatibility_date` is omitted (https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/), which would silently turn *off* navigation-prefers-assets. furea already sets a 2026 date, so the behaviour in §1 applies.

---

## 5. Recommendation for furea

Keep assets-first routing (no `run_worker_first`), stop relying on `single-page-application`, and make the layout explicit:

```jsonc
"assets": {
  "directory": "./dist/",          // contains admin/index.html, admin/assets/*
  "binding": "ASSETS",
  "html_handling": "auto-trailing-slash",
  "not_found_handling": "none"
}
```

Resulting routing (all from §1.2 code):

| Request | Path taken | Billable |
|---|---|---|
| `/admin/assets/app-abc.js`, `/admin/` | exact asset (or `/admin` → `307 /admin/`) | no |
| `/admin/links`, `/admin/links/42` (client routes) | no asset, `not_found_handling: none` → Worker; Worker returns `env.ASSETS.fetch(new URL("/admin/index.html", request.url))` | yes (admin only) |
| `/abc123`, `/`, anything else | no asset → Worker, regardless of `Sec-Fetch-Mode` | yes |

Why this over §3.2:

- It removes the navigation-header dependency entirely instead of neutralising it with static routing, and there is no root `/index.html` that could ever answer a short link.
- The Worker already needs a catch-all handler for slugs; serving the admin shell for `/admin/*` is a two-line addition, and admin deep-link volume is negligible next to redirect volume.
- The upload metadata stays minimal and identical between a hand-rolled `PUT /workers/scripts/{name}` and wrangler (§4).

If the team later wants admin deep links to be free as well, §3.2 (`["/*", "!/admin/*"]` with the shell moved to `dist/index.html`) is the supported route; it changes nothing about which slug requests reach the Worker.

ADR 0001 should be amended: "default assets-first routing keeps `/abc123` on the Worker" is only true with `not_found_handling: "none"` (or without a root `/index.html`); with `single-page-application` and a root shell, browser navigations to short links are hijacked by the SPA fallback.
