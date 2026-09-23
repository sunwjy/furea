// Variant B — "Master-detail": one screen, list on the left, selected link on the right. No page navigation.
// Hypothesis: a single operator with tens of links wants everything one click away, keyboard-first,
// paste-a-URL-and-Enter creation, fields that save on blur.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, copy, RANGES, shortUrl, type Breakdown, type Link, type Overview, type Range } from '../api';
import { Bars, TopList } from '../Chart';

export function VariantB() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('slug');
  const [links, setLinks] = useState<Link[]>([]);
  const [q, setQ] = useState('');
  const [quick, setQuick] = useState('');
  const [err, setErr] = useState('');
  const reload = () => api.links().then(setLinks);
  useEffect(() => { reload(); }, []);
  const select = (slug: string | null) => {
    const p = new URLSearchParams(params);
    slug ? p.set('slug', slug) : p.delete('slug');
    setParams(p, { replace: true });
  };
  const quickCreate = async () => {
    try { const l = await api.create({ destination: quick }); setQuick(''); setErr(''); await reload(); select(l.slug); }
    catch (x) { setErr((x as Error).message); }
  };
  const shown = links.filter((l) => (l.slug + ' ' + l.destination + ' ' + (l.title ?? '')).toLowerCase().includes(q.toLowerCase()));
  const link = links.find((l) => l.slug === selected) ?? null;
  return (
    <div className="b-root">
      <aside className="b-list">
        <div className="b-list-head">
          <div className="brand"><span>furea</span><span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>Links · API keys · Settings</span></div>
          <input placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="b-quick">
            <input placeholder="Paste a destination and press Enter" value={quick} onChange={(e) => setQuick(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && quickCreate()} />
            <button className="primary" onClick={quickCreate}>+</button>
          </div>
          {err && <div className="error">{err}</div>}
        </div>
        <div className="b-items">
          <button className={`b-item ${selected ? '' : 'on'}`} onClick={() => select(null)}>
            <div className="row1"><b>Overview</b><span className="muted">{links.length} links</span></div>
          </button>
          {shown.map((l) => (
            <button key={l.slug} className={`b-item ${l.slug === selected ? 'on' : ''}`} onClick={() => select(l.slug)}>
              <div className="row1">
                <span><code>/{l.slug}</code> {l.disabled && <span className="badge off">off</span>}{l.syncPending && <span className="badge sync">sync</span>}</span>
                <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>{l.clickCount.toLocaleString()}</span>
              </div>
              <div className="row2">{l.title ?? l.destination}</div>
            </button>
          ))}
        </div>
      </aside>
      <section className="b-detail">
        {link ? <Detail key={link.slug} link={link} onChange={reload} onDeleted={() => { reload(); select(null); }} /> : <OverviewPane onPick={select} />}
      </section>
    </div>
  );
}

function OverviewPane({ onPick }: { onPick: (s: string) => void }) {
  const [range, setRange] = useState<Range>('7d');
  const [ov, setOv] = useState<Overview | null>(null);
  useEffect(() => { api.overview(range).then(setOv); }, [range]);
  return (
    <>
      <h1>Overview</h1>
      <p className="est">Everything here is estimated from the last 90 days. Lifetime totals per link are exact.</p>
      <div className="tiles" style={{ maxWidth: 600 }}>
        <div className="tile"><small>Today</small><b>{ov?.today ?? '…'}</b></div>
        <div className="tile"><small>Last 7 days</small><b>{ov?.last7d ?? '…'}</b></div>
        <div className="tile"><small>Last 30 days</small><b>{ov?.last30d ?? '…'}</b></div>
      </div>
      <h3 style={{ marginTop: 28 }}>Top links <span className="tabs" style={{ marginLeft: 8 }}>{RANGES.map((r) => <button key={r} className={r === range ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>)}</span></h3>
      <div style={{ maxWidth: 600 }}>
        {ov?.top.map((t) => (
          <div key={t.slug} className="toplist-row" style={{ gridTemplateColumns: '1fr 60px' }}>
            <a href="#" onClick={(e) => { e.preventDefault(); onPick(t.slug); }}><code>/{t.slug}</code> <span className="muted">{t.title}</span></a>
            <span className="toplist-num">{t.clicks}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function Detail({ link, onChange, onDeleted }: { link: Link; onChange: () => void; onDeleted: () => void }) {
  const [range, setRange] = useState<Range>('7d');
  const [b, setB] = useState<Breakdown | null>(null);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => { api.breakdown(link.slug, range).then(setB); }, [link.slug, range]);
  const inRange = b?.series.reduce((a, s) => a + s.clicks, 0) ?? 0;
  const patch = async (p: Parameters<typeof api.update>[1]) => {
    try { await api.update(link.slug, p); setErr(''); setSaved('Saved'); setTimeout(() => setSaved(''), 1200); onChange(); }
    catch (x) { setErr((x as Error).message); }
  };
  return (
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <h1><code>{shortUrl(link.slug)}</code></h1>
        <button onClick={() => copy(shortUrl(link.slug))}>Copy</button>
        {link.disabled ? <span className="badge off">Disabled</span> : <span className="badge">Active</span>}
        {link.syncPending && <span className="badge sync">Sync pending</span>}
        <span style={{ flex: 1 }} />
        <button onClick={() => patch({ disabled: !link.disabled })}>{link.disabled ? 'Enable' : 'Disable'}</button>
        <button className="danger" onClick={async () => { if (confirm(`Delete /${link.slug}?`)) { await api.remove(link.slug); onDeleted(); } }}>Delete</button>
      </div>
      <div className="b-fields">
        <label>Destination<input type="url" defaultValue={link.destination} onBlur={(e) => e.target.value !== link.destination && patch({ destination: e.target.value })} /></label>
        <label>Title<input defaultValue={link.title ?? ''} onBlur={(e) => e.target.value !== (link.title ?? '') && patch({ title: e.target.value })} /></label>
      </div>
      <div className="b-hint">Fields save when you leave them. {saved && <b style={{ color: 'green' }}>{saved}</b>}</div>
      {err && <div className="error">{err}</div>}
      <div className="tiles" style={{ maxWidth: 600, marginTop: 24 }}>
        <div className="tile"><small>Lifetime total</small><b>{link.clickCount.toLocaleString()}</b><span className="est">exact</span></div>
        <div className="tile"><small>Clicks, {range}</small><b>{inRange}</b><span className="est">estimated</span></div>
        <div className="tile"><small>Created</small><b style={{ fontSize: 16 }}>{link.createdAt.slice(0, 10)}</b></div>
      </div>
      <div style={{ marginTop: 20, display: 'flex', gap: 12, alignItems: 'center' }}>
        <div className="tabs">{RANGES.map((r) => <button key={r} className={r === range ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>)}</div>
        <span className="est">last 90 days, estimated</span>
      </div>
      {b && <>
        <div style={{ marginTop: 12, maxWidth: 800 }}><Bars series={b.series} height={100} /></div>
        <div className="cols3" style={{ marginTop: 20, maxWidth: 800 }}>
          <TopList title="Countries" rows={b.countries} total={inRange} />
          <TopList title="Referrer hosts" rows={b.referrers} total={inRange} />
          <TopList title="Device classes" rows={b.devices} total={inRange} />
        </div>
      </>}
    </>
  );
}
