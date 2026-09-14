# furea

A single-tenant, self-hosted URL shortener that a person or small company installs into their own Cloudflare account with one command. This file is the glossary; specs and decisions live elsewhere (`docs/adr/`).

## Language

**Instance**:
One installed copy of furea living in one Cloudflare account, owned by one operator.
_Avoid_: Tenant, deployment, site

**Operator**:
The person who installs and administers an instance.
_Avoid_: Admin user, owner, tenant

**Worker**:
The single Cloudflare Worker script that an instance runs; it serves redirects, the public API and the admin surface.
_Avoid_: Backend, server, redirect worker / admin worker (there is only one)

**Redirect path**:
The part of the Worker that resolves a slug to its destination and answers with a redirect. The only latency-critical path.
_Avoid_: Hot path, resolver

**Admin surface**:
The web UI an operator uses to manage links, served under the reserved `/admin` path of the instance.
_Avoid_: Dashboard, console, admin app

**Public API**:
The HTTP API under the reserved `/api` path, used by the admin surface and by operators' own scripts.
_Avoid_: Backend API, internal API

**Slug**:
The path segment after the instance hostname that identifies a link (`/abc123`). Rules for allowed slugs are decided in the domain-model ticket.
_Avoid_: Short code, key, alias

**Reserved path**:
A top-level path that can never be a slug because the instance uses it for itself. `admin` and `api` are reserved; the full list is settled together with the slug rules.
_Avoid_: Blocked slug, system route
