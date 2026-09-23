# PROTOTYPE — furea admin UI variants

Throwaway. Answers wayfinder ticket [#11](https://github.com/sunwjy/furea/issues/11):
what the link list looks like, how a link is created and edited, what per-link stats show,
and whether SPA-on-Static-Assets feels right versus server-rendered HTML.

```sh
cd prototype/admin-ui
pnpm install
pnpm dev          # opens http://localhost:5173/admin/?variant=A
```

| Variant | URL | Shape |
| --- | --- | --- |
| A — Table + pages | `/admin/?variant=A` | top nav, instance tiles, dense table; `/new` and `/links/:slug` are full pages |
| B — Master-detail | `/admin/?variant=B` | one screen: list + quick-create on the left, selected link (fields save on blur, stats) on the right |
| C — Feed + drawer | `/admin/?variant=C` | big "paste a URL" hero, card feed with sparklines and inline actions, stats in a slide-over |
| D — Server-rendered | `/ssr/` | Hono JSX, plain HTML forms, zero client JS: the SSR comparison point |

Use the pink bar at the bottom (or `←`/`→`) to cycle. Mutations hit an in-memory mock under `/api/*`; restart to reset.
The API shapes here are placeholders, not the decided public API (that is ticket #15).
