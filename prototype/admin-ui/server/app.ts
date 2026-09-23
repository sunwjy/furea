// PROTOTYPE — Hono app: mock public API under /api/*, server-rendered variant D under /ssr/*.
import { Hono } from 'hono';
import { links, findLink, generateSlug, breakdown, instanceOverview, type Range } from './data';
import { ssr } from './ssr';
import { v1, proto } from './v1';

export const app = new Hono({ strict: false });

const RESERVED = /^(admin|api|favicon\.ico|robots\.txt|_.*|\..*)$/i;
const SLUG = /^[A-Za-z0-9_-]{1,64}$/;
const asRange = (v: string | undefined): Range => (['24h', '7d', '30d', '90d'].includes(v ?? '') ? (v as Range) : '7d');

app.get('/', (c) =>
  c.html(`<h1 style="font:16px system-ui">furea PROTOTYPE</h1>
  <ul style="font:14px system-ui">
    <li><a href="/admin/?variant=E">E — confirmed feed shell + login / API keys / settings (ticket #20)</a></li>
    <li><a href="/admin/?variant=F">F — same shell, Security page groups password / Access / API keys (ticket #20)</a></li>
    <li><a href="/admin/?variant=A">SPA variant A — table + pages</a></li>
    <li><a href="/admin/?variant=B">SPA variant B — master-detail</a></li>
    <li><a href="/admin/?variant=C">SPA variant C — feed + drawer</a></li>
    <li><a href="/ssr/">Variant D — server-rendered HTML, no client JS</a></li>
  </ul>`),
);

// ---- ADR 0009 mock (ticket #20 screens, variants E/F) ----
app.route('/api/v1', v1);
app.route('/__proto', proto);

// ---- old placeholder API used by variants A-D (ticket #11; shape predates ADR 0009) ----
app.get('/api/links', (c) => c.json({ links: [...links].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }));
app.get('/api/links/:slug', (c) => {
  const l = findLink(c.req.param('slug'));
  return l ? c.json(l) : c.json({ error: 'not_found' }, 404);
});
app.get('/api/links/:slug/breakdown', (c) => {
  const l = findLink(c.req.param('slug'));
  return l ? c.json(breakdown(l.slug, asRange(c.req.query('range')))) : c.json({ error: 'not_found' }, 404);
});
app.get('/api/overview', (c) => c.json(instanceOverview(asRange(c.req.query('range')))));

export function createLink(input: { destination: string; slug?: string; title?: string }) {
  const destination = (input.destination ?? '').trim();
  if (!/^https?:\/\/\S+$/.test(destination)) return { error: 'destination must be an absolute http(s) URL' };
  let slug = (input.slug ?? '').trim();
  if (slug) {
    if (!SLUG.test(slug)) return { error: 'slug may contain A-Z a-z 0-9 _ - (max 64)' };
    if (RESERVED.test(slug)) return { error: `"${slug}" is a reserved path` };
    if (findLink(slug)) return { error: `slug "${slug}" is already taken` };
  } else {
    do slug = generateSlug(); while (findLink(slug));
  }
  const link = { slug, destination, title: input.title?.trim() || null, disabled: false, syncPending: false, clickCount: 0, createdAt: new Date().toISOString() };
  links.unshift(link);
  return { link };
}
export function updateLink(slug: string, patch: { destination?: string; title?: string | null; disabled?: boolean }) {
  const l = findLink(slug);
  if (!l) return { error: 'not_found' };
  if (patch.destination !== undefined) {
    if (!/^https?:\/\/\S+$/.test(patch.destination.trim())) return { error: 'destination must be an absolute http(s) URL' };
    l.destination = patch.destination.trim();
  }
  if (patch.title !== undefined) l.title = patch.title?.trim() || null;
  if (patch.disabled !== undefined) l.disabled = patch.disabled;
  l.syncPending = false;
  return { link: l };
}
export function deleteLink(slug: string) {
  const i = links.findIndex((l) => l.slug === slug);
  if (i < 0) return false;
  links.splice(i, 1);
  return true;
}

app.post('/api/links', async (c) => {
  const r = createLink(await c.req.json());
  return 'error' in r ? c.json(r, 400) : c.json(r.link, 201);
});
app.patch('/api/links/:slug', async (c) => {
  const r = updateLink(c.req.param('slug'), await c.req.json());
  return 'error' in r ? c.json(r, r.error === 'not_found' ? 404 : 400) : c.json(r.link);
});
app.delete('/api/links/:slug', (c) => (deleteLink(c.req.param('slug')) ? c.body(null, 204) : c.json({ error: 'not_found' }, 404)));

app.route('/ssr', ssr);
