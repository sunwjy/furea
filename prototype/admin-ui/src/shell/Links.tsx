// Link screens in the layout confirmed by ticket #11: tiles above a reverse-chronological card feed, /new as its own
// page, /links/:slug as its own page with explicit Edit → Save. New here: the degraded (no analytics token) layout
// and the sync-pending badge + notice.
import { useEffect, useState } from 'react';
import { Link as RLink, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, copy, RANGES, type InstanceStats, type Link, type LinkStats, type Range } from './v1api';
import { Bars, Sparkline, TopList } from '../Chart';
import { useShell, useTo } from './Shell';

const SYNC_TIP = 'Saved, but the redirect cache has not caught up yet. furea retries automatically within 5 minutes; until then the short URL may still answer with the previous state.';

function AnalyticsOffHint({ compact }: { compact?: boolean }) {
  const to = useTo();
  return (
    <div className="s-hint">
      <b>Click breakdowns are off.</b> Lifetime totals are still counted exactly.
      {!compact && <> To see today / 7 d / 30 d, countries, referrers and devices, add a read-only analytics token with <code>npx furea analytics-token</code>.</>}
      {' '}<RLink to={to('/settings')}>Details</RLink>
    </div>
  );
}

export function Feed() {
  const { settings } = useShell();
  const to = useTo();
  const [items, setItems] = useState<Link[] | null>(null);
  const [stats, setStats] = useState<InstanceStats | null>(null);
  const [q, setQ] = useState('');
  const reload = () => api.links(q).then((r) => setItems(r.items));
  useEffect(() => { reload(); }, [q]);
  useEffect(() => { if (settings.analyticsConfigured) api.stats('7d').then(setStats).catch(() => {}); }, []);
  return (
    <>
      <div className="s-feed-head">
        <input placeholder="Search slug, title, destination" value={q} onChange={(e) => setQ(e.target.value)} />
        <RLink to={to('/new')}><button className="primary">New link</button></RLink>
      </div>
      {settings.analyticsConfigured ? (
        <div className="c-strip">
          <span><b>{stats?.today ?? '…'}</b>today</span>
          <span><b>{stats?.last7d ?? '…'}</b>7 days</span>
          <span><b>{stats?.last30d ?? '…'}</b>30 days</span>
          <span><b>{items?.length ?? '…'}</b>links</span>
          <span className="est" style={{ marginLeft: 'auto' }}>estimates</span>
        </div>
      ) : (
        <div className="c-strip"><span><b>{items?.length ?? '…'}</b>links</span><span style={{ flex: 1 }}><AnalyticsOffHint /></span></div>
      )}
      {items?.map((l) => <Card key={l.slug} l={l} series={stats?.seriesBySlug[l.slug]} analytics={settings.analyticsConfigured} onChange={reload} />)}
      {items?.length === 0 && <p className="muted">No links match.</p>}
    </>
  );
}

function Card({ l, series, analytics, onChange }: { l: Link; series?: { clicks: number }[]; analytics: boolean; onChange: () => void }) {
  const to = useTo();
  return (
    <div className={`c-card ${l.enabled ? '' : 'off'}`} style={analytics ? undefined : { gridTemplateColumns: '1fr 110px' }}>
      <div>
        <div className="short">
          <RLink to={to(`/links/${l.slug}`)} style={{ textDecoration: 'none', color: 'inherit' }}>{l.shortUrl.replace('https://', '')}</RLink>
          {' '}{!l.enabled && <span className="badge off">Disabled</span>}
          {!l.cacheSynced && <span className="badge sync" title={SYNC_TIP}>Sync pending</span>}
        </div>
        <div className="dest">{l.title && <b style={{ color: 'var(--text)' }}>{l.title} · </b>}{l.destination}</div>
        <div className="acts">
          <button onClick={() => copy(l.shortUrl)}>Copy</button>
          <button onClick={async () => { await api.patch(l.slug, { enabled: !l.enabled }); onChange(); }}>{l.enabled ? 'Disable' : 'Enable'}</button>
          <button className="danger" onClick={async () => { if (confirm(`Delete /${l.slug}? The slug becomes free again.`)) { await api.remove(l.slug); onChange(); } }}>Delete</button>
        </div>
      </div>
      <div className="side">
        <b>{l.clickCount.toLocaleString()}</b>
        <span className="est">{analytics ? 'lifetime · 7 d ↓' : 'lifetime clicks'}</span>
        {analytics && series && <Sparkline series={series} />}
      </div>
    </div>
  );
}

function FieldErr({ e, f }: { e: ApiError | null; f: string }) {
  const m = e?.field(f);
  return m ? <div className="s-field-err">{m}</div> : null;
}

export function NewLink() {
  const navigate = useNavigate();
  const to = useTo();
  const [f, setF] = useState({ destination: '', slug: '', title: '' });
  const [e, setE] = useState<ApiError | null>(null);
  const set = (k: keyof typeof f) => (ev: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: ev.target.value });
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    try {
      const l = await api.create({ destination: f.destination, ...(f.slug ? { slug: f.slug } : {}), ...(f.title ? { title: f.title } : {}) });
      copy(l.shortUrl);
      navigate(to(`/links/${l.slug}`), { state: { created: true } });
    } catch (x) { setE(x as ApiError); }
  };
  return (
    <form className="s-page" onSubmit={submit}>
      <h1>New link</h1>
      <label>Destination<input autoFocus value={f.destination} onChange={set('destination')} placeholder="https://…" /></label>
      <FieldErr e={e} f="destination" />
      <label>Custom slug <span className="muted">(optional — leave empty for a generated one)</span><input value={f.slug} onChange={set('slug')} /></label>
      <FieldErr e={e} f="slug" />
      {e?.code === 'slug_taken' && <div className="s-field-err">{e.message}</div>}
      <label>Title <span className="muted">(optional)</span><input value={f.title} onChange={set('title')} /></label>
      <FieldErr e={e} f="title" />
      <div className="s-row"><button className="primary">Create and copy</button><RLink to={to('/')}>Cancel</RLink></div>
    </form>
  );
}

export function LinkPage() {
  const { slug = '' } = useParams();
  const { settings } = useShell();
  const navigate = useNavigate();
  const to = useTo();
  const [l, setL] = useState<Link | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ destination: '', title: '' });
  const [e, setE] = useState<ApiError | null>(null);
  const [range, setRange] = useState<Range>('7d');
  const [stats, setStats] = useState<LinkStats | null>(null);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => { api.link(slug).then(setL).catch(() => setNotFound(true)); }, [slug]);
  useEffect(() => { if (settings.analyticsConfigured) api.linkStats(slug, range).then(setStats).catch(() => setStats(null)); }, [slug, range]);
  if (notFound) return <p>No link <code>/{slug}</code>. <RLink to={to('/')}>Back to links</RLink></p>;
  if (!l) return <p className="muted">Loading…</p>;
  const save = async () => {
    try {
      setL(await api.patch(slug, { destination: draft.destination, title: draft.title || null }));
      setEditing(false); setE(null);
    } catch (x) { setE(x as ApiError); }
  };
  const retrySync = async () => { setRetrying(true); setL(await api.patch(slug, {})); setRetrying(false); };
  const inRange = stats?.series.reduce((a, s) => a + s.clicks, 0) ?? 0;
  return (
    <div>
      <p><RLink to={to('/')}>← Links</RLink></p>
      <div className="s-link-head">
        <h1><code>{l.shortUrl.replace('https://', '')}</code></h1>
        <button onClick={() => copy(l.shortUrl)}>Copy</button>
        {!l.enabled && <span className="badge off">Disabled</span>}
        {!l.cacheSynced && <span className="badge sync">Sync pending</span>}
      </div>

      {!l.cacheSynced && (
        <div className="s-notice">
          <b>Sync pending.</b> This link is saved, but the redirect cache has not caught up yet, so <code>/{l.slug}</code> may
          still answer with its previous state for a few minutes. furea retries automatically.
          {' '}<button onClick={retrySync} disabled={retrying}>{retrying ? 'Retrying…' : 'Retry now'}</button>
        </div>
      )}

      <div className="s-panel">
        {editing ? (
          <>
            <label>Destination<input value={draft.destination} onChange={(ev) => setDraft({ ...draft, destination: ev.target.value })} /></label>
            <FieldErr e={e} f="destination" />
            <label>Title<input value={draft.title} onChange={(ev) => setDraft({ ...draft, title: ev.target.value })} /></label>
            <FieldErr e={e} f="title" />
            <div className="s-row"><button className="primary" onClick={save}>Save</button><button className="ghost" onClick={() => { setEditing(false); setE(null); }}>Cancel</button></div>
          </>
        ) : (
          <>
            <dl className="s-dl">
              <dt>Destination</dt><dd><a href={l.destination}>{l.destination}</a></dd>
              <dt>Title</dt><dd>{l.title ?? <span className="muted">—</span>}</dd>
              <dt>Created</dt><dd>{new Date(l.createdAt).toLocaleString()}</dd>
            </dl>
            <div className="s-row">
              <button onClick={() => { setDraft({ destination: l.destination, title: l.title ?? '' }); setEditing(true); }}>Edit</button>
              <button onClick={async () => setL(await api.patch(slug, { enabled: !l.enabled }))}>{l.enabled ? 'Disable' : 'Enable'}</button>
              <button className="danger" onClick={async () => { if (confirm(`Delete /${l.slug}?`)) { await api.remove(slug); navigate(to('/')); } }}>Delete</button>
            </div>
          </>
        )}
      </div>

      <div className="tiles" style={{ marginTop: 16 }}>
        <div className="tile"><small>Lifetime clicks</small><b>{l.clickCount.toLocaleString()}</b><span className="est">exact</span></div>
        {settings.analyticsConfigured && <div className="tile"><small>Last {range}</small><b>{inRange}</b><span className="est">estimated</span></div>}
      </div>

      {settings.analyticsConfigured ? (
        <>
          <div style={{ margin: '16px 0 8px' }} className="tabs">{RANGES.map((r) => <button key={r} className={r === range ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>)}</div>
          {stats && <>
            <Bars series={stats.series.map((s) => ({ t: s.start, clicks: s.clicks }))} height={110} />
            <div className="cols3" style={{ marginTop: 16 }}>
              <TopList title="Countries" rows={stats.countries.map((r) => ({ key: r.country, clicks: r.clicks }))} total={inRange} />
              <TopList title="Referrer hosts" rows={stats.referrerHosts.map((r) => ({ key: r.host, clicks: r.clicks }))} total={inRange} />
              <TopList title="Device classes" rows={stats.deviceClasses.map((r) => ({ key: r.deviceClass, clicks: r.clicks }))} total={inRange} />
            </div>
            <p className="est">Breakdowns are estimates over the last 90 days, in {stats.tz}.</p>
          </>}
        </>
      ) : <div style={{ marginTop: 16 }}><AnalyticsOffHint /></div>}
    </div>
  );
}
