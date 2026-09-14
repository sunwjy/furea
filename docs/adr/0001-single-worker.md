---
status: accepted
date: 2026-09-14
---

# One Worker serves redirects, the admin SPA and the public API

furea v1 deploys a **single Cloudflare Worker** that handles redirects, the public API and the admin SPA (the SPA is served as Workers Static Assets, not from the Worker bundle). Redirect and admin/API are separate Workers only in a possible future effort, never in v1.

Decided in [Decide: single Worker vs separate redirect and admin Workers](https://github.com/sunwjy/furea/issues/5).

## Considered options

1. **Single Worker** (chosen).
2. **Two Workers** (redirect-only Worker plus admin/API Worker sharing D1 and KV).
3. Single Worker, but with code boundaries that keep a later split cheap (chosen refinement of 1).

## Why

- The benefits usually claimed for a split are already available with one Worker:
  - **Cold start / bundle size**: the admin SPA is served by Static Assets and never enters the Worker bundle; only Hono, the API handlers and the redirect handler are in the script.
  - **Cloudflare Access on the admin only**: an Access self-hosted application can be scoped to a host *and path* (`s.example.com/admin`), so the admin can be protected without a separate hostname.
  - **Blast radius**: the installer always ships redirect and admin as one npm version, so "deploy admin without touching redirect" is not a v1 workflow.
- A split roughly doubles what the one-command installer must do (two script uploads, two custom domains or two `workers.dev` names, two binding sets kept in sync) and opens a version-skew window during upgrades.

## Consequences

- **URL layout is path-based on one hostname**: `/admin/*` is the admin SPA, `/api/*` is the public API, everything else is a slug lookup. A separate admin hostname is out of scope for v1 (it could not work on the `workers.dev` fallback anyway, which only gives one subdomain).
- **`admin` and `api` are reserved paths** and can never be slugs. The full reserved list is settled with the slug rules (see the domain-model ticket).
- **Assets are served first** (Cloudflare's default, no `run_worker_first`) so admin asset files never consume the Worker request quota, but the SPA fallback mode is **not** used: `not_found_handling` is `none`. With `single-page-application` and a root `index.html`, Cloudflare serves the shell to any browser navigation that misses an asset, so a click on `/abc123` would never reach the Worker (compatibility date ≥ 2025-04-01; see [Research: does the Static Assets SPA fallback stay confined to /admin/*…](https://github.com/sunwjy/furea/issues/12)). Instead the admin shell lives under `/admin/` and the Worker answers `/admin/*` deep links by returning `/admin/index.html` through the assets binding. Those deep-link navigations are the only admin requests billed as Worker requests. If that ever matters, the documented alternative is `run_worker_first: ["/*", "!/admin/*"]` with the shell moved to the assets root.
- **Code boundary**: the Worker source keeps a `redirect` module and an `api` module; the redirect module must not import from the admin/API side, so a later split stays a packaging change rather than a rewrite.
