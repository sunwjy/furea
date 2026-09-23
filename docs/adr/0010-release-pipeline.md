---
status: accepted
date: 2026-09-23
---

# Releases: a changesets release PR merged by the maintainer publishes `furea` from one GitHub Actions workflow via npm trusted publishing; snapshots are the only pre-release channel in 0.x

A release of furea is cut by **merging the changesets release PR** on `main`. That merge re-runs the single workflow `.github/workflows/release.yml`, which builds, tests, checks the tarball and publishes `furea` to npm with **trusted publishing (OIDC)**; no long-lived npm token exists anywhere. The same workflow file, on manual dispatch, publishes a **snapshot** of any branch under the `snapshot` dist-tag. There is no `next`/`beta` channel while the package is at 0.x.

Decided in [Decide: release pipeline from changeset merge to npm publish](https://github.com/sunwjy/furea/issues/18), building on ADR 0007 (one published package, changesets, `pnpm pack` as the artifact) and ADR 0006 (expand-only migrations applied before upload).

## Publishing identity

- **npm trusted publishing** from GitHub Actions. The trusted publisher entry on the `furea` package names the repository `sunwjy/furea`, the workflow file `release.yml` and the GitHub environment `npm-publish`. Provenance attestations are generated automatically because the repository and the package are both public.
- The workflow's publish jobs run with `id-token: write` and inside the `npm-publish` environment, so branch and reviewer protection can be added there without touching the workflow.
- No `NPM_TOKEN` secret is created. `actions/setup-node` is used **without** `registry-url`, because that input writes a placeholder auth token that makes npm skip the OIDC exchange. Node 24 is used so the bundled npm is ≥ 11.5.1.
- **Bootstrap**: trusted publishing can only be configured on a package that already exists, so the first real release (`0.1.0`) is published by the maintainer from a local checkout with a 2FA-protected account, and the trusted publisher is configured right after. No empty placeholder version is published, because bare `npx furea` would run it.
- Because the trusted publisher binds one workflow filename, **every publish path lives in `release.yml`** (release and snapshot as separate jobs selected by event). Renaming the file breaks publishing until the npm-side entry is updated.

## Channel scheme

- `latest` is the only channel that bare `npx furea` resolves. It moves only through the release PR.
- **Snapshot**: `workflow_dispatch` on any branch runs `changeset version --snapshot <short-sha>` and `changeset publish --no-git-tag --tag snapshot`, producing versions such as `0.0.0-abc1234-20260923120000` that install with `npx furea@snapshot` (or the exact version). Snapshots are how a build is tried against a real Cloudflare account before it becomes `latest`; they are never promoted, and ADR 0006's version gate treats a snapshot as older than any release.
- **No `next`/`beta` dist-tags in 0.x.** Changesets pre mode is not entered. Revisit when a 1.0 release needs a staged rollout.

## Considered options

1. **Release PR merge → CI publish with OIDC** (chosen).
2. Maintainer runs `changeset publish` locally. Rejected: loses provenance and depends on a local npm login.
3. Hand-pushed `v*` tag triggers publish. Rejected: version file and tag can disagree; the release PR already is the human gate.
4. Long-lived granular npm token in a GitHub secret. Rejected: trusted publishing removes the secret entirely at the cost of one manual bootstrap publish.
5. `next` dist-tag via changesets pre mode from the start. Rejected for 0.x: nobody to consume it yet; snapshots cover try-before-latest.

## Consequences

- The `npm-publish` environment and the trusted publisher entry are one-time manual setup steps recorded in `docs/release.md`.
- CI on pull requests (`ci.yml`) runs the same build, tests, lint and tarball check as the publish job, so a red release job means infrastructure, not code.
- A snapshot deployed to an instance must be replaced by a proper release afterwards; `furea status` reports the snapshot version as-is.
