// Variant A — "Table + pages": classic admin. Top nav, dense table, dedicated /new and /links/:slug pages.
// Hypothesis: operators want a spreadsheet-like list and a full page per link for stats.
import { useEffect, useState, type FormEvent } from 'react';
import { Link as RLink, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, copy, RANGES, shortUrl, type Breakdown, type Link, type Overview, type Range } from '../api';
import { Bars, TopList } from '../Chart';

const keep = (p: URLSearchParams) => `?variant=${p.get('variant') ?? 'A'}`;

function Nav() {
  const [p] = useSearchParams();
  return (
    <nav className="a-nav">
      <span className="brand">furea</span>
      <RLink className="on" to={`/${keep(p)}`}>Links</RLink>
      <a href="#">API keys</a><a href="#">Settings</a>
      <span style={{ flex: 1 }} /><a href="#">Log out</a>
    </nav>
  );
}
const Status = ({ l }: { l: Link }) => (
  <>{l.disabled ? <span className="badge off">Disabled</span> : <span className="badge">Active</span>} {l.syncPending && <span className="badge sync">Sync pending</span>}</>
);

function ListPage() {
  const [p] = useSearchParams();
  const nav = useNavigate();
  const [links, setLinks] = useState<Link[]>([]);
  const [ov, setOv] = useState<Overview | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => { api.links().then(setLinks); api.overview().then(setOv); }, []);
  const shown = links.filter((l) => (l.slug + ' ' + l.destination + ' ' + (l.title ?? '')).toLowerCase().includes(q.toLowerCase()));
  return (
    <main className="a-main">
      <div className="tiles">
        <div className="tile"><small>Clicks today</small><b>{ov?.today ?? '…'}</b><span className="est">estimated</span></div>
        <div className="tile"><small>Last 7 days</small><b>{ov?.last7d ?? '…'}</b><span className="est">estimated</span></div>
        <div className="tile"><small>Last 30 days</small><b>{ov?.last30d ?? '…'}</b><span className="est">estimated</span></div>
        <div className="tile"><small>Links</small><b>{links.length}</b></div>
      </div>
      <div className="a-toolbar">
        <input placeholder="Search slug, destination, title…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span style={{ flex: 1 }} />
        <button className="primary" onClick={() => nav(`/new${keep(p)}`)}>New link</button>
      </div>
      <table className="a-table">
        <thead><tr><th>Slug</th><th>Destination</th><th>Title</th><th>Status</th><th className="num">Lifetime</th><th>Created</th></tr></thead>
        <tbody>
          {shown.map((l) => (
            <tr key={l.slug} onClick={() => nav(`/links/${l.slug}${keep(p)}`)}>
              <td><code>/{l.slug}</code></td>
              <td><span className="dest" title={l.destination}>{l.destination}</span></td>
              <td>{l.title ?? <span className="muted">—</span>}</td>
              <td><Status l={l} /></td>
              <td className="num">{l.clickCount.toLocaleString()}</td>
              <td className="muted">{l.createdAt.slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

function NewPage() {
  const [p] = useSearchParams();
  const nav = useNavigate();
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const l = await api.create({ destination: String(f.get('destination')), slug: String(f.get('slug')), title: String(f.get('title')) });
      nav(`/links/${l.slug}${keep(p)}`);
    } catch (x) { setErr((x as Error).message); }
  };
  return (
    <main className="a-main">
      <p><RLink to={`/${keep(p)}`}>← Links</RLink></p>
      <form className="a-form" onSubmit={submit}>
        <h2 style={{ marginTop: 0 }}>New link</h2>
        {err && <div className="error">{err}</div>}
        <label>Destination<input name="destination" type="url" required placeholder="https://" autoFocus /></label>
        <label>Custom slug (optional)<input name="slug" placeholder="leave empty to generate a 6-character slug" /></label>
        <label>Title (optional, never shown to visitors)<input name="title" /></label>
        <p><button className="primary">Create link</button></p>
      </form>
    </main>
  );
}

function LinkPage() {
  const { slug = '' } = useParams();
  const [p] = useSearchParams();
  const nav = useNavigate();
  const [l, setL] = useState<Link | null>(null);
  const [range, setRange] = useState<Range>('7d');
  const [b, setB] = useState<Breakdown | null>(null);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.link(slug).then(setL); }, [slug]);
  useEffect(() => { api.breakdown(slug, range).then(setB); }, [slug, range]);
  if (!l) return <main className="a-main">Loading…</main>;
  const inRange = b?.series.reduce((a, s) => a + s.clicks, 0) ?? 0;
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try { setL(await api.update(slug, { destination: String(f.get('destination')), title: String(f.get('title')) })); setEditing(false); setErr(''); }
    catch (x) { setErr((x as Error).message); }
  };
  return (
    <main className="a-main">
      <p><RLink to={`/${keep(p)}`}>← Links</RLink></p>
      <div className="a-head">
        <h1><code>{shortUrl(l.slug)}</code></h1>
        <button onClick={() => copy(shortUrl(l.slug))}>Copy</button>
        <Status l={l} />
        <div className="a-actions">
          <button onClick={() => setEditing((v) => !v)}>Edit</button>
          <button onClick={async () => setL(await api.update(slug, { disabled: !l.disabled }))}>{l.disabled ? 'Enable' : 'Disable'}</button>
          <button className="danger" onClick={async () => { if (confirm(`Delete /${slug}? The slug becomes free again.`)) { await api.remove(slug); nav(`/${keep(p)}`); } }}>Delete</button>
        </div>
      </div>
      <p className="muted">{l.title ? <><b>{l.title}</b> · </> : null}{l.destination}</p>
      {editing && (
        <form className="a-form" onSubmit={save}>
          {err && <div className="error">{err}</div>}
          <label>Destination<input name="destination" type="url" defaultValue={l.destination} required /></label>
          <label>Title<input name="title" defaultValue={l.title ?? ''} /></label>
          <p><button className="primary">Save</button> <button type="button" className="ghost" onClick={() => setEditing(false)}>Cancel</button></p>
        </form>
      )}
      <div className="a-section tiles">
        <div className="tile"><small>Lifetime total</small><b>{l.clickCount.toLocaleString()}</b><span className="est">exact</span></div>
        <div className="tile"><small>Clicks, {range}</small><b>{inRange}</b><span className="est">estimated</span></div>
        <div className="tile"><small>Created</small><b style={{ fontSize: 16 }}>{l.createdAt.slice(0, 10)}</b></div>
      </div>
      <div className="a-section" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div className="tabs">{RANGES.map((r) => <button key={r} className={r === range ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>)}</div>
        <span className="est">Breakdowns cover the last 90 days and are estimates.</span>
      </div>
      {b && <>
        <div style={{ marginTop: 12 }}><Bars series={b.series} /></div>
        <div className="a-section cols3">
          <TopList title="Countries" rows={b.countries} total={inRange} />
          <TopList title="Referrer hosts" rows={b.referrers} total={inRange} />
          <TopList title="Device classes" rows={b.devices} total={inRange} />
        </div>
      </>}
    </main>
  );
}

export function VariantA() {
  return (
    <>
      <Nav />
      <Routes>
        <Route path="/" element={<ListPage />} />
        <Route path="/new" element={<NewPage />} />
        <Route path="/links/:slug" element={<LinkPage />} />
      </Routes>
    </>
  );
}
