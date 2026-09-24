---
status: accepted
date: 2026-09-24
---

# Abuse controls: zero-config destination screening via 1.1.1.1 for Families, session-only override, no link-creation rate limit

furea v1 screens every destination it is asked to store against **1.1.1.1 for Families** over DNS-over-HTTPS, refuses a flagged destination with `422 destination_flagged`, and lets only a **session** (never an API key) override that verdict. It adds **no rate limit** on link writes, no other screening provider, no re-check of stored links and no abuse-report channel. The operator's responsibility is written down in the public docs.

Decided in [Decide: abuse controls for link creation and destinations](https://github.com/sunwjy/furea/issues/22), from [`docs/research/destination-screening.md`](../research/destination-screening.md) and the smoke test [#27](https://github.com/sunwjy/furea/issues/27) ([`scripts/screening-smoke.mjs`](../../scripts/screening-smoke.mjs)).

## Threat model

An instance is single-tenant and only the operator (session or API key, ADR 0003) can create links; there is no public sign-up. What screening realistically catches is an operator's mistake (a typo'd or poisoned paste) and a **leaked write-scoped API key** used to turn the instance into a redirector for malware or phishing. It is a brake, not a guarantee.

## Screening

- **Provider**: `https://security.cloudflare-dns.com/dns-query` (1.1.1.1 for Families, malware + phishing), JSON form, `A` query for the destination host. No account, key, secret or setting; always on.
- **Verdict**: the host is **flagged** when the answer carries `EDE(16)` (Censored) or an `0.0.0.0` answer. NXDOMAIN, no records, and **IP-literal hosts** pass unchecked. Screening is domain-level only; a malicious path on a shared host is invisible.
- **Which writes**: every write that **sets a destination**: `POST /links`, a `PATCH` that includes `destination`, campaign creation and campaign edits that trigger a campaign-wide rewrite (checked once before the rewrite), bulk creation of campaign links, and setting the **root destination** (ADR 0008). Adopt (ADR 0012) sets nothing and is not checked. A write that repeats the current host is still checked.
- **Deduplication**: one lookup per distinct host per request, so a campaign's bulk creation costs one subrequest.
- **Never on the redirect path.** Stored links are not re-checked.

## Outcomes

- **Flagged**: the request is refused with `422 destination_flagged`; `details` lists the flagged host per field (and per item for bulk creation). Bulk creation stays all-or-nothing (ADR 0012): one flagged item refuses the whole request.
- **Override**: a request body may carry `"screening": "skip"`, accepted **only from a session**; from an API key it is `403 forbidden` ("session required"), whatever the key's scope. The admin surface shows the refusal with a "Create anyway" / "Save anyway" action that resends with the override. The override is not stored in D1; the Worker writes one `screening_overridden` log event with the slug (ADR 0011 field rules).
- **Resolver unavailable** (timeout ~1.5 s, network error, non-2xx): **fail open**: the write proceeds and the Worker logs `screening_unavailable`. No resource shape changes.

## Not added

- **Rate limit on link writes.** A `ratelimit` binding counts per Cloudflare location and permissively (#17), and a leaked write key does the same damage slower; the realistic runaway (a script exhausting the Free plan's 1,000 KV writes/day) degrades into sync pending and the cron repair (ADR 0004), never into broken redirects. `429 rate_limited` stays reserved on `POST /links` (ADR 0009).
- **Other destination rules.** Nothing beyond ADR 0002 (absolute http(s), ≤ 2048 chars, never the instance itself): other shorteners are allowed, since a domain list goes stale and following redirects would consume one-time links.
- **Abuse-report channel.** No `security.txt`, no abuse contact setting; ADR 0008's 404 stays unbranded. Reports reach the operator through their domain and Cloudflare's abuse process.

## Operator responsibility (public docs)

The docs carry an "Abuse and operator responsibility" section: only the operator creates links and is responsible for them; screening is domain-level, incomplete, and runs only when a destination is saved (a domain that turns bad later is not detected); a leaked API key must be revoked at once; Cloudflare may act on abuse reports against the operator's account.

## Considered options

1. **Families DoH only, always on, refuse with session-only override, fail open** (chosen).
2. Families DoH plus the URLhaus online list pulled into KV by Cron. Rejected for v1: its not-for-profit clause makes it an operator decision, and it adds a setting and a Cron job for malware-download URLs only.
3. Google Web Risk or Safe Browsing v5 with the operator's own key. Rejected for v1: a new secret and CLI command, Google attribution and "cannot be guaranteed" notices in the admin surface, and (Safe Browsing) non-commercial terms plus URL sharing with third parties.
4. Cloudflare URL Scanner, Intel API, OpenPhish, PhishTank. Rejected in the research: public scans on Free, 100 calls/month, terms, closed registration.
5. Warn but store. Rejected: a script with a leaked key ignores warnings.
6. A global screening on/off setting instead of a per-request override. Rejected: easy to leave off after a false positive.
7. Fail closed. Rejected: an outside resolver outage would stop the operator from creating links.
8. Periodic re-check by Cron with a badge or automatic disable. Rejected for v1: a new link state and Cron work for little gain, and automatic disable would silently break a link on one false positive.

## Consequences

- ADR 0009 gains the top-level code `destination_flagged` 422 and the `screening` request field (amended there); ADR 0011 gains the `screening_overridden` and `screening_unavailable` events (amended there); ADR 0012's bulk creation and rewrites run screening (amended there).
- The campaign API (still open) and the campaign/UTM admin prototype must carry the refusal and the session-only override.
- One DoH subrequest per distinct host per destination write; within the Free plan's 50 subrequests even for a 100-link bulk creation.
- A `screening` module in `apps/worker` owns the lookup and verdict, with the DoH `fetch` injected so unit tests never reach the network.
