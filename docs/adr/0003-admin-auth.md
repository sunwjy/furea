---
status: accepted
date: 2026-09-14
---

# Admin auth: one operator password, D1-backed sessions, hashed API keys, Cloudflare Access as a replacement door

furea v1 authenticates the admin surface and the public API with three mechanisms and nothing else: a **single operator password** created by the installer, **browser sessions stored in D1**, and **API keys stored as hashes in D1**. **Cloudflare Access mode** is an optional switch that *replaces* the password login rather than stacking on top of it. Passkeys, TOTP and multiple admin accounts are out of v1.

Decided in [Decide: admin authentication and API key model](https://github.com/sunwjy/furea/issues/7).

## Operator password

- The installer generates the password (24 characters from the slug alphabet: base62 minus `0 O o 1 I l`), stores its hash in the D1 `settings` table and prints it **once**. An instance is locked from the moment it exists; there is no "first visitor claims the instance" flow, because a `workers.dev` hostname is public the moment it is deployed.
- There is exactly one credential and no username field. The glossary's *Operator* is singular; several people sharing one instance go through Access mode.
- Hashing is **PBKDF2-HMAC-SHA-256** via WebCrypto with a per-password random salt and an iteration count as high as the Worker CPU budget allows. Rejected: argon2/bcrypt via WASM (extra bundle and dependency for a login that happens a few times a month).
- Rotation: the admin surface changes the password after re-entering the current one. Recovery: `npx furea reset-password` writes a fresh hash straight into D1 through the Cloudflare API, so *access to the Cloudflare account* is the proof of ownership. No e-mail or other external dependency.
- Policy: 12 to 256 characters, no complexity rules.

## Sessions

- A login creates a random session id; D1 `sessions` keeps its SHA-256 hash and expiry, the browser keeps the id in a `__Host-furea_session` cookie (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`).
- Lifetime is **30 days absolute**, not sliding. Concurrent sessions are allowed; there is no session list. Changing the password deletes every session row ("log out everywhere"). Expired rows are purged on the next login.
- Rejected: stateless signed cookies. They need a signing secret the installer would have to provision, and they cannot be revoked individually.
- Cookie-authenticated mutating requests must carry an `Origin` header matching the instance hostname; `SameSite=Lax` alone is not the CSRF defence.

## API keys

- Format `furea_` + 32 random bytes encoded in the slug alphabet, shown once at creation.
- D1 `api_keys` stores: SHA-256 hash of the key, the first 8 characters after the prefix (for identification in lists), a required name (1–64 chars), a scope, `created_at`, `last_used_at`. No cap on the number of keys.
- **Scopes**: `read` or `write`. `write` implies `read`. No per-resource scopes in v1.
- Revocation is a row delete and takes effect on the next request: every API request looks the key up in D1, with no KV cache in front.
- `last_used_at` is written at most once per day per key so key usage does not eat the D1 write budget.
- The public API accepts either a session cookie (used by the admin SPA) or `Authorization: Bearer furea_…`.

## Cloudflare Access mode

- Access mode is a setting (`access_team_domain`, `access_aud`) in D1 `settings`, switchable from the admin surface (while logged in) **and** from the CLI (`npx furea access enable|disable`). Enabling fails unless the Worker can fetch the team's public keys.
- When on, the Worker verifies the `Cf-Access-Jwt-Assertion` header / `CF_Authorization` cookie itself, on both `/admin/*` and `/api/*`, and a valid JWT *is* the operator session. The password login is not shown and not accepted. Rejected: requiring the password after Access ("both"): two doors make the lock state easy to misjudge, and Access already supports MFA and identity providers.
- API keys are unaffected by Access mode, so scripts keep working.
- Access mode presumes the instance is on its **own domain**. On the `workers.dev` fallback an Access application cannot be scoped to `/admin`, so it would gate the slugs too; the CLI must refuse to enable Access mode on a `workers.dev`-only instance.

## Brute force

Login attempts are throttled with the Workers Rate Limiting binding if it is usable on the free plan and through the installer's API deploy path (pending [research](https://github.com/sunwjy/furea/issues/1)); until confirmed, the floor is a constant-time compare plus a fixed delay on failure. Per-IP counters in D1 are ruled out because the instance never stores raw IPs.

## Out of v1

Passkeys (WebAuthn), TOTP, multiple operator accounts, a session list, an audit log. Operators who need stronger or multi-person auth turn on Access mode.
