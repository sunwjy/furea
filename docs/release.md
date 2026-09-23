# Releasing furea

How a change on `main` becomes a published `furea` version. The hard-to-reverse parts (publishing identity, channel scheme) are in ADR 0010; this page holds the working procedure.

## Overview

1. A pull request that changes user-visible behaviour includes a **changeset** (`pnpm changeset`). Only `furea` is versioned (ADR 0007).
2. On merge to `main`, `release.yml` runs `changesets/action`. With pending changesets it opens or updates the **release PR** titled `chore: release furea` (branch `changeset-release/main`), which bumps `packages/cli/package.json`, rewrites `packages/cli/CHANGELOG.md` and deletes the consumed changeset files.
3. The maintainer merges the release PR. `release.yml` runs again, finds no pending changesets and runs `pnpm release`.
4. `pnpm release` = `turbo build` → `turbo test lint typecheck` → tarball check → E2E → Compat check → Integration deploy on the CI account (`docs/testing.md`) → `changeset publish`. On success the action pushes the git tag `furea@<version>` and creates a GitHub Release whose body is the CHANGELOG entry.

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
- No Integration tier on pull requests: fork PRs cannot read the `cloudflare-ci` secrets. A separate `integration` job runs on pushes to `main` and reports without blocking.
- **Tarball check**: `pnpm --filter furea pack --dry-run --json` must list `bin/furea.js`, `dist/cli/index.js`, `dist/worker/index.js`, `dist/worker/manifest.json`, at least one file under `dist/assets/admin/`, `dist/assets/favicon.ico` and every `migrations/*.sql` present in `apps/worker/migrations/`; nothing else outside `package.json`, `README.md` and `LICENSE`. This is the mechanical form of ADR 0007's "the installer can never deploy a Worker of a different version than itself".
- Migration/changeset consistency check (above).

### `release.yml` (one file, two jobs)

Trusted publishing binds one workflow filename, so both publish paths are here.

- **`release` job** — `on: push` to `main`. Permissions `contents: write`, `pull-requests: write`, `id-token: write`; environment `npm-publish`; `concurrency: release`. Steps: checkout with `fetch-depth: 0`, `pnpm/action-setup`, `actions/setup-node` with Node 24 and **no `registry-url`**, install, then `changesets/action` with `version: pnpm changeset version`, `publish: pnpm release`, `createGithubReleases: true`, `commitMode: github-api` (signed commits without a bot key), `title`/`commit`: `chore: release furea`. Env: `GITHUB_TOKEN`, `NPM_CONFIG_PROVENANCE: "true"`, plus `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the `cloudflare-ci` environment for the Integration deploy, which `pnpm release` runs as a **hard gate** before `changeset publish` (`docs/testing.md`).
- **`snapshot` job** — `on: workflow_dispatch` with an optional `ref` input. Permissions `contents: read`, `id-token: write`; environment `npm-publish`. Steps: checkout the ref, same toolchain, install, `pnpm changeset version --snapshot ${SHORT_SHA}`, `pnpm release:snapshot` (= build, tests, tarball check, `changeset publish --no-git-tag --tag snapshot`). No git tag, no GitHub Release.
- Repository setting "Allow GitHub Actions to create and approve pull requests" must be on for the release PR.

### Scripts in the root `package.json`

```json
{
  "changeset": "changeset",
  "release": "turbo run build lint typecheck test && node scripts/check-tarball.mjs && pnpm test:e2e && pnpm test:compat && pnpm test:integration && changeset publish",
  "release:snapshot": "turbo run build lint typecheck test && node scripts/check-tarball.mjs && changeset publish --no-git-tag --tag snapshot",
  "test:e2e": "pnpm --filter admin test:e2e",
  "test:compat": "node scripts/check-expand-only.mjs",
  "test:integration": "node scripts/integration.mjs"
}
```

`.changeset/config.json`: `changelog: ["@changesets/changelog-github", { "repo": "sunwjy/furea" }]`, `privatePackages: { "version": false, "tag": false }`, `baseBranch: "main"`, `access: "public"`.

## One-time setup (maintainer)

1. Enable 2FA on the npm account that will own `furea`.
2. First release: on `main` at the commit that bumps `packages/cli` to `0.1.0`, run `pnpm release` locally with `npm login` done (this is the only publish ever made with a personal login). Push the tag `furea@0.1.0` and create the GitHub Release by hand or by re-running the action.
3. On npmjs.com → `furea` → Settings → Trusted Publishers: GitHub Actions, organization `sunwjy`, repository `furea`, workflow `release.yml`, environment `npm-publish`, allow `npm publish`. Equivalent CLI: `npm trust github furea --repo sunwjy/furea --file release.yml --env npm-publish --allow-publish`.
4. Create the GitHub environments `npm-publish` and `cloudflare-ci` (Settings → Environments); `cloudflare-ci` holds `CLOUDFLARE_API_TOKEN` (deploy-token template of ADR 0006, created on the CI account) and `CLOUDFLARE_ACCOUNT_ID`. Restrict deployment branches to `main` for the release job if desired; snapshots need `workflow_dispatch` refs allowed.
5. Enable "Allow GitHub Actions to create and approve pull requests".
6. Verify with a snapshot dispatch before the first CI-driven release.

## Trying a build before it is `latest`

```sh
gh workflow run release.yml -f ref=my-branch
npx furea@snapshot            # or the exact 0.0.0-<sha>-<timestamp> version
```

Deploy it to a scratch instance (`--name furea-test`) so the production instance never sees a snapshot.
