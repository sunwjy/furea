---
status: accepted
date: 2026-10-07
---

# Worker request validation through one in-house middleware over the `shared` zod schemas; OpenAPI assembled from `z.toJSONSchema()`

The Worker validates request bodies and query strings with a small **in-house Hono middleware** that runs the `shared` zod schema's `safeParse` and, on failure, answers ADR 0009's `400 validation_failed` envelope. The OpenAPI 3.1 document is **assembled by the Worker** from zod 4's built-in `z.toJSONSchema()` and a hand-written list of paths. The Worker keeps `@cloudflare/workers-types` with a hand-written `Env` instead of generating types with `wrangler types`.

Decided with the maintainer while setting up the walking skeleton ([#41](https://github.com/sunwjy/furea/issues/41)), before the first endpoints ([#42](https://github.com/sunwjy/furea/issues/42)). Builds on ADR 0007 (schemas in `shared` are the contract) and ADR 0009 (error envelope, OpenAPI document).

## Validation middleware

- One module in `apps/worker/src/api/` maps a `ZodError` to `details: [{"field", "code", "message"}]` with ADR 0009's field codes, so every endpoint reports every failing field the same way. Domain checks that need more than the schema (slug taken, destination is the instance itself) add entries to the same `details`.
- Rejected: `@hono/zod-validator`. Its default response is a different shape; every route would need a hook that rewrites it, which is the in-house middleware with an extra dependency in front.

## OpenAPI document

- zod 4 (`zod` as a dependency of `packages/shared`) converts each schema with `z.toJSONSchema()`; a Worker function puts them into the paths, parameters and responses of `GET /api/v1/openapi.json`. The OpenAPI snapshot test (`docs/testing.md`) calls the same function.
- Rejected: `@hono/zod-openapi`. It ties the document to Hono route definitions, while ADR 0007 keeps the contract in `shared` schemas, independent of the Worker's routing. Rejected: `zod-openapi` and `@asteasolutions/zod-to-openapi`: what they add over `z.toJSONSchema()` (component registration, path builders) is a few dozen lines for about twenty operations.

## Worker types

- `@cloudflare/workers-types` plus a hand-written `Env` in `apps/worker/src/core/env.ts`. With eight bindings the interface is cheap to keep by hand, and the manifest test already checks the binding names against `wrangler.jsonc`.
- Rejected for now: `wrangler types`. It is Cloudflare's recommended path and matches runtime types to the compatibility date, but it adds a generated file and a generation step before `tsc`. Revisit if the types package stops tracking the runtime.

## Consequences

- `packages/shared` gains `zod` as its only runtime dependency (Web Crypto only still holds: zod has no platform APIs).
- The API tickets write schemas in `shared`, route handlers in `apps/worker/src/api/`, and one entry in the OpenAPI path list per operation.
