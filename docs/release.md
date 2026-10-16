# Releasing furea

How a change on `main` becomes a published `furea` version. The hard-to-reverse parts (publishing identity, channel scheme) are in ADR 0010; this page holds the working procedure.

## Overview

1. A pull request that changes user-visible behaviour includes a **changeset** (`pnpm changeset`). Only `furea` is versioned (ADR 0007).
2. On merge to `main`, `release.yml` runs `changesets/action`. With pending changesets it opens or updates the **release PR** titled `chore: release furea` (branch `changeset-release/main`), which bumps `packages/cli/package.json`, rewrites `packages/cli/CHANGELOG.md` and deletes the consumed changeset files.
3. The maintainer merges the release PR. `release.yml` runs again, finds no pending changesets and a version npm does not have, and runs the **Integration gate** (a real install and upgrade on the CI account, `docs/testing.md`) and then `pnpm release`.
4. `pnpm release` = oxlint, script tests, `turbo build typecheck test` → tarball check → migration check → E2E → Compat check → `changeset publish`. On success the action pushes the git tag `furea@<version>` and creates a GitHub Release whose body is the CHANGELOG entry.

## Version meaning in 0.x

| Changeset bump | Use for |
|---|---|
| `patch` | Everything that keeps existing instances, API clients and slugs working. |
| `minor` | A change an operator must know about before upgrading: removed or renamed API field, changed CLI command, a migration that needs a two-release dance, changed default behaviour. |
| `major` | Not used before 1.0. |

**1.0.0** is cut when the v1 scope (redirect, admin surface, custom slugs, click analytics, public API) works on both an own domain and `workers.dev`, and an upgrade from a previous release has been exercised on a real instance.

## Migration-bearing releases

- A changeset that adds a file under `apps/worker/migrations/` includes a line in exactly this form:

  ```
  Migration: 0003_add_sessions.sql
  ```

  One line per file. The line flows into `CHANGELOG.md` and the GitHub Release unchanged.
- `ci.yml` fails a pull request that adds a migration file without a changeset carrying the matching `Migration:` line, and vice versa.
- Such a changeset is at least `patch`; it is `minor` when the migration is the first half of a two-release column drop or rename (ADR 0006).
- At upgrade time `furea deploy` prints the file names of the pending migrations before applying them (ADR 0006).

## The workflows

Both files live in `.github/workflows/`.

### `ci.yml` (pull requests and pushes to `main`)

- `pnpm install --frozen-lockfile`, `turbo build lint typecheck test`, then `pnpm test:e2e`.
- **Compat check** (`pnpm test:compat`) only when the PR touches `apps/worker/migrations/` (path filter); see `docs/testing.md`.
- No Integration tier on pull requests: fork PRs cannot read the `cloudflare-ci` secrets. A separate `integration` job (environment `cloudflare-ci`, `continue-on-error`) runs `pnpm test:integration` on pushes to `main` and reports without blocking.
- **Tarball check**: `pnpm --filter furea pack --dry-run --json` must list `bin/furea.js`, `dist/cli/index.js`, `dist/worker/index.js`, `dist/worker/manifest.json`, at least one file under `dist/assets/admin/`, `dist/assets/favicon.ico` and every `migrations/*.sql` present in `apps/worker/migrations/`; nothing else outside `package.json`, `README.md` and `LICENSE`. This is the mechanical form of ADR 0007's "the installer can never deploy a Worker of a different version than itself".
- Migration/changeset consistency check (above): `node scripts/check-migrations.mjs --base origin/main` (the `migrations` job). Every file in `apps/worker/migrations/` must also open with the expand-only header `-- Expand-only: compatible with the previous release's Worker (ADR 0006).`; that half runs on `main` pushes too.

### `release.yml` (one file, both publish paths)

Trusted publishing binds one workflow filename, so both publish paths are here. A job has one environment, so the Integration gate is its own job: the Cloudflare secrets stay in `cloudflare-ci` and the publishing job in `npm-publish` never sees them.

- **`plan` job** — `on: push` to `main`. `node scripts/release-plan.mjs` outputs `publish=true` only for a merged release PR: no pending changesets in `.changeset/`, a `packages/cli` version other than `0.0.0`, and that version not on npm yet (only npm's `E404` counts as "not on npm"; an unreachable registry fails the job). Ordinary pushes after a release therefore never run the gate or try to publish.
- **`integration` job** — needs `plan`, runs only when `publish=true`; environment `cloudflare-ci`. Builds, then `node scripts/integration.mjs --name furea-ci-rel-<short sha>` (not `ci.yml`'s `furea-ci-<short sha>`, which runs on the same merge commit). This is the **hard gate** before `changeset publish` (`docs/testing.md`): when it fails, the `release` job does not run.
- **`release` job** — needs `plan` and `integration`; runs when `integration` succeeded or was skipped. Permissions `contents: write`, `pull-requests: write`, `id-token: write`; environment `npm-publish`; `concurrency: release`. Steps: checkout with `fetch-depth: 0`, `pnpm/action-setup`, `actions/setup-node` with Node 24 and **no `registry-url`** (it writes an `.npmrc` expecting `NODE_AUTH_TOKEN`, which shadows trusted publishing), install, the Playwright browser when publishing, then `changesets/action` with `version: pnpm changeset version`, `publish: pnpm release` (empty unless `publish=true`, so pending changesets only open or update the release PR), `createGithubReleases: true`, `commitMode: github-api` (signed commits without a bot key), `title`/`commit`: `chore: release furea`. Env: `GITHUB_TOKEN`, `NPM_CONFIG_PROVENANCE: "true"`.
- **`snapshot` job** — `on: workflow_dispatch` with an optional `ref` input. Permissions `contents: read`, `id-token: write`; environment `npm-publish`. Steps: checkout the ref, same toolchain, install, add a `patch` changeset when the ref has none (`changeset version --snapshot` needs one), `pnpm changeset version --snapshot <short sha>` (version `0.0.0-<sha>-<timestamp>`), `pnpm release:snapshot`. No Integration, no git tag, no GitHub Release.
- Repository setting "Allow GitHub Actions to create and approve pull requests" must be on for the release PR.

### Scripts in the root `package.json`

```json
{
  "test": "oxlint && pnpm test:scripts && turbo run build typecheck test",
  "test:e2e": "turbo run test:e2e",
  "test:compat": "node scripts/check-expand-only.mjs",
  "test:integration": "node scripts/integration.mjs",
  "changeset": "changeset",
  "release": "pnpm test && node scripts/check-tarball.mjs && node scripts/check-migrations.mjs && pnpm test:e2e && pnpm test:compat && changeset publish",
  "release:snapshot": "pnpm test && node scripts/check-tarball.mjs && changeset publish --no-git-tag --tag snapshot"
}
```

`pnpm release` does not run Integration itself: in CI the `integration` job gates it, and a local run (the bootstrap below) runs `pnpm test:integration` first.

`.changeset/config.json`: `changelog: ["@changesets/changelog-github", { "repo": "sunwjy/furea" }]`, `privatePackages: { "version": false, "tag": false }`, `baseBranch: "main"`, `access: "public"`. `@changesets/cli` stays on 2.x, the line `changesets/action@v1` parses the publish output of.

## One-time setup (maintainer)

1. Enable 2FA on the npm account that will own `furea`.
2. Create the GitHub environments (Settings → Environments):
   - `cloudflare-ci` with the secrets `CLOUDFLARE_API_TOKEN` (the deploy-token template of ADR 0006, created on the CI account) and `CLOUDFLARE_ACCOUNT_ID`. The CI account needs a workers.dev subdomain already registered (Workers & Pages → the account's subdomain), because the CI runs deploy with `--workers-dev` and nothing is prompted. Restrict it to the `main` branch if desired.
   - `npm-publish`, no secrets. Its deployment branches must allow `main` and every ref a snapshot is dispatched from.
3. Enable "Allow GitHub Actions to create and approve pull requests" (Settings → Actions → General).
4. **Bootstrap `0.1.0`.** Trusted publishing can only be configured on a package that exists, so the first version is published by hand, and it is the only publish ever made with a personal login:
   1. Merge a PR whose changeset bumps `furea` `minor` (0.0.0 → 0.1.0). `release.yml` opens the release PR `chore: release furea`.
   2. Check out the release PR's branch (`changeset-release/main`), `pnpm install --frozen-lockfile`, `npm login`, then with the CI account's credentials in the environment run `pnpm test:integration` and `pnpm release`. With nothing on npm, Compat prints `skip: no previous release` and Integration installs the candidate fresh. `changeset publish` creates the local tag `furea@0.1.0`.
   3. Merge the release PR. The `plan` job sees `furea@0.1.0` on npm and publishes nothing.
   4. Push the tag (`git push origin furea@0.1.0`, pointing at the release PR's commit or its merge) and create the GitHub Release from the `0.1.0` entry of `packages/cli/CHANGELOG.md` (`gh release create furea@0.1.0 --notes-file …`).
5. **Trusted publisher.** On npmjs.com → `furea` → Settings → Trusted Publisher: GitHub Actions, organization or user `sunwjy`, repository `furea`, workflow filename `release.yml`, environment `npm-publish`. Equivalent CLI: `npm trust github furea --repo sunwjy/furea --file release.yml --env npm-publish --allow-publish`. Then, under Publishing access, require 2FA and disallow tokens, so the workflow is the only way to publish.
6. Verify with a snapshot dispatch (`gh workflow run release.yml -f ref=main`) before the first CI-driven release: it proves the OIDC exchange and provenance without touching `latest`.

## Trying a build before it is `latest`

```sh
gh workflow run release.yml -f ref=my-branch
npx furea@snapshot            # or the exact 0.0.0-<sha>-<timestamp> version
```

Deploy it to a scratch instance (`--name furea-test`) so the production instance never sees a snapshot.
