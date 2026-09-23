// PROTOTYPE — in-memory mock of the decided public API (ADR 0009) under /api/v1, plus /__proto
// scenario switches (analytics token, host, Access mode, ...) so every degraded state can be reached.
// Shapes follow ADR 0009 exactly; behaviour is only as deep as the screens need.
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { links as seedLinks, breakdown, type Range } from './data';

type Link = {
  slug: string; destination: string; title: string | null; enabled: boolean;
  clickCount: number; cacheSynced: boolean; createdAt: string; updatedAt: string;
};
type ApiKey = { id: string; name: string; prefix: string; scope: 'read' | 'write'; createdAt: string; lastUsedAt: string | null };

// ---- scenario state (what the ScenarioPanel toggles) ----
export const scenario = {
  host: 's.example.com' as 's.example.com' | 'furea-sun.workers.dev',
  analyticsConfigured: true,
  // Access mode as stored in settings. When on, the operator is "signed in by Access" on the own domain.
  access: null as null | { teamDomain: string; aud: string },
  // Access mode on, but did Cloudflare Access actually front this request (JWT present)? false = misconfigured
  // Access application, or a path it does not cover: the Worker sees no JWT and the password door is shut.
  accessJwt: true,
  accessUnreachable: false, // make the next Access enable fail with access_unreachable
  version: '0.4.1',
};
let password = 'furea-proto';
let rootDestination: string | null = null;
const sessions = new Set<string>();
const failures: number[] = []; // timestamps of failed logins (per-IP limiter stand-in: 5 / 60 s)

const now = () => new Date().toISOString();
const links: Link[] = seedLinks.map((l) => ({
  slug: l.slug, destination: l.destination, title: l.title, enabled: !l.disabled,
  clickCount: l.clickCount, cacheSynced: !l.syncPending, createdAt: l.createdAt, updatedAt: l.createdAt,
}));
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const rand = (n: number) => Array.from({ length: n }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
const apiKeys: ApiKey[] = [
  { id: rand(12), name: 'deploy script', prefix: 'furea_7Qk', scope: 'write', createdAt: new Date(Date.now() - 40 * 864e5).toISOString(), lastUsedAt: new Date(Date.now() - 2 * 36e5).toISOString() },
  { id: rand(12), name: 'grafana', prefix: 'furea_mZp', scope: 'read', createdAt: new Date(Date.now() - 12 * 864e5).toISOString(), lastUsedAt: null },
];

export const protoState = () => ({
  scenario, rootDestination, signedIn: sessions.size > 0, failedLoginsLastMinute: failures.filter((t) => t > Date.now() - 60e3).length,
  syncPending: links.filter((l) => !l.cacheSynced).map((l) => l.slug), apiKeys: apiKeys.length, password,
});

// ---- helpers ----
const RESERVED = /^(admin|api|favicon\.ico|robots\.txt|_.*|\..*)$/i;
const SLUG = /^[A-Za-z0-9_-]{1,64}$/;
type Detail = { field: string; code: string; message: string };
const err = (c: Context, status: number, code: string, message: string, details?: Detail[]) =>
  c.json({ error: { code, message, ...(details ? { details } : {}) } }, status as 400);
const view = (l: Link) => ({ ...l, shortUrl: `https://${scenario.host}/${l.slug}` });
const onWorkersDev = () => scenario.host.endsWith('.workers.dev');
function checkDestination(field: string, v: unknown, out: Detail[]) {
  if (typeof v !== 'string' || !/^https?:\/\/[^\s/]+\.[^\s]+$/.test(v.trim()) || v.length > 2048)
    out.push({ field, code: 'destination_invalid', message: 'Must be an absolute http(s) URL of at most 2048 characters.' });
  else if (new URL(v.trim()).host === scenario.host)
    out.push({ field, code: 'destination_self', message: 'Must not point at this instance.' });
}
function checkTitle(v: unknown, out: Detail[]) {
  if (v !== null && v !== undefined && (typeof v !== 'string' || v.trim().length > 200))
    out.push({ field: 'title', code: 'title_too_long', message: 'At most 200 characters.' });
}
const unknownFields = (body: object, allowed: string[], out: Detail[]) =>
  Object.keys(body).filter((k) => !allowed.includes(k)).forEach((k) => out.push({ field: k, code: 'unknown_field', message: `Unknown field "${k}".` }));
const failVal = (c: Context, d: Detail[]) => err(c, 400, 'validation_failed', 'Some fields are invalid.', d);
// A write sometimes fails to reach KV: 1 in 5 writes lands as sync pending, so the badge shows up while clicking around.
const writeCache = (l: Link) => { l.cacheSynced = Math.random() > 0.2; };

// ---- auth ----
type Caller = { kind: 'session' | 'access'; scope: 'write' } | null;
function caller(c: Context): Caller {
  if (scenario.access) return scenario.accessJwt ? { kind: 'access', scope: 'write' } : null;
  const sid = getCookie(c, '__Host-furea_session') ?? getCookie(c, 'furea_session');
  return sid && sessions.has(sid) ? { kind: 'session', scope: 'write' } : null;
}

export const v1 = new Hono({ strict: false });

v1.use('*', async (c, next) => {
  const open = c.req.path.endsWith('/auth/login') || c.req.path.endsWith('/openapi.json');
  if (!open && !caller(c)) return err(c, 401, 'unauthorized', 'Sign in or send an API key.');
  await new Promise((r) => setTimeout(r, 120)); // make loading states visible
  await next();
});

v1.post('/auth/login', async (c) => {
  if (scenario.access) return err(c, 403, 'login_disabled', 'Password login is disabled while Access mode is on.');
  const recent = failures.filter((t) => t > Date.now() - 60e3);
  if (recent.length >= 5) {
    const retry = Math.ceil((recent[0] + 60e3 - Date.now()) / 1000);
    c.header('Retry-After', String(retry));
    return err(c, 429, 'rate_limited', `Too many attempts. Try again in ${retry} seconds.`);
  }
  const body = await c.req.json().catch(() => ({}));
  await new Promise((r) => setTimeout(r, 400)); // ADR 0003 fixed delay floor
  if (body.password !== password) { failures.push(Date.now()); return err(c, 401, 'invalid_password', 'Wrong password.'); }
  const sid = rand(24); sessions.add(sid);
  setCookie(c, 'furea_session', sid, { path: '/', httpOnly: true, sameSite: 'Strict' }); // __Host- needs https; mock uses a plain name
  return c.body(null, 204);
});
v1.post('/auth/logout', (c) => {
  const sid = getCookie(c, 'furea_session'); if (sid) sessions.delete(sid);
  deleteCookie(c, 'furea_session', { path: '/' });
  return c.body(null, 204);
});
v1.get('/auth/session', (c) => c.json({ ...caller(c)!, apiKey: null }));

// ---- links ----
v1.get('/links', (c) => {
  const q = (c.req.query('q') ?? '').toLowerCase();
  const limit = Math.min(200, Number(c.req.query('limit') ?? 50));
  const all = [...links].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.slug.localeCompare(a.slug))
    .filter((l) => !q || [l.slug, l.title ?? '', l.destination].some((s) => s.toLowerCase().includes(q)));
  const start = Number(c.req.query('cursor') ? atob(c.req.query('cursor')!) : 0);
  const items = all.slice(start, start + limit).map(view);
  return c.json({ items, nextCursor: start + limit < all.length ? btoa(String(start + limit)) : null });
});
v1.get('/links/:slug', (c) => {
  const l = links.find((x) => x.slug === c.req.param('slug'));
  return l ? c.json(view(l)) : err(c, 404, 'not_found', 'No link with that slug.');
});
v1.post('/links', async (c) => {
  const b = await c.req.json(); const d: Detail[] = [];
  unknownFields(b, ['destination', 'slug', 'title'], d);
  checkDestination('destination', b.destination, d); checkTitle(b.title, d);
  let slug = typeof b.slug === 'string' ? b.slug.trim() : '';
  if (slug && !SLUG.test(slug)) d.push({ field: 'slug', code: 'slug_invalid', message: 'Use 1–64 of A–Z a–z 0–9 _ -.' });
  else if (slug && RESERVED.test(slug)) d.push({ field: 'slug', code: 'slug_reserved', message: `"${slug}" is reserved.` });
  if (d.length) return failVal(c, d);
  if (slug && links.some((l) => l.slug === slug)) return err(c, 409, 'slug_taken', `The slug "${slug}" is already taken.`);
  if (!slug) do slug = rand(6); while (links.some((l) => l.slug === slug));
  const l: Link = { slug, destination: b.destination.trim(), title: b.title?.trim() || null, enabled: true, clickCount: 0, cacheSynced: true, createdAt: now(), updatedAt: now() };
  writeCache(l); links.unshift(l);
  return c.json(view(l), 201);
});
v1.patch('/links/:slug', async (c) => {
  const l = links.find((x) => x.slug === c.req.param('slug'));
  if (!l) return err(c, 404, 'not_found', 'No link with that slug.');
  const b = await c.req.json(); const d: Detail[] = [];
  if ('slug' in b) d.push({ field: 'slug', code: 'slug_immutable', message: 'A slug cannot be changed.' });
  unknownFields(b, ['destination', 'title', 'enabled', 'slug'], d);
  if ('destination' in b) checkDestination('destination', b.destination, d);
  checkTitle(b.title, d);
  if (d.length) return failVal(c, d);
  if ('destination' in b) l.destination = b.destination.trim();
  if ('title' in b) l.title = b.title?.trim() || null;
  if ('enabled' in b) l.enabled = !!b.enabled;
  l.updatedAt = now();
  // an empty {} patch is the "retry sync" action: it always succeeds in the mock
  if (Object.keys(b).length === 0) l.cacheSynced = true; else writeCache(l);
  return c.json(view(l));
});
v1.delete('/links/:slug', (c) => {
  const i = links.findIndex((x) => x.slug === c.req.param('slug'));
  if (i < 0) return err(c, 404, 'not_found', 'No link with that slug.');
  links.splice(i, 1); return c.body(null, 204);
});

// ---- stats ----
const noAnalytics = (c: Context) => err(c, 503, 'analytics_unavailable', 'Click breakdowns need an analytics token. Run `npx furea analytics-token`.');
const asRange = (v?: string): Range => (['24h', '7d', '30d', '90d'].includes(v ?? '') ? (v as Range) : '7d');
v1.get('/links/:slug/stats', (c) => {
  if (!scenario.analyticsConfigured) return noAnalytics(c);
  const l = links.find((x) => x.slug === c.req.param('slug'));
  if (!l) return err(c, 404, 'not_found', 'No link with that slug.');
  const range = asRange(c.req.query('range')); const b = breakdown(l.slug, range);
  return c.json({
    range, tz: c.req.query('tz') ?? 'UTC',
    series: b.series.map((s) => ({ start: s.t, clicks: s.clicks })),
    countries: b.countries.map((r) => ({ country: r.key, clicks: r.clicks })),
    referrerHosts: b.referrers.map((r) => ({ host: r.key, clicks: r.clicks })),
    deviceClasses: b.devices.map((r) => ({ deviceClass: r.key, clicks: r.clicks })),
  });
});
v1.get('/stats', (c) => {
  if (!scenario.analyticsConfigured) return noAnalytics(c);
  const range = asRange(c.req.query('range'));
  const seriesBySlug: Record<string, { start: string; clicks: number }[]> = {};
  const tot = (r: Range) => links.reduce((a, l) => a + breakdown(l.slug, r).series.reduce((x, s) => x + s.clicks, 0), 0);
  for (const l of links) seriesBySlug[l.slug] = breakdown(l.slug, range).series.map((s) => ({ start: s.t, clicks: s.clicks }));
  const topLinks = links.map((l) => ({ slug: l.slug, clicks: seriesBySlug[l.slug].reduce((a, s) => a + s.clicks, 0) })).sort((a, b) => b.clicks - a.clicks).slice(0, 10);
  return c.json({ today: Math.round(tot('24h')), last7d: tot('7d'), last30d: tot('30d'), topLinks, seriesBySlug });
});

// ---- settings / password / api keys ----
const settingsDoc = () => ({ rootDestination, access: scenario.access, analyticsConfigured: scenario.analyticsConfigured, version: scenario.version });
v1.get('/settings', (c) => c.json(settingsDoc()));
v1.patch('/settings', async (c) => {
  const b = await c.req.json(); const d: Detail[] = [];
  unknownFields(b, ['rootDestination', 'access', 'analyticsConfigured', 'version'], d);
  for (const k of ['analyticsConfigured', 'version']) if (k in b) d.push({ field: k, code: 'read_only_field', message: `"${k}" is read-only.` });
  if ('rootDestination' in b && b.rootDestination !== null) checkDestination('rootDestination', b.rootDestination, d);
  if (b.access) {
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(b.access.teamDomain ?? '')) d.push({ field: 'access.teamDomain', code: 'team_domain_invalid', message: 'Looks like <team>.cloudflareaccess.com.' });
    if (!/^[0-9a-f]{64}$/.test(b.access.aud ?? '')) d.push({ field: 'access.aud', code: 'aud_invalid', message: 'The Application Audience (AUD) tag is 64 hex characters.' });
  }
  if (d.length) return failVal(c, d);
  if (b.access) {
    if (onWorkersDev()) return err(c, 409, 'access_requires_own_domain', `Access mode needs your own domain; this request came through ${scenario.host}.`);
    if (scenario.accessUnreachable) return err(c, 409, 'access_unreachable', `Could not fetch signing keys from https://${b.access.teamDomain}/cdn-cgi/access/certs.`);
  }
  if ('rootDestination' in b) rootDestination = b.rootDestination?.trim() || null;
  if ('access' in b) scenario.access = b.access;
  return c.json(settingsDoc());
});
v1.post('/password', async (c) => {
  const b = await c.req.json();
  if (b.currentPassword !== password) return err(c, 401, 'invalid_password', 'Current password is wrong.');
  if (typeof b.newPassword !== 'string' || b.newPassword.length < 12)
    return failVal(c, [{ field: 'newPassword', code: 'password_too_short', message: 'At least 12 characters.' }]);
  password = b.newPassword; sessions.clear(); // ADR 0003: password change logs out everywhere
  const sid = rand(24); sessions.add(sid); setCookie(c, 'furea_session', sid, { path: '/', httpOnly: true, sameSite: 'Strict' });
  return c.body(null, 204);
});
v1.get('/api-keys', (c) => c.json(apiKeys));
v1.post('/api-keys', async (c) => {
  const b = await c.req.json(); const d: Detail[] = [];
  if (typeof b.name !== 'string' || !b.name.trim()) d.push({ field: 'name', code: 'name_required', message: 'Give the key a name.' });
  if (b.scope !== 'read' && b.scope !== 'write') d.push({ field: 'scope', code: 'scope_invalid', message: 'read or write.' });
  if (d.length) return failVal(c, d);
  const key = `furea_${rand(32)}`;
  const k: ApiKey = { id: rand(12), name: b.name.trim(), prefix: key.slice(0, 9), scope: b.scope, createdAt: now(), lastUsedAt: null };
  apiKeys.unshift(k);
  return c.json({ ...k, key }, 201);
});
v1.delete('/api-keys/:id', (c) => {
  const i = apiKeys.findIndex((k) => k.id === c.req.param('id'));
  if (i < 0) return err(c, 404, 'not_found', 'No such key.');
  apiKeys.splice(i, 1); return c.body(null, 204);
});

// ---- prototype-only scenario controls ----
export const proto = new Hono();
proto.get('/state', (c) => c.json(protoState()));
proto.post('/state', async (c) => {
  const b = await c.req.json();
  Object.assign(scenario, b.scenario ?? {});
  if (b.markSyncPending) { const l = links.find((x) => x.cacheSynced); if (l) l.cacheSynced = false; }
  if (b.clearSyncPending) links.forEach((l) => (l.cacheSynced = true));
  if (b.resetLoginLimiter) failures.length = 0;
  if (b.signOutEverywhere) sessions.clear();
  return c.json(protoState());
});
