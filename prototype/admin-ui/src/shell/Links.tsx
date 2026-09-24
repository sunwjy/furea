// Link screens in the layout confirmed by ticket #11: tiles above a reverse-chronological card feed, /new as its own
// page, /links/:slug as its own page with explicit Edit → Save. New here: the degraded (no analytics token) layout
// and the sync-pending badge + notice.
import { useEffect, useState } from 'react';
import { Link as RLink, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, copy, RANGES, type Campaign, type InstanceStats, type Link, type LinkStats, type Own, type Range } from './v1api';
import { CampaignFields, FlaggedNotice, PlainBuilder, Preview } from './Builder';
import { CampaignGroupCard, MatrixGenerator } from './Campaigns';
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
  const { variant } = useShell();
  const [cmpFilter, setCmpFilter] = useState('any'); // variant I
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const reload = () => api.links(q).then((r) => setItems(r.items));
  useEffect(() => { reload(); }, [q]);
  useEffect(() => { api.campaigns().then((r) => setCampaigns(r.items)); }, []);
  useEffect(() => { if (settings.analyticsConfigured) api.stats('7d').then(setStats).catch(() => {}); }, []);
  return (
    <>
      <div className="s-feed-head">
        <input placeholder="Search slug, title, destination" value={q} onChange={(e) => setQ(e.target.value)} />
        {variant === 'I' && (
          <select value={cmpFilter} onChange={(e) => setCmpFilter(e.target.value)}>
            <option value="any">All links</option><option value="none">Not in a campaign</option>
            <optgroup label="Campaign">{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
          </select>
        )}
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
      {variant === 'H' ? (
        // H: a campaign is one grouped card in the feed, placed where its newest link would be
        items && groupFeed(items).map((g) => 'link' in g
          ? <Card key={g.link.slug} l={g.link} series={stats?.seriesBySlug[g.link.slug]} analytics={settings.analyticsConfigured} onChange={reload} />
          : <CampaignGroupCard key={g.campaign.id} campaign={campaigns.find((c) => c.id === g.campaign.id)} links={g.links} stats={stats} onChange={reload} />)
      ) : items?.filter((l) => cmpFilter === 'any' || (cmpFilter === 'none' ? !l.campaign : l.campaign?.id === cmpFilter))
        .map((l) => <Card key={l.slug} l={l} series={stats?.seriesBySlug[l.slug]} analytics={settings.analyticsConfigured} onChange={reload} />)}
      {items?.length === 0 && <p className="muted">No links match.</p>}
    </>
  );
}

type FeedItem = { link: Link } | { campaign: { id: string; name: string }; links: Link[] };
function groupFeed(items: Link[]): FeedItem[] {
  const out: FeedItem[] = []; const seen = new Map<string, Link[]>();
  for (const l of items) {
    if (!l.campaign) { out.push({ link: l }); continue; }
    const g = seen.get(l.campaign.id);
    if (g) g.push(l); else { const links = [l]; seen.set(l.campaign.id, links); out.push({ campaign: l.campaign, links }); }
  }
  return out;
}

export function Card({ l, series, analytics, onChange }: { l: Link; series?: { clicks: number }[]; analytics: boolean; onChange: () => void }) {
  const to = useTo();
  return (
    <div className={`c-card ${l.enabled ? '' : 'off'}`} style={analytics ? undefined : { gridTemplateColumns: '1fr 110px' }}>
      <div>
        <div className="short">
          <RLink to={to(`/links/${l.slug}`)} style={{ textDecoration: 'none', color: 'inherit' }}>{l.shortUrl.replace('https://', '')}</RLink>
          {' '}{!l.enabled && <span className="badge off">Disabled</span>}
          {!l.cacheSynced && <span className="badge sync" title={SYNC_TIP}>Sync pending</span>}
          {l.campaign && <CampaignBadge c={l.campaign} />}
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

function CampaignBadge({ c }: { c: { id: string; name: string } }) {
  const to = useTo();
  return <RLink to={to(`/campaigns/${c.id}`)} className="badge cmp" onClick={(e) => e.stopPropagation()}>⚑ {c.name}</RLink>;
}

function FieldErr({ e, f }: { e: ApiError | null; f: string }) {
  const m = e?.field(f);
  return m ? <div className="s-field-err">{m}</div> : null;
}

export function NewLink() {
  const navigate = useNavigate();
  const to = useTo();
  const { variant } = useShell();
  const [f, setF] = useState({ destination: '', slug: '', title: '' });
  const [e, setE] = useState<ApiError | null>(null);
  // variant I: pick a campaign right in this form; variant H: switch the whole page to the campaign generator
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [cmpId, setCmpId] = useState('');
  const [own, setOwn] = useState<Own>({ source: '', medium: '' });
  const [mode, setMode] = useState<'link' | 'campaign'>('link');
  useEffect(() => { if (variant !== 'G') api.campaigns().then((r) => setCampaigns(r.items)); }, []);
  const cmp = campaigns.find((c) => c.id === cmpId);
  const set = (k: keyof typeof f) => (ev: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: ev.target.value });
  const submit = async (ev?: React.FormEvent, skip = false) => {
    ev?.preventDefault();
    try {
      if (cmp) {
        const [l] = (await api.bulkCreate(cmp.id, [{ ...own, ...(f.slug ? { slug: f.slug } : {}), ...(f.title ? { title: f.title } : {}) }], skip)).items;
        copy(l.shortUrl); navigate(to(`/links/${l.slug}`), { state: { created: true } }); return;
      }
      const l = await api.create({ destination: f.destination, ...(f.slug ? { slug: f.slug } : {}), ...(f.title ? { title: f.title } : {}), ...(skip ? { screening: 'skip' as const } : {}) });
      copy(l.shortUrl);
      navigate(to(`/links/${l.slug}`), { state: { created: true } });
    } catch (x) { setE(x as ApiError); }
  };
  const err = (field: string) => cmp ? e?.field(`items[0].${field}`) : e?.field(field);
  return (
    <form className="s-page wide" onSubmit={submit}>
      <h1>New link</h1>
      {variant === 'H' && (
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button type="button" className={mode === 'link' ? 'on' : ''} onClick={() => setMode('link')}>Single link</button>
          <button type="button" className={mode === 'campaign' ? 'on' : ''} onClick={() => setMode('campaign')}>Campaign links</button>
        </div>
      )}
      {variant === 'H' && mode === 'campaign' ? <MatrixGenerator campaigns={campaigns} /> : <>
        {variant === 'I' && (
          <label>Campaign
            <select value={cmpId} onChange={(ev) => { setCmpId(ev.target.value); setE(null); }} style={{ width: '100%' }}>
              <option value="">None — a plain link</option>
              {campaigns.map((c) => <option key={c.id} value={c.id} disabled={c.linkCount >= c.cap}>{c.name} ({c.linkCount}/{c.cap})</option>)}
            </select>
          </label>
        )}
        {cmp ? <CampaignFields campaign={cmp} own={own} onChange={setOwn} errors={e} prefix="items[0]." /> : <>
          <label>Destination<input autoFocus value={f.destination} onChange={set('destination')} placeholder="https://…" /></label>
          <FieldErr e={e} f="destination" />
          <PlainBuilder destination={f.destination} onChange={(d) => setF({ ...f, destination: d })} />
        </>}
        <label>Custom slug <span className="muted">(optional — leave empty for a generated one)</span><input value={f.slug} onChange={set('slug')} /></label>
        {err('slug') && <div className="s-field-err">{err('slug')}</div>}
        {e?.code === 'slug_taken' && <div className="s-field-err">{e.message}</div>}
        <label>Title <span className="muted">(optional)</span><input value={f.title} onChange={set('title')} /></label>
        <FieldErr e={e} f="title" />
        <FlaggedNotice e={e} action="Create anyway" onOverride={() => submit(undefined, true)} />
        {variant === 'G' && <p className="muted s-small">Campaign links are created from their campaign's page (Campaigns → a campaign → Add links).</p>}
        <div className="s-row"><button className="primary">Create and copy</button><RLink to={to('/')}>Cancel</RLink></div>
      </>}
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
  const [own, setOwn] = useState<Own | null>(null); // campaign link's own UTM values
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [adoptMsg, setAdoptMsg] = useState<string | null>(null);
  const { variant } = useShell();
  const loadMember = (x: Link) => {
    if (x.campaign) api.campaign(x.campaign.id).then((c) => { setCampaign(c); setOwn(c.links.find((m) => m.slug === x.slug)?.utm ?? null); });
    else { setCampaign(null); setOwn(null); api.campaigns().then((r) => setCampaigns(r.items)); }
  };
  useEffect(() => { api.link(slug).then((x) => { setL(x); loadMember(x); }).catch(() => setNotFound(true)); }, [slug]);
  useEffect(() => { if (settings.analyticsConfigured) api.linkStats(slug, range).then(setStats).catch(() => setStats(null)); }, [slug, range]);
  if (notFound) return <p>No link <code>/{slug}</code>. <RLink to={to('/')}>Back to links</RLink></p>;
  if (!l) return <p className="muted">Loading…</p>;
  const save = async (skip = false) => {
    try {
      if (campaign && own) {
        await api.patchMember(campaign.id, slug, own);
        setL(await api.patch(slug, { title: draft.title || null }));
      } else setL(await api.patch(slug, { destination: draft.destination, title: draft.title || null, ...(skip ? { screening: 'skip' as const } : {}) }));
      setEditing(false); setE(null);
    } catch (x) { setE(x as ApiError); }
  };
  const detach = async () => {
    if (!confirm(`Detach /${slug} from "${campaign?.name}"? It becomes a plain link; its destination and click history stay as they are.`)) return;
    const x = await api.detach(slug); setL(x); loadMember(x);
  };
  const adopt = async (id: string) => {
    try { await api.adopt(id, slug); const x = await api.link(slug); setL(x); loadMember(x); setAdoptMsg(null); }
    catch (x) { setAdoptMsg((x as ApiError).message); }
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
            {campaign && own ? <>
              <CampaignFields campaign={campaign} own={own} onChange={setOwn} errors={e} />
              {l.clickCount > 0 && <div className="u-warn">This link already has {l.clickCount.toLocaleString()} clicks. Clicks are recorded per slug, so past clicks will be listed under the new values.</div>}
            </> : <>
              <label>Destination<input value={draft.destination} onChange={(ev) => setDraft({ ...draft, destination: ev.target.value })} /></label>
              <FieldErr e={e} f="destination" />
              <PlainBuilder destination={draft.destination} onChange={(d) => setDraft({ ...draft, destination: d })} />
            </>}
            <label>Title<input value={draft.title} onChange={(ev) => setDraft({ ...draft, title: ev.target.value })} /></label>
            <FieldErr e={e} f="title" />
            <FlaggedNotice e={e} action="Save anyway" onOverride={() => save(true)} />
            <div className="s-row"><button className="primary" onClick={() => save()}>Save</button><button className="ghost" onClick={() => { setEditing(false); setE(null); loadMember(l); }}>Cancel</button></div>
          </>
        ) : (
          <>
            <dl className="s-dl">
              <dt>Destination</dt><dd><Preview url={l.destination} /></dd>
              {campaign && own && <>
                <dt>Campaign</dt><dd><CampaignBadge c={campaign} /> <span className="muted">{own.source} / {own.medium}{own.content ? ` · ${own.content}` : ''}{own.term ? ` · ${own.term}` : ''}</span></dd>
              </>}
              <dt>Title</dt><dd>{l.title ?? <span className="muted">—</span>}</dd>
              <dt>Created</dt><dd>{new Date(l.createdAt).toLocaleString()}</dd>
            </dl>
            <div className="s-row">
              <button onClick={() => { setDraft({ destination: l.destination, title: l.title ?? '' }); setE(null); setEditing(true); }}>Edit</button>
              <button onClick={async () => setL(await api.patch(slug, { enabled: !l.enabled }))}>{l.enabled ? 'Disable' : 'Enable'}</button>
              <button className="danger" onClick={async () => { if (confirm(`Delete /${l.slug}?`)) { await api.remove(slug); navigate(to('/')); } }}>Delete</button>
              {campaign && <button className="ghost" onClick={detach}>Detach from campaign</button>}
              {!campaign && campaigns.length > 0 && (
                <select value="" onChange={(ev) => ev.target.value && adopt(ev.target.value)} style={{ marginLeft: 'auto' }}>
                  <option value="">Add to campaign…</option>
                  {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
            </div>
            {adoptMsg && <div className="error">{adoptMsg}</div>}
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
