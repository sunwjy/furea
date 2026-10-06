---
status: accepted
date: 2026-10-07
---

# Admin surface stack: TanStack Router (file-based) and Query, shadcn on Base UI with Tailwind v4, react-hook-form, English only, system theme, security headers in `_headers`

The admin surface (`apps/admin`, React + Vite, ADR 0007) is built with **TanStack Router** using file-based routes, **TanStack Query** for server state, **shadcn/ui on Base UI** styled with **Tailwind CSS v4**, and **react-hook-form** with the `shared` zod schemas. The UI is English only, follows the operating system's light or dark theme, loads no web fonts, and gets its security headers from a `_headers` file at the Static Assets root.

Decided with the maintainer while setting up the walking skeleton ([#41](https://github.com/sunwjy/furea/issues/41)), before the first screen ([#42](https://github.com/sunwjy/furea/issues/42)) so that every admin ticket builds on one stack.

## Routing: TanStack Router, file-based

- Routes live in `apps/admin/src/routes/`; `@tanstack/router-plugin/vite` generates `src/routeTree.gen.ts`. The generated file is **committed** (TanStack's recommendation, and `tsc` needs it without a build) and excluded from oxlint.
- `createRouter({ basepath: "/admin" })`, matching Vite's `base: "/admin/"`. Deep links work because the Worker answers `/admin/*` navigations with `/admin/index.html` (ADR 0001); the router needs nothing else from the Worker.
- Rejected: code-based routes. Every new screen would edit a central route tree, which is the edit most likely to conflict between tickets.

## Server state and the API client

- **TanStack Query** owns every API read and mutation: cache, invalidation after writes (the link feed, sync-pending badges and their *Retry now*), and loaders through the router context (`queryClient` is passed as router context).
- The API client is a small hand-written `fetch` wrapper in `apps/admin` that parses responses with the `shared` zod schemas and turns the ADR 0009 error envelope into a typed error. A Hono RPC client stays rejected (ADR 0007).

## Components and styling

- **shadcn/ui** with the **Base UI** primitives (`components.json` style `base-nova`), components copied into `src/components/ui/` and linted and type-checked like the rest of the code. Tailwind CSS v4 through `@tailwindcss/vite`, no `tailwind.config` file. Icons: `lucide-react`. Toasts: `sonner`.
- **Theme follows the system**: Tailwind's `dark` variant is bound to `prefers-color-scheme: dark` and the dark tokens sit under the same media query. No manual toggle, so no preference to store.
- **System font stack, no font files.** Nothing is loaded from a third party, which keeps the CSP at `'self'`.
- Charts (shadcn chart on Recharts is the default candidate) and tables (TanStack Table only if a screen needs grouping) are decided by the tickets that first need them (#49, #51, #54).

## Forms

- **react-hook-form** with `@hookform/resolvers` and the `shared` zod schemas, so a field error shown in the form and a `400 validation_failed` detail from the API come from one schema. The campaign row editor (up to 50 rows, ADR 0012) uses `useFieldArray`; spreadsheet paste is parsed by hand.
- Rejected: TanStack Form. It would keep the stack in one family, but react-hook-form is what shadcn's form guidance and most examples assume, and the row editor is its well-trodden case.

## Language

- **English only in v1**, no i18n library. Docs, API error messages and log events are English already; extracting strings later is a mechanical change if translations are ever wanted.

## Security headers

Static Assets answer `/admin/*` before the Worker runs (ADR 0001), so the Worker cannot set headers on the admin shell or its files. `apps/admin/public/_headers` is moved by the build to the assets root (next to `favicon.ico`) and sets, for `/admin/*`:

- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. `style-src` allows inline styles because Base UI positions popups with `style` attributes and sonner injects its stylesheet; scripts stay `'self'` only.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.

The Worker's own responses (redirects, the unknown-slug page, the API) are not covered by `_headers` and set their own headers where needed.

## Consequences

- `apps/admin` gains build-time code generation (the route tree) through a Vite plugin; nothing runs before `tsc` because the generated file is committed.
- A change to the CSP is a change to `apps/admin/public/_headers`, visible in review; the E2E smoke runs against `wrangler dev`, which applies `_headers`, so a CSP that breaks the shell fails E2E.
- No admin component tests in v1 still holds (`docs/testing.md`).
