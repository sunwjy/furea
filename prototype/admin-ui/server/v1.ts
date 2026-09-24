// PROTOTYPE — in-memory mock of the decided public API (ADR 0009) under /api/v1, plus /__proto
// scenario switches (analytics token, host, Access mode, ...) so every degraded state can be reached.
// Shapes follow ADR 0009 exactly; behaviour is only as deep as the screens need.
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { links as seedLinks, breakdown, type Range } from './data';
import { compose, parse, stripUtm, UTM_KEYS, type Utm } from '../src/shell/utm';

type Link = {
  slug: string; destination: string; title: string | null; enabled: boolean;
  clickCount: number; cacheSynced: boolean; createdAt: string; updatedAt: string;
  campaignId: string | null; // ticket #33
};
// ticket #33 — campaign per ADR 0012. The API shape is a GUESS (ticket #32 is still open).
type Campaign = { id: string; name: string; utmCampaign: string; utmId: string | null; baseUrl: string; createdAt: string; updatedAt: string };
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
  campaignId: l.campaign ?? null,
}));
const campaigns: Campaign[] = [
  { id: 'cmp_spring', name: 'Spring sale 2026', utmCampaign: 'spring_sale_2026', utmId: null, baseUrl: 'https://shop.example.com/spring?ref=furea#deals', createdAt: new Date(Date.now() - 20 * 864e5).toISOString(), updatedAt: new Date(Date.now() - 20 * 864e5).toISOString() },
  { id: 'cmp_webinar', name: 'October webinar', utmCampaign: 'webinar-oct', utmId: 'wb10', baseUrl: 'https://events.example.com/webinar/october', createdAt: new Date(Date.now() - 5 * 864e5).toISOString(), updatedAt: new Date(Date.now() - 5 * 864e5).toISOString() },
];
const screeningLog: string[] = [];
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const rand = (n: number) => Array.from({ length: n }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
const apiKeys: ApiKey[] = [
  { id: rand(12), name: 'deploy script', prefix: 'furea_7Qk', scope: 'write', createdAt: new Date(Date.now() - 40 * 864e5).toISOString(), lastUsedAt: new Date(Date.now() - 2 * 36e5).toISOString() },
  { id: rand(12), name: 'grafana', prefix: 'furea_mZp', scope: 'read', createdAt: new Date(Date.now() - 12 * 864e5).toISOString(), lastUsedAt: null },
];

export const protoState = () => ({
  scenario, rootDestination, signedIn: sessions.size > 0, failedLoginsLastMinute: failures.filter((t) => t > Date.now() - 60e3).length,
  syncPending: links.filter((l) => !l.cacheSynced).map((l) => l.slug), apiKeys: apiKeys.length, password,
  campaigns: campaigns.map((c) => ({ ...c, links: links.filter((l) => l.campaignId === c.id).map((l) => l.slug) })),
  screeningLog: screeningLog.slice(-8),
  flaggedHostsForDemo: 'any host containing "malware" or "phish" (e.g. https://malware.testing.example/x)',
});

// ---- helpers ----
const RESERVED = /^(admin|api|favicon\.ico|robots\.txt|_.*|\..*)$/i;
const SLUG = /^[A-Za-z0-9_-]{1,64}$/;
type Detail = { field: string; code: string; message: string };
const err = (c: Context, status: number, code: string, message: string, details?: Detail[]) =>
  c.json({ error: { code, message, ...(details ? { details } : {}) } }, status as 400);
const view = ({ campaignId, ...l }: Link) => {
  const cmp = campaigns.find((c) => c.id === campaignId);
  return { ...l, shortUrl: `https://${scenario.host}/${l.slug}`, campaign: cmp ? { id: cmp.id, name: cmp.name } : null };
};
// ADR 0013 stand-in for 1.1.1.1 for Families: hosts containing malware/phish are "flagged".
// Returns a 422 response, or null when every host passes (or the session asked to skip).
function screen(c: Context, body: { screening?: string }, items: { field: string; url: string }[]) {
  if (body.screening === 'skip') { screeningLog.push(`screening_overridden ${items.map((i) => i.field).join(',')}`); return null; }
  const flagged = items.filter((i) => { try { return /malware|phish/.test(new URL(i.url).host); } catch { return false; } });
  if (!flagged.length) return null;
  return err(c, 422, 'destination_flagged', 'A destination host is flagged as malware or phishing by 1.1.1.1 for Families.',
    flagged.map((f) => ({ field: f.field, code: 'destination_flagged', message: `${new URL(f.url).host} is flagged as malware or phishing.` })));
}
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
  unknownFields(b, ['destination', 'slug', 'title', 'screening'], d);
  checkDestination('destination', b.destination, d); checkTitle(b.title, d);
  let slug = typeof b.slug === 'string' ? b.slug.trim() : '';
  if (slug && !SLUG.test(slug)) d.push({ field: 'slug', code: 'slug_invalid', message: 'Use 1–64 of A–Z a–z 0–9 _ -.' });
  else if (slug && RESERVED.test(slug)) d.push({ field: 'slug', code: 'slug_reserved', message: `"${slug}" is reserved.` });
  if (d.length) return failVal(c, d);
  if (slug && links.some((l) => l.slug === slug)) return err(c, 409, 'slug_taken', `The slug "${slug}" is already taken.`);
  const flagged = screen(c, b, [{ field: 'destination', url: b.destination.trim() }]); if (flagged) return flagged;
  if (!slug) do slug = rand(6); while (links.some((l) => l.slug === slug));
  const l: Link = { slug, destination: b.destination.trim(), title: b.title?.trim() || null, enabled: true, clickCount: 0, cacheSynced: true, createdAt: now(), updatedAt: now(), campaignId: null };
  writeCache(l); links.unshift(l);
  return c.json(view(l), 201);
});
v1.patch('/links/:slug', async (c) => {
  const l = links.find((x) => x.slug === c.req.param('slug'));
  if (!l) return err(c, 404, 'not_found', 'No link with that slug.');
  const b = await c.req.json(); const d: Detail[] = [];
  if ('slug' in b) d.push({ field: 'slug', code: 'slug_immutable', message: 'A slug cannot be changed.' });
  unknownFields(b, ['destination', 'title', 'enabled', 'slug', 'screening'], d);
  if ('destination' in b && l.campaignId) d.push({ field: 'destination', code: 'campaign_link_destination', message: 'A campaign link\'s destination is composed from its campaign. Edit its UTM values, or detach it first.' });
  else if ('destination' in b) checkDestination('destination', b.destination, d);
  checkTitle(b.title, d);
  if (d.length) return failVal(c, d);
  if ('destination' in b) { const f = screen(c, b, [{ field: 'destination', url: b.destination.trim() }]); if (f) return f; }
  delete b.screening;
  if ('destination' in b) l.destination = b.destination.trim();
  if ('title' in b) l.title = b.title?.trim() || null;
  if ('enabled' in b) l.enabled = !!b.enabled;
  l.updatedAt = now();
  // an empty {} patch is the "retry sync" action: it always succeeds in the mock
  if (Object.keys(b).length === 0) l.cacheSynced = true; else writeCache(l);
  return c.json(view(l));
});
v1.post('/links/:slug/detach', (c) => {
  const l = links.find((x) => x.slug === c.req.param('slug'));
  if (!l) return err(c, 404, 'not_found', 'No link with that slug.');
  l.campaignId = null; l.updatedAt = now();
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

// ---- ticket #33: campaigns (ADR 0012 behaviour; endpoint shapes are a guess until ticket #32) ----
type Own = { source: string; medium: string; content?: string; term?: string };
const ownUtm = (l: Link): Own => { const u = parse(l.destination).utm; return { source: u.utm_source ?? '', medium: u.utm_medium ?? '', content: u.utm_content || undefined, term: u.utm_term || undefined }; };
const composeFor = (cmp: Pick<Campaign, 'baseUrl' | 'utmCampaign' | 'utmId'>, o: Own) =>
  compose(cmp.baseUrl, { utm_id: cmp.utmId ?? '', utm_source: o.source, utm_medium: o.medium, utm_campaign: cmp.utmCampaign, utm_term: o.term ?? '', utm_content: o.content ?? '' } as Utm);
const comboKey = (o: Own) => [o.source, o.medium, o.content ?? '', o.term ?? ''].map((x) => x.trim().toLowerCase()).join('\u0000');
const members = (id: string) => links.filter((l) => l.campaignId === id);
const CAP = 100;
const campaignView = (cmp: Campaign) => {
  const m = members(cmp.id);
  return { ...cmp, linkCount: m.length, enabledCount: m.filter((l) => l.enabled).length, clickCount: m.reduce((a, l) => a + l.clickCount, 0), syncPendingCount: m.filter((l) => !l.cacheSynced).length, cap: CAP };
};
const memberView = (l: Link) => ({ ...view(l), utm: ownUtm(l) });
function checkOwn(prefix: string, o: Partial<Own>, out: Detail[]) {
  for (const k of ['source', 'medium'] as const) if (typeof o[k] !== 'string' || !o[k]!.trim()) out.push({ field: `${prefix}${k}`, code: 'required', message: `${k === 'source' ? 'Source' : 'Medium'} is required in a campaign.` });
}
const findCmp = (c: Context) => campaigns.find((x) => x.id === c.req.param('id'));

v1.get('/campaigns', (c) => c.json({ items: [...campaigns].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(campaignView), nextCursor: null }));
v1.get('/campaigns/:id', (c) => {
  const cmp = findCmp(c); if (!cmp) return err(c, 404, 'not_found', 'No such campaign.');
  return c.json({ ...campaignView(cmp), links: members(cmp.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(memberView) });
});
v1.post('/campaigns', async (c) => {
  const b = await c.req.json(); const d: Detail[] = [];
  unknownFields(b, ['name', 'utmCampaign', 'utmId', 'baseUrl', 'screening'], d);
  const name = (b.name ?? '').trim();
  if (!name) d.push({ field: 'name', code: 'required', message: 'Give the campaign a name.' });
  else if (campaigns.some((x) => x.name.toLowerCase() === name.toLowerCase())) d.push({ field: 'name', code: 'name_taken', message: `A campaign named "${name}" already exists.` });
  checkDestination('baseUrl', b.baseUrl, d);
  if (!d.some((x) => x.field === 'baseUrl') && Object.keys(parse(b.baseUrl).utm).length) d.push({ field: 'baseUrl', code: 'base_url_has_utm', message: 'The base URL must not carry utm_* parameters; the campaign adds them.' });
  if (d.length) return failVal(c, d);
  const f = screen(c, b, [{ field: 'baseUrl', url: b.baseUrl.trim() }]); if (f) return f;
  const cmp: Campaign = { id: `cmp_${rand(8)}`, name, utmCampaign: (b.utmCampaign ?? '').trim() || name.toLowerCase().replace(/\s+/g, '_'), utmId: (b.utmId ?? '').trim() || null, baseUrl: b.baseUrl.trim(), createdAt: now(), updatedAt: now() };
  campaigns.push(cmp);
  return c.json(campaignView(cmp), 201);
});
v1.patch('/campaigns/:id', async (c) => {
  const cmp = findCmp(c); if (!cmp) return err(c, 404, 'not_found', 'No such campaign.');
  const b = await c.req.json(); const d: Detail[] = [];
  unknownFields(b, ['name', 'utmCampaign', 'utmId', 'baseUrl', 'screening'], d);
  if ('name' in b) {
    const name = (b.name ?? '').trim();
    if (!name) d.push({ field: 'name', code: 'required', message: 'Give the campaign a name.' });
    else if (campaigns.some((x) => x !== cmp && x.name.toLowerCase() === name.toLowerCase())) d.push({ field: 'name', code: 'name_taken', message: `A campaign named "${name}" already exists.` });
  }
  if ('utmCampaign' in b && !(b.utmCampaign ?? '').trim()) d.push({ field: 'utmCampaign', code: 'required', message: 'UTM campaign cannot be empty.' });
  if ('baseUrl' in b) {
    checkDestination('baseUrl', b.baseUrl, d);
    if (!d.some((x) => x.field === 'baseUrl') && Object.keys(parse(b.baseUrl).utm).length) d.push({ field: 'baseUrl', code: 'base_url_has_utm', message: 'The base URL must not carry utm_* parameters; the campaign adds them.' });
  }
  if (d.length) return failVal(c, d);
  const next = { baseUrl: 'baseUrl' in b ? b.baseUrl.trim() : cmp.baseUrl, utmCampaign: 'utmCampaign' in b ? b.utmCampaign.trim() : cmp.utmCampaign, utmId: 'utmId' in b ? ((b.utmId ?? '').trim() || null) : cmp.utmId };
  const rewrite = next.baseUrl !== cmp.baseUrl || next.utmCampaign !== cmp.utmCampaign || next.utmId !== cmp.utmId;
  const m = members(cmp.id);
  if (rewrite) {
    const tooLong = m.filter((l) => composeFor(next, ownUtm(l)).length > 2048);
    if (tooLong.length) return failVal(c, tooLong.map((l) => ({ field: `links.${l.slug}`, code: 'destination_too_long', message: `/${l.slug} would exceed 2048 characters.` })));
    if (next.baseUrl !== cmp.baseUrl) { const f = screen(c, b, [{ field: 'baseUrl', url: next.baseUrl }]); if (f) return f; }
  }
  if ('name' in b) cmp.name = b.name.trim();
  Object.assign(cmp, next, { updatedAt: now() });
  if (rewrite) for (const l of m) { l.destination = composeFor(cmp, ownUtm(l)); l.updatedAt = now(); writeCache(l); }
  return c.json({ ...campaignView(cmp), rewritten: rewrite ? m.length : 0 });
});
v1.delete('/campaigns/:id', (c) => {
  const i = campaigns.findIndex((x) => x.id === c.req.param('id'));
  if (i < 0) return err(c, 404, 'not_found', 'No such campaign.');
  members(campaigns[i].id).forEach((l) => (l.campaignId = null));
  campaigns.splice(i, 1); return c.body(null, 204);
});
// bulk creation, all-or-nothing (ADR 0012)
v1.post('/campaigns/:id/links', async (c) => {
  const cmp = findCmp(c); if (!cmp) return err(c, 404, 'not_found', 'No such campaign.');
  const b = await c.req.json(); const d: Detail[] = [];
  const items: (Own & { slug?: string; title?: string })[] = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return failVal(c, [{ field: 'items', code: 'required', message: 'Add at least one link.' }]);
  const m = members(cmp.id);
  if (m.length + items.length > CAP) d.push({ field: 'items', code: 'campaign_full', message: `A campaign holds at most ${CAP} links; this one has ${m.length}, so at most ${CAP - m.length} more.` });
  const seen = new Map<string, string>(m.map((l) => [comboKey(ownUtm(l)), `/${l.slug}`]));
  const slugs = new Set<string>();
  items.forEach((it, i) => {
    const p = `items[${i}].`;
    checkOwn(p, it, d);
    if (it.source?.trim() && it.medium?.trim()) {
      const k = comboKey(it);
      if (seen.has(k)) d.push({ field: `${p}source`, code: 'combination_taken', message: `Same source/medium/content/term as ${seen.get(k)} (compared ignoring case).` });
      else seen.set(k, `row ${i + 1}`);
    }
    const slug = (it.slug ?? '').trim();
    if (slug) {
      if (!SLUG.test(slug)) d.push({ field: `${p}slug`, code: 'slug_invalid', message: 'Use 1–64 of A–Z a–z 0–9 _ -.' });
      else if (RESERVED.test(slug)) d.push({ field: `${p}slug`, code: 'slug_reserved', message: `"${slug}" is reserved.` });
      else if (links.some((l) => l.slug === slug) || slugs.has(slug)) d.push({ field: `${p}slug`, code: 'slug_taken', message: `"${slug}" is already taken.` });
      slugs.add(slug);
    }
    if (composeFor(cmp, it).length > 2048) d.push({ field: `${p}source`, code: 'destination_too_long', message: 'The composed destination exceeds 2048 characters.' });
  });
  if (d.length) return failVal(c, d);
  const f = screen(c, b, items.map((it, i) => ({ field: `items[${i}].destination`, url: composeFor(cmp, it) }))); if (f) return f;
  const created = items.map((it) => {
    let slug = (it.slug ?? '').trim();
    if (!slug) do slug = rand(6); while (links.some((l) => l.slug === slug));
    const l: Link = { slug, destination: composeFor(cmp, { source: it.source.trim(), medium: it.medium.trim(), content: it.content?.trim(), term: it.term?.trim() }), title: it.title?.trim() || null, enabled: true, clickCount: 0, cacheSynced: true, createdAt: now(), updatedAt: now(), campaignId: cmp.id };
    writeCache(l); links.unshift(l); return memberView(l);
  });
  return c.json({ items: created }, 201);
});
v1.patch('/campaigns/:id/links/:slug', async (c) => {
  const cmp = findCmp(c); const l = links.find((x) => x.slug === c.req.param('slug') && x.campaignId === cmp?.id);
  if (!cmp || !l) return err(c, 404, 'not_found', 'No such campaign link.');
  const b = await c.req.json(); const d: Detail[] = [];
  const o: Own = { ...ownUtm(l), ...b };
  checkOwn('', o, d);
  const clash = members(cmp.id).find((x) => x !== l && comboKey(ownUtm(x)) === comboKey(o));
  if (clash) d.push({ field: 'source', code: 'combination_taken', message: `Same source/medium/content/term as /${clash.slug} (compared ignoring case).` });
  if (d.length) return failVal(c, d);
  l.destination = composeFor(cmp, o); l.updatedAt = now(); writeCache(l);
  return c.json(memberView(l));
});
v1.post('/campaigns/:id/adopt', async (c) => {
  const cmp = findCmp(c); if (!cmp) return err(c, 404, 'not_found', 'No such campaign.');
  const { slug } = await c.req.json();
  const l = links.find((x) => x.slug === slug); if (!l) return err(c, 404, 'not_found', 'No link with that slug.');
  if (l.campaignId) return err(c, 409, 'already_in_campaign', 'Detach it from its current campaign first.');
  if (members(cmp.id).length >= CAP) return err(c, 409, 'campaign_full', `The campaign already holds ${CAP} links.`);
  const { utm, warnings } = parse(l.destination);
  const o = ownUtm(l);
  const why = warnings.length ? 'its destination has duplicate or case-variant UTM keys'
    : stripUtm(l.destination) !== cmp.baseUrl ? `everything outside the UTM parameters must equal the base URL ${cmp.baseUrl}`
    : utm.utm_campaign !== cmp.utmCampaign ? `utm_campaign must be "${cmp.utmCampaign}"`
    : (utm.utm_id ?? null) !== cmp.utmId ? (cmp.utmId ? `utm_id must be "${cmp.utmId}"` : 'it carries a utm_id the campaign does not have')
    : !o.source || !o.medium ? 'it needs both utm_source and utm_medium'
    : members(cmp.id).some((x) => comboKey(ownUtm(x)) === comboKey(o)) ? 'another link in the campaign already has that source/medium/content/term'
    : null;
  if (why) return err(c, 409, 'adopt_mismatch', `Cannot add /${l.slug}: ${why}. Adopting never changes where a visitor lands.`);
  l.campaignId = cmp.id; l.destination = composeFor(cmp, o); l.updatedAt = now(); writeCache(l);
  return c.json(memberView(l));
});
v1.post('/campaigns/:id/enabled', async (c) => {
  const cmp = findCmp(c); if (!cmp) return err(c, 404, 'not_found', 'No such campaign.');
  const { enabled } = await c.req.json();
  for (const l of members(cmp.id)) { l.enabled = !!enabled; l.updatedAt = now(); writeCache(l); }
  return c.json(campaignView(cmp));
});
v1.get('/campaigns/:id/stats', (c) => {
  if (!scenario.analyticsConfigured) return noAnalytics(c);
  const cmp = findCmp(c); if (!cmp) return err(c, 404, 'not_found', 'No such campaign.');
  const range = asRange(c.req.query('range'));
  const per = members(cmp.id).map((l) => ({ l, b: breakdown(l.slug, range) }));
  const sumBy = (rows: { key: string; clicks: number }[][]) => {
    const m = new Map<string, number>(); rows.flat().forEach((r) => m.set(r.key, (m.get(r.key) ?? 0) + r.clicks));
    return [...m].map(([key, clicks]) => ({ key, clicks })).sort((a, b) => b.clicks - a.clicks);
  };
  const n = per[0]?.b.series.length ?? (range === '24h' ? 24 : range === '7d' ? 7 : range === '30d' ? 30 : 90);
  const series = Array.from({ length: n }, (_, i) => ({ start: per[0]?.b.series[i].t ?? new Date(Date.now() - (n - 1 - i) * 864e5).toISOString(), clicks: per.reduce((a, p) => a + p.b.series[i].clicks, 0) }));
  const perLink = per.map(({ l, b }) => ({ slug: l.slug, ...ownUtm(l), clicks: b.series.reduce((a, s) => a + s.clicks, 0), series: b.series.map((s) => ({ start: s.t, clicks: s.clicks })) }));
  const group = (k: 'source' | 'medium') => sumBy([perLink.map((p) => ({ key: p[k], clicks: p.clicks }))]);
  return c.json({
    range, tz: c.req.query('tz') ?? 'UTC', series, perLink, bySource: group('source'), byMedium: group('medium'),
    countries: sumBy(per.map((p) => p.b.countries)).map((r) => ({ country: r.key, clicks: r.clicks })),
    referrerHosts: sumBy(per.map((p) => p.b.referrers)).map((r) => ({ host: r.key, clicks: r.clicks })),
    deviceClasses: sumBy(per.map((p) => p.b.devices)).map((r) => ({ deviceClass: r.key, clicks: r.clicks })),
  });
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
