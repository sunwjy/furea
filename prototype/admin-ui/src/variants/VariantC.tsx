// Variant C — "Feed + drawer": creation is the hero (big paste box), links are a reverse-chronological card
// feed with a 7-day sparkline and inline actions; stats open in a slide-over drawer, so the feed stays put.
// Hypothesis: the dominant job is "shorten this now, copy it"; stats are a glance, not a destination.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, copy, RANGES, shortUrl, type Breakdown, type Link, type Overview, type Range } from '../api';
import { Bars, Sparkline, TopList } from '../Chart';

export function VariantC() {
  const [params, setParams] = useSearchParams();
  const open = params.get('slug');
  const [links, setLinks] = useState<Link[]>([]);
  const [ov, setOv] = useState<Overview | null>(null);
  const [dest, setDest] = useState('');
  const [more, setMore] = useState(false);
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [err, setErr] = useState('');
  const [justMade, setJustMade] = useState<Link | null>(null);
  const reload = () => api.links().then(setLinks);
  useEffect(() => { reload(); api.overview().then(setOv); }, []);
  const setOpen = (s: string | null) => { const p = new URLSearchParams(params); s ? p.set('slug', s) : p.delete('slug'); setParams(p, { replace: true }); };
  const create = async () => {
    try {
      const l = await api.create({ destination: dest, slug, title });
      setDest(''); setSlug(''); setTitle(''); setMore(false); setErr(''); setJustMade(l); copy(shortUrl(l.slug)); reload();
    } catch (x) { setErr((x as Error).message); }
  };
  return (
    <div className="c-root">
      <div className="c-brand"><b>furea</b><span className="muted">Links · API keys · Settings · Log out</span></div>
      <div className="c-hero">
        <div className="row">
          <input placeholder="Paste a long URL to shorten it" value={dest} onChange={(e) => setDest(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} autoFocus />
          <button className="primary" onClick={create}>Shorten</button>
        </div>
        {more ? (
          <div className="more">
            <input placeholder="custom slug (optional)" value={slug} onChange={(e) => setSlug(e.target.value)} />
            <input placeholder="title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        ) : <button className="ghost" style={{ marginTop: 6, fontSize: 12 }} onClick={() => setMore(true)}>+ custom slug / title</button>}
        {err && <div className="error">{err}</div>}
        {justMade && <div style={{ marginTop: 10 }}>Created <code>{shortUrl(justMade.slug)}</code> — copied to clipboard. <a href="#" onClick={(e) => { e.preventDefault(); setOpen(justMade.slug); }}>Open</a></div>}
      </div>
      <div className="c-strip">
        <span><b>{ov?.today ?? '…'}</b>today</span>
        <span><b>{ov?.last7d ?? '…'}</b>7 days</span>
        <span><b>{ov?.last30d ?? '…'}</b>30 days</span>
        <span><b>{links.length}</b>links</span>
        <span className="est" style={{ marginLeft: 'auto' }}>estimates, last 90 days</span>
      </div>
      {links.map((l) => <Card key={l.slug} l={l} onOpen={() => setOpen(l.slug)} onChange={reload} />)}
      {open && <Drawer slug={open} onClose={() => setOpen(null)} onChange={reload} />}
    </div>
  );
}

function Card({ l, onOpen, onChange }: { l: Link; onOpen: () => void; onChange: () => void }) {
  const [b, setB] = useState<Breakdown | null>(null);
  useEffect(() => { api.breakdown(l.slug, '7d').then(setB); }, [l.slug]);
  return (
    <div className={`c-card ${l.disabled ? 'off' : ''}`}>
      <div>
        <div className="short"><a href="#" onClick={(e) => { e.preventDefault(); onOpen(); }} style={{ textDecoration: 'none', color: 'inherit' }}>{shortUrl(l.slug).replace('https://', '')}</a>
          {' '}{l.disabled && <span className="badge off">Disabled</span>}{l.syncPending && <span className="badge sync">Sync pending</span>}</div>
        <div className="dest">{l.title && <b style={{ color: 'var(--text)' }}>{l.title} · </b>}{l.destination}</div>
        <div className="acts">
          <button onClick={() => copy(shortUrl(l.slug))}>Copy</button>
          <button onClick={onOpen}>Stats & edit</button>
          <button onClick={async () => { await api.update(l.slug, { disabled: !l.disabled }); onChange(); }}>{l.disabled ? 'Enable' : 'Disable'}</button>
          <button className="danger" onClick={async () => { if (confirm(`Delete /${l.slug}?`)) { await api.remove(l.slug); onChange(); } }}>Delete</button>
        </div>
      </div>
      <div className="side">
        <b>{l.clickCount.toLocaleString()}</b>
        <span className="est">lifetime · 7d ↓</span>
        {b && <Sparkline series={b.series} />}
      </div>
    </div>
  );
}

function Drawer({ slug, onClose, onChange }: { slug: string; onClose: () => void; onChange: () => void }) {
  const [l, setL] = useState<Link | null>(null);
  const [range, setRange] = useState<Range>('7d');
  const [b, setB] = useState<Breakdown | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.link(slug).then(setL).catch(onClose); }, [slug]);
  useEffect(() => { api.breakdown(slug, range).then(setB); }, [slug, range]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  if (!l) return null;
  const inRange = b?.series.reduce((a, s) => a + s.clicks, 0) ?? 0;
  const patch = async (p: Parameters<typeof api.update>[1]) => {
    try { setL(await api.update(slug, p)); setErr(''); onChange(); } catch (x) { setErr((x as Error).message); }
  };
  return (
    <>
      <div className="c-backdrop" onClick={onClose} />
      <aside className="c-drawer">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2><code>/{l.slug}</code></h2>
          <button onClick={() => copy(shortUrl(l.slug))}>Copy</button>
          <span style={{ flex: 1 }} /><button className="ghost" onClick={onClose}>✕</button>
        </div>
        <label>Destination<input type="url" defaultValue={l.destination} onBlur={(e) => e.target.value !== l.destination && patch({ destination: e.target.value })} /></label>
        <label>Title<input defaultValue={l.title ?? ''} onBlur={(e) => e.target.value !== (l.title ?? '') && patch({ title: e.target.value })} /></label>
        {err && <div className="error">{err}</div>}
        <div className="tiles" style={{ marginTop: 16 }}>
          <div className="tile"><small>Lifetime</small><b>{l.clickCount.toLocaleString()}</b><span className="est">exact</span></div>
          <div className="tile"><small>{range}</small><b>{inRange}</b><span className="est">estimated</span></div>
        </div>
        <div style={{ margin: '14px 0 8px' }} className="tabs">{RANGES.map((r) => <button key={r} className={r === range ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>)}</div>
        {b && <>
          <Bars series={b.series} height={90} />
          <div style={{ marginTop: 16, display: 'grid', gap: 16 }}>
            <TopList title="Countries" rows={b.countries} total={inRange} />
            <TopList title="Referrer hosts" rows={b.referrers} total={inRange} />
            <TopList title="Device classes" rows={b.devices} total={inRange} />
          </div>
        </>}
      </aside>
    </>
  );
}
