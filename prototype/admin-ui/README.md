# PROTOTYPE — furea admin UI variants

Throwaway. Variants G/H/I answer wayfinder ticket [#33](https://github.com/sunwjy/furea/issues/33) (UTM builder and
campaign screens); variants E/F answer wayfinder ticket [#20](https://github.com/sunwjy/furea/issues/20); A–D answered
ticket [#11](https://github.com/sunwjy/furea/issues/11):
what the link list looks like, how a link is created and edited, what per-link stats show,
and whether SPA-on-Static-Assets feels right versus server-rendered HTML.

```sh
cd prototype/admin-ui
pnpm install
pnpm dev          # opens http://localhost:5173/admin/?variant=G  (mock password: furea-proto)
```

## Ticket #33: variants G/H/I (campaigns + UTM builder, on top of the F shell)

All three share the **UTM builder exactly as ADR 0014 settled it** (`src/shell/Builder.tsx`, parse/compose in
`src/shell/utm.ts`, the same functions the mock server uses): a collapsed "UTM parameters" section in the plain-link form
and link Edit, auto-open when the destination has a lowercase `utm_*`, two-way sync, warnings for missing
source/medium/campaign, `UTM_Source`, duplicates, malformed `%`; campaign links always open with the campaign's fields and
destination read-only. They also share the campaign header (Edit → rewrite confirmation naming the link count and the
new-`utm_campaign` warning, Enable all / Disable all, Delete = detach), combined tiles/breakdowns, detach and
"Add to campaign…" (adopt, with the refusal reason) on a link's page, and the ADR 0013 refusal
(`422 destination_flagged` → "Create anyway" / "Save anyway"). Any host containing `malware` or `phish` is flagged by the mock.

They disagree on the open questions:

| | G: nav page + row editor | H: grouped in the feed + matrix | I: source × medium pivot |
| --- | --- | --- | --- |
| Where campaigns live | `Campaigns` nav item → list table | no nav item; one grouped card per campaign in the Links feed | `Campaigns` nav item → list table |
| Campaign detail | links table (source/medium/content/term, range bar), by link / source / medium toggle | compact rows with sparklines + matrix generator inline | pivot: sources × mediums, each cell holds its link(s) with clicks, Σ per row/column, side panel |
| Bulk creation | `/campaigns/:id/add`: rows (source, medium, content, term, custom slug), paste from a spreadsheet, per-row errors | tick source × medium combinations (+ one shared content), generated slugs only | tick empty cells, add rows/columns, "+ content" per filled cell |
| Campaign link from `/admin/new` | no (hint points to the campaign page) | "Campaign links" tab = the matrix generator | "Campaign" picker: one campaign link through the read-only builder |
| Membership in the feed | purple campaign badge on each card | the group card (expand to see links) | badge + "Campaign" filter select |

Seed: *Spring sale 2026* (6 links, one disabled), *October webinar* (3 links, `utm_id`), and `/spring-sms`, a plain link
whose UTM pairs are in another order (adoptable into Spring sale; adopting canonicalises it). The campaign endpoints under
`/api/v1/campaigns` are a guess for the mock only; ticket #32 decides the real API, #31 the real analytics queries.

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
