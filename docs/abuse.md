# Abuse and operator responsibility

A furea instance is single-tenant. There is no public sign-up: only the operator, through a logged-in browser session or an API key the operator created, can create or change links. **The operator is responsible for every link the instance serves**, and for the instance's hostname being used to send visitors somewhere harmful.

furea helps with one narrow thing, destination screening, described below together with its limits.

## Destination screening

Every write that sets a destination is checked against Cloudflare's family-safe resolver, [1.1.1.1 for Families](https://developers.cloudflare.com/1.1.1.1/setup/) (malware and phishing), over DNS-over-HTTPS. There is nothing to configure; it is always on and needs no account or key.

Screened writes: creating a link, changing a link's destination, creating a campaign, editing a campaign's base URL, UTM campaign or `utm_id` (which rewrites every link in it), adding links to a campaign in bulk, and setting the root destination. Saving a destination whose host was already there is checked again.

A flagged destination is refused (`422 destination_flagged` in the API, naming the flagged host). From the admin surface you can save it anyway with "Create anyway" / "Save anyway" when you are sure it is a false positive; the override is written to the instance's logs as a `screening_overridden` event. **An API key can never override screening**, whatever its scope, so a leaked key cannot use the instance to redirect to a flagged host.

### What screening does not do

- **It is domain-level only.** Only the destination's host is looked up. A malicious page on a shared or otherwise reputable host (a file-sharing site, a cloud storage bucket, a compromised blog) is not detected. IP-address destinations and hosts that do not resolve are not checked at all.
- **It is incomplete.** It knows what the resolver's blocklists know, and nothing else. A new phishing domain may not be listed yet.
- **It runs only when a destination is saved.** Stored links are never re-checked. A domain that turns bad after you saved the link is not detected, and the link keeps redirecting to it.
- **It fails open.** When the resolver is unreachable or slow (about 1.5 s), the write goes through unscreened and the Worker logs `screening_unavailable`. An outside outage never stops you from creating links, which also means a write during an outage is not checked.
- **It never runs on the redirect path.** Visitors are not slowed down, and nothing is checked at click time.

There is no other screening provider, no rate limit on link writes, no allowlist or blocklist of your own, and no refusal of other URL shorteners as destinations.

## Protect your credentials

- **Revoke a leaked API key at once**, in the admin surface under **Security → API keys**. Revocation takes effect on the next request. Every key has its own name, so you can tell which script it belonged to and replace only that one. Prefer `read` keys for scripts that only read.
- A leaked `write` key can create, edit and delete links (screened as above), but it cannot create or revoke keys, change the password, change Access mode, log out sessions or override screening.
- If you suspect the operator password leaked, change it in **Security**; that logs out every session. If you are locked out, `npx furea reset-password` sets a new one using your Cloudflare deploy token, and also logs out every session.
- The deploy token on your machine (`~/.config/furea/credentials.json`) can change everything about the instance, and the Cloudflare permissions behind it reach beyond it. Treat it like any Cloudflare API token, and revoke it in the Cloudflare dashboard if it leaks.

## Abuse reports

furea has no abuse-report channel: no `security.txt`, no contact address, and the not-found page is deliberately unbranded. Reports about links on your instance reach you through your domain's contacts and through Cloudflare's abuse process. **Cloudflare may act on abuse reports against your account**, up to restricting the Worker or the domain, under [Cloudflare's terms](https://www.cloudflare.com/website-terms/). If you receive a report, disable or delete the link (both take effect worldwide within a few minutes) and if you did not create it yourself, assume an API key leaked: revoke the keys (each key's last use is shown next to it) and create new ones for the scripts that still need them.
