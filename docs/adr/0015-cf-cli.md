---
status: accepted
date: 2026-10-01
---

# furea does not depend on the `cf` CLI; one credential path; compatibility stated tool-neutrally

Cloudflare's new `cf` CLI (open beta since 2026-09-28, wrangler's successor) changes nothing in how furea installs: the installer keeps calling the Cloudflare REST API directly (ADR 0006), never drives or requires `cf`, and borrows no CLI session (neither `cf` nor wrangler). The wrangler-compatibility promise is restated as compatibility with Cloudflare's own CLI, wrangler or `cf`, with no new obligation. Development keeps wrangler for now and only follows the vitest pool's rename.

Decided in [Decide: furea's relationship to the cf CLI](https://github.com/sunwjy/furea/issues/36), from [`docs/research/cf-cli.md`](../research/cf-cli.md).

## Installer engine: direct REST API, no `cf`

`cf` has no documented programmatic API, so using it means spawning a ~219 MB binary (Miniflare and `workerd`) that needs Node ≥ 22.18, sends telemetry by default and prints human progress text rather than a JSON result. Its prebuilt path (`cf deploy --prebuilt`) reads a Build Output format marked a "v0" draft, cannot find a KV namespace by title, and does not run D1 migrations, so furea would still order migrations before the upload itself (ADR 0006). None of that buys the operator anything the ~nine REST endpoints do not already do, and `npx furea` stays one command with no prerequisite tool.

Revisit only when `cf` is out of beta **and** publishes a supported programmatic API; that is beyond v1.

## Credentials: the deploy token is the only path

The installer's only credential is the deploy token (ADR 0006): created from the pre-filled dashboard template URL and pasted into `login` (or the first `deploy`), or supplied as `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in CI and scripts. An operator who uses wrangler, `cf` or neither gets the same instructions.

The earlier fallback of borrowing a logged-in wrangler session with `wrangler auth token --json` (research #2) is **dropped**: it was never part of ADR 0006, it leans on a tool entering its 18-month sunset once `cf` leaves beta, and the borrowed token cannot read Analytics Engine anyway ([#23](https://github.com/sunwjy/furea/issues/23)), so the analytics offer needs no wrangler-session variant. `cf` offers nothing to replace it: its session file is internal and undocumented, and there is no token-export command. Minting a token through `cf accounts tokens create` was rejected as untested and dependent on a login that grants several hundred scopes.

## Compatibility promise: wrangler or `cf`

An instance deployed by furea can later be managed with Cloudflare's own CLI, **wrangler or `cf`**. This adds no obligation: `cf d1 migrations` is deliberately wire-compatible with wrangler's `d1_migrations` table and `NNNN_` ordering, and `cf deploy` uses the same blake3 asset hash code. furea keeps matching wrangler's behaviour (ADR 0006, ADR 0007) and does not test against `cf` separately.

## Development tooling

wrangler stays the devDependency of `apps/worker` (`wrangler dev`, local migrations, `wrangler.jsonc`). The Worker test pool moves from `@cloudflare/vitest-pool-workers` (frozen at 0.22.0) to its renamed successor `@cloudflare/vitest-plugin` 1.x in its wrangler-config mode; it still depends on wrangler. Moving development to `cf` (`cloudflare.config.ts`, the Vite plugin 2.0) waits until `cf` is GA or wrangler's final major ships, and is an implementation-time change.
