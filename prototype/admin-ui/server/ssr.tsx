/** @jsxImportSource hono/jsx */
// PROTOTYPE — Variant D: server-rendered admin surface. Plain HTML + forms, zero client JS.
// Exists to answer "does SPA-on-Static-Assets feel right versus server-rendered HTML?"
import { Hono } from 'hono';
import { links, findLink, breakdown, instanceOverview, type Range, type Breakdown } from './data';
import { createLink, updateLink, deleteLink } from './app';

export const ssr = new Hono({ strict: false });
const RANGES: Range[] = ['24h', '7d', '30d', '90d'];
const asRange = (v: string | undefined): Range => (RANGES.includes(v as Range) ? (v as Range) : '7d');

const css = `
  body{font:14px/1.45 system-ui,sans-serif;margin:0;background:#fafafa;color:#1a1a1a}
  header{background:#111;color:#fff;padding:10px 20px;display:flex;gap:20px;align-items:center}
  header a{color:#fff;text-decoration:none} header .brand{font-weight:700}
  main{max-width:1000px;margin:0 auto;padding:20px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #ddd}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eee;vertical-align:top}
  th{font-size:12px;text-transform:uppercase;color:#666}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .dest{color:#555;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
  .badge{font-size:11px;padding:1px 6px;border-radius:3px;background:#eee}
  .badge.off{background:#fde2e2;color:#8a1c1c} .badge.sync{background:#fff3cd;color:#7a5a00}
  form.inline{display:inline} fieldset{border:1px solid #ddd;background:#fff;padding:12px;margin:0 0 20px}
  label{display:block;font-size:12px;color:#555;margin:6px 0 2px} input[type=text],input[type=url]{width:100%;padding:6px;box-sizing:border-box}
  button{padding:6px 12px} .danger{color:#8a1c1c}
  .tiles{display:flex;gap:12px;margin:0 0 20px} .tile{flex:1;background:#fff;border:1px solid #ddd;padding:12px}
  .tile b{display:block;font-size:22px} .tile small{color:#777}
  .cols{display:grid;grid-template-columns:repeat(3,1fr);gap:12px} .cols table{font-size:13px}
  .bars{display:flex;align-items:flex-end;gap:2px;height:120px;background:#fff;border:1px solid #ddd;padding:8px}
  .bars i{flex:1;background:#4f7cff;display:block;min-height:1px}
  .tabs a{margin-right:10px} .tabs a.on{font-weight:700;text-decoration:none}
  .switcher{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#ff2d95;color:#fff;padding:8px 14px;border-radius:999px;font-weight:700;box-shadow:0 4px 16px rgba(0,0,0,.3)}
  .switcher a{color:#fff;margin:0 8px}
  .err{background:#fde2e2;color:#8a1c1c;padding:8px;margin-bottom:12px}
`;

const Layout = ({ title, children }: { title: string; children: any }) => (
  <html>
    <head><meta charset="utf-8" /><title>{title} — furea (SSR prototype)</title><style>{css}</style></head>
    <body>
      <header>
        <a class="brand" href="/ssr/">furea</a>
        <a href="/ssr/">Links</a><a href="#">API keys</a><a href="#">Settings</a>
        <span style="flex:1" /><a href="#">Log out</a>
      </header>
      <main>{children}</main>
      <div class="switcher"><a href="/admin/?variant=C">←</a> D — server-rendered HTML (no JS) <a href="/admin/?variant=A">→</a></div>
    </body>
  </html>
);

const Status = ({ l }: { l: (typeof links)[number] }) => (
  <>{l.disabled ? <span class="badge off">Disabled</span> : <span class="badge">Active</span>}{l.syncPending && <span class="badge sync"> Sync pending</span>}</>
);

ssr.get('/', (c) => {
  const err = c.req.query('error') ?? '';
  const ov = instanceOverview('7d');
  return c.html(
    <Layout title="Links">
      <div class="tiles">
        <div class="tile"><small>Today</small><b>{ov.today}</b><small>est.</small></div>
        <div class="tile"><small>Last 7 days</small><b>{ov.last7d}</b><small>est.</small></div>
        <div class="tile"><small>Last 30 days</small><b>{ov.last30d}</b><small>est.</small></div>
        <div class="tile"><small>Links</small><b>{links.length}</b></div>
      </div>
      {err && <div class="err">{err}</div>}
      <fieldset>
        <legend>New link</legend>
        <form method="post" action="/ssr/links">
          <label>Destination</label><input type="url" name="destination" required placeholder="https://" />
          <label>Custom slug (optional)</label><input type="text" name="slug" placeholder="leave empty to generate" />
          <label>Title (optional)</label><input type="text" name="title" />
          <p><button type="submit">Create link</button></p>
        </form>
      </fieldset>
      <table>
        <thead><tr><th>Slug</th><th>Destination</th><th>Title</th><th>Status</th><th style="text-align:right">Lifetime</th><th>Created</th></tr></thead>
        <tbody>
          {[...links].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((l) => (
            <tr>
              <td><a href={`/ssr/links/${l.slug}`}><code>/{l.slug}</code></a></td>
              <td><span class="dest" title={l.destination}>{l.destination}</span></td>
              <td>{l.title ?? <i style="color:#999">—</i>}</td>
              <td><Status l={l} /></td>
              <td class="num">{l.clickCount.toLocaleString()}</td>
              <td>{l.createdAt.slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>,
  );
});

ssr.post('/links', async (c) => {
  const f = await c.req.parseBody();
  const r = createLink({ destination: String(f.destination ?? ''), slug: String(f.slug ?? ''), title: String(f.title ?? '') });
  return 'error' in r ? c.redirect(`/ssr/?error=${encodeURIComponent(String(r.error))}`) : c.redirect(`/ssr/links/${r.link.slug}`);
});

const Top = ({ title, rows }: { title: string; rows: Breakdown['countries'] }) => (
  <table><thead><tr><th>{title}</th><th style="text-align:right">Clicks</th></tr></thead>
    <tbody>{rows.slice(0, 10).map((r) => <tr><td>{r.key}</td><td class="num">{r.clicks}</td></tr>)}</tbody></table>
);

ssr.get('/links/:slug', (c) => {
  const l = findLink(c.req.param('slug'));
  if (!l) return c.notFound();
  const range = asRange(c.req.query('range'));
  const b = breakdown(l.slug, range);
  const max = Math.max(1, ...b.series.map((s) => s.clicks));
  const err = c.req.query('error') ?? '';
  return c.html(
    <Layout title={`/${l.slug}`}>
      <p><a href="/ssr/">← All links</a></p>
      <h2 style="margin:0"><code>https://s.example.com/{l.slug}</code> <Status l={l} /></h2>
      <p style="color:#555">{l.destination}</p>
      {err && <div class="err">{err}</div>}
      <fieldset>
        <legend>Edit</legend>
        <form method="post" action={`/ssr/links/${l.slug}`}>
          <label>Destination</label><input type="url" name="destination" value={l.destination} required />
          <label>Title</label><input type="text" name="title" value={l.title ?? ''} />
          <p>
            <button name="action" value="update">Save</button>{' '}
            <button name="action" value={l.disabled ? 'enable' : 'disable'}>{l.disabled ? 'Enable' : 'Disable'}</button>{' '}
            <button name="action" value="delete" class="danger">Delete</button>
          </p>
        </form>
      </fieldset>
      <div class="tiles">
        <div class="tile"><small>Lifetime total (exact)</small><b>{l.clickCount.toLocaleString()}</b></div>
        <div class="tile"><small>Clicks in range</small><b>{b.series.reduce((a, s) => a + s.clicks, 0)}</b><small>last 90 days, estimated</small></div>
        <div class="tile"><small>Created</small><b style="font-size:16px">{l.createdAt.slice(0, 10)}</b></div>
      </div>
      <p class="tabs">{RANGES.map((r) => <a href={`?range=${r}`} class={r === range ? 'on' : ''}>{r}</a>)} <small style="color:#777">estimated, last 90 days</small></p>
      <div class="bars">{b.series.map((s) => <i style={`height:${(s.clicks / max) * 100}%`} title={`${s.t.slice(0, 13)} ${s.clicks}`} />)}</div>
      <br />
      <div class="cols"><Top title="Country" rows={b.countries} /><Top title="Referrer host" rows={b.referrers} /><Top title="Device class" rows={b.devices} /></div>
    </Layout>,
  );
});

ssr.post('/links/:slug', async (c) => {
  const slug = c.req.param('slug');
  const f = await c.req.parseBody();
  const action = String(f.action);
  if (action === 'delete') { deleteLink(slug); return c.redirect('/ssr/'); }
  const r = action === 'update'
    ? updateLink(slug, { destination: String(f.destination ?? ''), title: String(f.title ?? '') })
    : updateLink(slug, { disabled: action === 'disable' });
  return 'error' in r ? c.redirect(`/ssr/links/${slug}?error=${encodeURIComponent(String(r.error))}`) : c.redirect(`/ssr/links/${slug}`);
});
