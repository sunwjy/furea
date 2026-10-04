# furea

Self-hosted URL shortener on Cloudflare Workers, D1 and KV. Planning is tracked in the wayfinder map: https://github.com/sunwjy/furea/issues/1

## Development

Requires Node 24 and pnpm (version pinned in `package.json`).

```sh
pnpm install
pnpm test          # Static (oxlint, tsc, builds) + Unit, as CI runs them
pnpm --filter @furea/worker dev   # wrangler dev; apply migrations first with
                                  # pnpm --filter @furea/worker exec wrangler d1 migrations apply DB --local
```

Workspace packages (ADR 0007): `apps/worker` (the Worker), `apps/admin` (the admin surface), `packages/shared` (slug rules and other code shared by all three), `packages/cli` (the installer, published to npm as `furea`). Test tiers are described in `docs/testing.md`.
