# Changesets

A pull request that changes what `furea` users see adds one file here with `pnpm changeset`. Only `furea` (`packages/cli`) is versioned; the `@furea/*` workspace packages are private and ship inside it (ADR 0007).

A changeset that adds a migration names it on a line of its own, `Migration: 0003_add_sessions.sql`, which CI checks. Bumps, the release PR and publishing are described in [`docs/release.md`](../docs/release.md).
