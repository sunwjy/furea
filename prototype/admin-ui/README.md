# PROTOTYPE — furea admin UI variants

Throwaway. Variants E/F answer wayfinder ticket [#20](https://github.com/sunwjy/furea/issues/20); A–D answered
ticket [#11](https://github.com/sunwjy/furea/issues/11):
what the link list looks like, how a link is created and edited, what per-link stats show,
and whether SPA-on-Static-Assets feels right versus server-rendered HTML.

```sh
cd prototype/admin-ui
pnpm install
pnpm dev          # opens http://localhost:5173/admin/?variant=E  (mock password: furea-proto)
```

## Ticket #20 — variants E/F (against the ADR 0009 mock under `/api/v1`)

Both variants are the layout confirmed in #11 (tiles + card feed, `/admin/new`, `/admin/links/:slug` with Edit → Save)
plus the screens it lacked: `/admin/login`, API keys, settings, the no-analytics layout and the sync-pending state.
They disagree on one structural question, **where credentials live**:

| Variant | Nav | Settings page | Credentials | New key revealed |
| --- | --- | --- | --- | --- |
| E | Links · API keys · Settings | instance facts, root destination, password, Access | `/admin/keys` | inline banner |
| F | Links · Security · Settings | instance facts, root destination | `/admin/security`: password, Access, API keys | modal |

The pink **⚙ scenario** button (bottom right) flips the mock into the states the ticket asks about and prints the
mock's full state: analytics token missing, reached via `workers.dev`, Access mode on (with or without an Access JWT
on the request → `login_disabled` screen), `access_unreachable`, extra sync-pending links, expired sessions. Five
wrong passwords within a minute trigger `rate_limited` with a live countdown.

| Variant | URL | Shape |
| --- | --- | --- |
| E / F | see above | ticket #20 shell |
| A — Table + pages | `/admin/?variant=A` | top nav, instance tiles, dense table; `/new` and `/links/:slug` are full pages |
| B — Master-detail | `/admin/?variant=B` | one screen: list + quick-create on the left, selected link (fields save on blur, stats) on the right |
| C — Feed + drawer | `/admin/?variant=C` | big "paste a URL" hero, card feed with sparklines and inline actions, stats in a slide-over |
| D — Server-rendered | `/ssr/` | Hono JSX, plain HTML forms, zero client JS: the SSR comparison point |

Use the pink bar at the bottom (or `←`/`→`) to cycle. Mutations hit an in-memory mock under `/api/*`; restart to reset.
Variants A–D use the old placeholder API under `/api/*`; E/F use the ADR 0009 mock under `/api/v1`.
