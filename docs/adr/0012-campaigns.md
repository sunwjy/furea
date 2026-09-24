---
status: accepted
date: 2026-09-24
---

# A campaign owns its links' destinations: they are always composed, never drift, and are rewritten together

A **campaign** is a first-class entity that owns the shared part of its links' destinations (base URL, UTM campaign, optional `utm_id`). A campaign link's destination is always the composition of that shared part and the link's own UTM parameters; it is never edited as free text, so editing the campaign rewrites every member link. Membership changes never move a visitor silently: detaching keeps the destination, adopting is only allowed when the destination already matches. A campaign holds at most **100 links**, because every campaign-wide rewrite spends one Workers KV write per link out of the Free plan's 1,000 per day.

Decided in [Decide: campaign domain model and lifecycle](https://github.com/sunwjy/furea/issues/28), building on ADR 0002 (slug rules), ADR 0004 (redirect cache) and the campaign scope extension on the map.

## Campaign

- Identified by a generated opaque **id**, never by its name (the API addresses `/campaigns/:id`; exact shape belongs to the public-API decision).
- **Name**: editable, unique across the instance compared case-insensitively.
- **UTM campaign**: a separate field, defaulted from the name when the campaign is created, editable. Not required to be unique; a value already used by another campaign is a warning, not an error.
- **`utm_id`**: optional, owned by the campaign, shared by every member link, same edit rules as the UTM campaign.
- **Base URL**: obeys the link destination rules of ADR 0002 (absolute `http`/`https`, at most 2048 characters, never the instance itself) and must not carry any `utm_*` parameter. Other query parameters and a `#fragment` are allowed.
- A campaign may exist with zero links. It has **no state of its own** (no enabled flag).

## Campaign links

- **Composition invariant**: destination = base URL + UTM campaign (+ `utm_id`) + the link's `utm_source` and `utm_medium` (required) and `utm_content` / `utm_term` (optional). The destination string stays the only stored form; the exact composition (order, encoding, fragment placement) is ADR 0014.
- **No drift**: a campaign link's destination cannot be edited directly. Only its own UTM values are editable; to send it elsewhere, detach it first.
- **UTM values** are trimmed; case is preserved as entered (some organisations use camelCase).
- **Uniqueness**: within one campaign, the (source, medium, content, term) combination is unique, **compared case-insensitively**, so `Newsletter` and `newsletter` cannot split one channel in the destination site's analytics. The rejection names the existing value it collides with. Outside campaigns, duplicate destinations stay allowed (ADR 0002).
- **Slugs** follow ADR 0002 unchanged: generated as usual, or a custom slug per link. No naming pattern.
- Editing a link's own UTM values is allowed even after it has clicks; the form warns that past clicks will be counted under the new values, since clicks are recorded per slug.

## Rewrites

- Editing a campaign's base URL, UTM campaign or `utm_id` rewrites the destination of **every** member link, disabled ones included (so re-enabling never resurrects an old base URL).
- The D1 update of the campaign and all its links is one batch; the redirect cache is then written through **per link** exactly as in ADR 0004, and a link whose KV write still fails is marked **sync pending** and repaired by the usual loop. No campaign-level sync state exists.
- Before the edit the operator confirms the number of links that will be rewritten; changing the UTM campaign additionally warns that the destination site's analytics will see a new campaign from then on.

## Bulk operations

- **Bulk creation** of links inside a campaign is **all-or-nothing** in D1: every item is validated first (slug rules, custom-slug collisions, combination uniqueness, the 100-link cap), and if any fails nothing is created and each failure is reported per item. Cache write-through then runs per link as usual. Destination screening (ADR 0013) is part of that validation: one lookup per distinct host, and a flagged host refuses the whole request unless a session overrides it; a campaign-wide rewrite is screened once before it runs.
- **Disable all / enable all** is a bulk action that sets `enabled` on every member link; it is not a campaign state, and the cache entry shape of ADR 0004 is unchanged.

## Membership

- **Detach** is always allowed: the link becomes a plain link, its destination (still carrying the UTM parameters) and its click history unchanged. The campaign view reads membership at query time, so a detached link's clicks leave the campaign and an adopted link's earlier clicks join it (ADR 0005, section *Campaigns*).
- **Adopt** of a plain link is allowed only when its destination already matches the campaign's composition for some source/medium (and optional content/term) that is unique in the campaign, and the cap is not reached; otherwise it is refused with the reason. The match ignores UTM pair order and encoding, and adopting rewrites the destination to the canonical form (ADR 0014, amended there): adopting never changes where a visitor lands.
- **Deleting a campaign** detaches all its links; it never deletes or disables them. Deleting links is always a separate, explicit action.

## Considered options

1. **Composed destinations, no drift, campaign-wide rewrite** (chosen).
2. Drift allowed and flagged. Rejected: campaign comparison and base-URL edits lose their meaning once a member may point anywhere, and it adds a new link state to show.
3. Base URL frozen once links exist. Rejected: landing pages move and typos happen; the per-link sync-pending loop already makes a multi-link write-through safe.
4. A campaign-level enabled flag. Rejected: it would have to reach the redirect cache entry and blur the meaning of a disabled link; a bulk action covers the need.
5. Deleting a campaign deletes its links, or is refused while links exist. Rejected: the first makes a grouping action destructive for short URLs already printed or sent; the second is tedious for no safety gain over detaching.
6. Enforced lowercase UTM values. Rejected: some organisations deliberately use camelCase; case-insensitive uniqueness prevents the split within a campaign. Across campaigns only the browser's own form autocomplete nudges consistency (ADR 0014 rejected a value-suggestion service).
7. No cap. Rejected: at 1,000 KV writes per day on the Free plan, a few base-URL edits on a large campaign would exhaust the day's writes for the whole instance; 100 also bounds bulk-creation requests and the slug list in campaign analytics queries.
