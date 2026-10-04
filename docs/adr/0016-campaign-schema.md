---
status: accepted
date: 2026-10-04
---

# Campaign schema: invariants that protect meaning are enforced by D1 through derived fold keys; budgets are checked in code

The campaign schema ships in the initial migration `0001_init.sql`, because no release exists yet. Case-insensitive uniqueness of campaign names and of a campaign link's UTM combination (ADR 0012) is enforced by `UNIQUE` indexes over **derived fold-key columns**, computed by one function in `packages/shared`. The 50-link cap is checked by the Worker, not by the schema.

Decided in [Decide: campaign schema migration and test coverage for campaigns and the UTM builder](https://github.com/sunwjy/furea/issues/39), building on ADR 0006 (expand-only migrations), ADR 0007 (hand-written migrations), ADR 0009 (section *Campaigns*), ADR 0012 (campaigns) and ADR 0014 (UTM composition).

## Migration file

- furea has never been published, so v1's whole schema, campaigns included, is one file `apps/worker/migrations/0001_init.sql`. Implementation PRs before `0.1.0` edit that file rather than adding `0002_…`; ADR 0007 is amended to allow it.
- The expand-only rule (ADR 0006) and the Compat tier therefore apply to campaign tables only from the first change after `0.1.0`.

## Tables and columns

- `campaigns`: `id` (12-character primary key, ADR 0009), `name` (as entered, trimmed), `name_key` (fold key of `name`), `utm_campaign`, `utm_id` (nullable), `base_url`, `created_at`, `updated_at`. No stored aggregates: `linkCount`, `enabledLinkCount`, `clickCount` and `syncPendingLinkCount` are computed from `links` on every read (ADR 0009).
- `links` gains `campaign_id TEXT NULL REFERENCES campaigns(id)` with **no `ON DELETE` action**, and `campaign_utm_key TEXT NULL`.
- `campaign_utm_key` is the fold keys of the link's own source, medium, content and term joined with a separator that cannot occur in a fold key. It is set whenever `campaign_id` is set and cleared together with it (detach, campaign deletion). It is a **derived comparison key**, recomputable from the destination at any time: the destination remains the only stored form of the link's UTM parameters (ADR 0012, ADR 0014), and the key is never read back as data.
- Deleting a campaign is one D1 batch: `UPDATE links SET campaign_id = NULL, campaign_utm_key = NULL WHERE campaign_id = ?`, then `DELETE FROM campaigns WHERE id = ?`. A delete that forgets the detach fails on the foreign key (D1 enforces foreign keys) instead of leaving a stale key behind.

## Fold key

- `foldKey(value)` in `packages/shared` = trim, Unicode NFC, then `toLowerCase()` (no locale). It is the meaning of "compared case-insensitively" for campaign names and UTM combinations in ADR 0012, used by the Worker for the stored keys and by the admin surface for early warnings.
- Stored values keep the case and form the operator entered; only the key columns are folded.

## Indexes

- `UNIQUE (name_key)` on `campaigns` → `409 campaign_name_taken`.
- `UNIQUE (campaign_id, campaign_utm_key) WHERE campaign_id IS NOT NULL` on `links` → `utm_combination_taken`; the colliding slug for `conflictsWith` is read through the same index.
- `(campaign_id, created_at, slug)` on `links`: the member list order (`createdAt asc, slug asc`) and the per-campaign aggregates.
- `(created_at, id)` on `campaigns`: the `createdAt desc, id desc` cursor list.
- No index for `q`: name and UTM campaign are matched with `LIKE` over a table that stays small.

## The cap stays in code

The 50-link cap (ADR 0012) is checked by the Worker before a bulk creation or an adopt, not by a trigger. The rule: **an invariant whose violation corrupts meaning** (two links splitting one channel in the destination site's analytics, two campaigns sharing a name) **is enforced by the schema; a budget** (KV writes per day, SQL query length) **is checked in code**. Two concurrent requests from the single operator overshooting to 51 links cost a little KV budget and a slightly longer query, both still inside their margins (ADR 0005's 9,000-character test leaves room); putting the number in a trigger would make every change to the cap a migration.

## Considered options

1. **Derived fold-key columns with `UNIQUE` indexes** (chosen).
2. Worker-only uniqueness check over the members' parsed destinations. Rejected: two concurrent writes can both pass, and a duplicate combination corrupts the campaign comparison permanently.
3. Stored UTM columns (`utm_source`, `utm_medium`, …) as data. Rejected: a second source of truth next to the destination, which ADR 0012 and ADR 0014 keep as the only stored form.
4. `COLLATE NOCASE`. Rejected: SQLite folds ASCII only, so `Été` and `été` would count as different names while the admin surface (JavaScript) treats them as equal.
5. `ON DELETE SET NULL` on `links.campaign_id`. Rejected: it cannot clear `campaign_utm_key`, and it would split detach logic between SQL and code.
6. A trigger enforcing the 50-link cap. Rejected as above.
7. A separate `0002_campaigns.sql`. Rejected: before the first release a second file only adds an expand-only header that nothing checks.
