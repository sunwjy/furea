// PROTOTYPE (ticket #33) — campaign screens. Three variants on top of the #20 shell (F: Links · Security · Settings)
// disagree on where campaigns live, how links are created in bulk, and how a campaign is compared:
//   G — "Campaigns" nav item → list → detail page with a links table; bulk creation on its own page as a row editor
//       (add rows or paste from a spreadsheet). /admin/new stays plain-only. Feed shows a campaign badge.
//   H — no nav item: a campaign is one grouped card inside the Links feed; /admin/new has a "Campaign links" tab with
//       a source × medium matrix generator (tick the combinations). Detail page reached from the group card.
//   I — "Campaigns" nav item; the detail page IS a source × medium pivot: each cell holds its link(s) with clicks,
//       empty cells can be ticked to create links. /admin/new has a Campaign picker for single links. Feed filter.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link as RLink, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, copy, RANGES, type BulkItem, type Campaign, type CampaignStats, type InstanceStats, type Link, type MemberLink, type Own, type Range } from './v1api';
import { Bars, Sparkline, TopList } from '../Chart';
import { useShell, useTo } from './Shell';
import { FlaggedNotice, Preview } from './Builder';
import { compose } from './utm';

const composeFor = (c: Pick<Campaign, 'baseUrl' | 'utmCampaign' | 'utmId'>, o: Own) =>
  compose(c.baseUrl, { utm_id: c.utmId ?? '', utm_source: o.source, utm_medium: o.medium, utm_campaign: c.utmCampaign, utm_term: o.term ?? '', utm_content: o.content ?? '' });
const ownLabel = (o: Own) => `${o.source} / ${o.medium}${o.content ? ` · ${o.content}` : ''}${o.term ? ` · ${o.term}` : ''}`;
const comboKey = (o: Own) => [o.source, o.medium, o.content ?? '', o.term ?? ''].map((x) => x.trim().toLowerCase()).join('|');

// ---------------------------------------------------------------- list (G, I)
export function CampaignList() {
  const to = useTo();
  const { settings } = useShell();
  const [items, setItems] = useState<Campaign[] | null>(null);
  useEffect(() => { api.campaigns().then((r) => setItems(r.items)); }, []);
  return (
    <>
      <div className="s-feed-head">
        <h1 style={{ flex: 1, fontSize: 20, margin: 0 }}>Campaigns</h1>
        <RLink to={to('/campaigns/new')}><button className="primary">New campaign</button></RLink>
      </div>
      <table className="s-table" style={{ marginTop: 12, background: 'var(--panel)' }}>
        <thead><tr><th>Name</th><th>utm_campaign</th><th>Base URL</th><th style={{ textAlign: 'right' }}>Links</th><th style={{ textAlign: 'right' }}>Lifetime clicks</th></tr></thead>
        <tbody>
          {items?.map((c) => (
            <tr key={c.id}>
              <td><RLink to={to(`/campaigns/${c.id}`)}><b>{c.name}</b></RLink>{c.syncPendingCount > 0 && <> <span className="badge sync">{c.syncPendingCount} sync pending</span></>}</td>
              <td><code>{c.utmCampaign}</code>{c.utmId && <span className="muted"> · id {c.utmId}</span>}</td>
              <td className="u-trunc">{c.baseUrl}</td>
              <td style={{ textAlign: 'right' }}>{c.linkCount}{c.enabledCount < c.linkCount && <span className="muted"> ({c.linkCount - c.enabledCount} off)</span>}</td>
              <td style={{ textAlign: 'right' }}>{c.clickCount.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {items?.length === 0 && <p className="muted">No campaigns yet.</p>}
      {!settings.analyticsConfigured && <p className="muted s-small">Lifetime totals are exact sums of the links' counts.</p>}
    </>
  );
}

// ---------------------------------------------------------------- create (all)
export function NewCampaign() {
  const navigate = useNavigate();
  const to = useTo();
  const { variant } = useShell();
  const [f, setF] = useState({ name: '', utmCampaign: '', utmId: '', baseUrl: '' });
  const [touchedUtm, setTouchedUtm] = useState(false);
  const [e, setE] = useState<ApiError | null>(null);
  const [others, setOthers] = useState<Campaign[]>([]);
  useEffect(() => { api.campaigns().then((r) => setOthers(r.items)); }, []);
  const utmCampaign = touchedUtm ? f.utmCampaign : f.name.trim().toLowerCase().replace(/\s+/g, '_');
  const dupUtm = others.find((o) => o.utmCampaign === utmCampaign.trim() && utmCampaign.trim());
  const submit = async (ev?: React.FormEvent, skip = false) => {
    ev?.preventDefault();
    try {
      const c = await api.createCampaign({ name: f.name, utmCampaign, ...(f.utmId ? { utmId: f.utmId } : {}), baseUrl: f.baseUrl, ...(skip ? { screening: 'skip' as const } : {}) });
      navigate(to(variant === 'G' ? `/campaigns/${c.id}/add` : `/campaigns/${c.id}`));
    } catch (x) { setE(x as ApiError); }
  };
  return (
    <form className="s-page" onSubmit={submit}>
      <p><RLink to={to(variant === 'H' ? '/' : '/campaigns')}>← {variant === 'H' ? 'Links' : 'Campaigns'}</RLink></p>
      <h1>New campaign</h1>
      <label>Name<input autoFocus value={f.name} onChange={(ev) => setF({ ...f, name: ev.target.value })} placeholder="Spring sale 2026" /></label>
      {e?.field('name') && <div className="s-field-err">{e.field('name')}</div>}
      <label>Base URL <span className="muted">(where every link lands; no utm_* here)</span><input value={f.baseUrl} onChange={(ev) => setF({ ...f, baseUrl: ev.target.value })} placeholder="https://shop.example.com/spring" /></label>
      {e?.field('baseUrl') && <div className="s-field-err">{e.field('baseUrl')}</div>}
      <div className="u-grid">
        <label>UTM campaign <code className="muted">utm_campaign</code><input name="utm_campaign" value={utmCampaign} onChange={(ev) => { setTouchedUtm(true); setF({ ...f, utmCampaign: ev.target.value }); }} /></label>
        <label>Campaign ID <span className="muted">(optional)</span> <code className="muted">utm_id</code><input name="utm_id" value={f.utmId} onChange={(ev) => setF({ ...f, utmId: ev.target.value })} /></label>
      </div>
      {!touchedUtm && f.name && <p className="muted s-small">UTM campaign follows the name until you edit it.</p>}
      {dupUtm && <div className="u-warn">"{dupUtm.name}" already uses utm_campaign <code>{dupUtm.utmCampaign}</code>; the destination site will count both campaigns together.</div>}
      <FlaggedNotice e={e} action="Create anyway" onOverride={() => submit(undefined, true)} />
      <div className="s-row"><button className="primary">{variant === 'G' ? 'Create and add links' : 'Create campaign'}</button></div>
    </form>
  );
}

// ---------------------------------------------------------------- detail (all), body differs per variant
type Full = Campaign & { links: MemberLink[] };
export function CampaignPage() {
  const { id = '' } = useParams();
  const { variant, settings } = useShell();
  const to = useTo();
  const [c, setC] = useState<Full | null>(null);
  const [missing, setMissing] = useState(false);
  const [range, setRange] = useState<Range>('30d');
  const [stats, setStats] = useState<CampaignStats | null>(null);
  const reload = () => api.campaign(id).then(setC).catch(() => setMissing(true));
  useEffect(() => { reload(); }, [id]);
  useEffect(() => { if (settings.analyticsConfigured) api.campaignStats(id, range).then(setStats).catch(() => setStats(null)); }, [id, range, c?.linkCount, c?.updatedAt]);
  if (missing) return <p>No such campaign. <RLink to={to(variant === 'H' ? '/' : '/campaigns')}>Back</RLink></p>;
  if (!c) return <p className="muted">Loading…</p>;
  const inRange = stats?.series.reduce((a, s) => a + s.clicks, 0) ?? 0;
  return (
    <div>
      <p><RLink to={to(variant === 'H' ? '/' : '/campaigns')}>← {variant === 'H' ? 'Links' : 'Campaigns'}</RLink></p>
      <CampaignHeader c={c} onChange={reload} />
      <div className="tiles" style={{ marginTop: 16 }}>
        <div className="tile"><small>Lifetime clicks</small><b>{c.clickCount.toLocaleString()}</b><span className="est">exact · sum of {c.linkCount} links</span></div>
        {settings.analyticsConfigured && <div className="tile"><small>Last {range}</small><b>{inRange.toLocaleString()}</b><span className="est">estimated</span></div>}
        <div className="tile"><small>Links</small><b>{c.linkCount}<span className="muted" style={{ fontSize: 14 }}> / {c.cap}</span></b><span className="est">{c.enabledCount} enabled</span></div>
        {settings.analyticsConfigured && stats?.bySource[0] && <div className="tile"><small>Top source</small><b style={{ fontSize: 18 }}>{stats.bySource[0].key}</b><span className="est">{Math.round((stats.bySource[0].clicks / Math.max(1, inRange)) * 100)}% of {range}</span></div>}
      </div>
      {settings.analyticsConfigured && (
        <div style={{ margin: '16px 0 8px' }} className="tabs">{RANGES.map((r) => <button key={r} className={r === range ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>)}</div>
      )}
      {variant === 'G' && <TableBody c={c} stats={stats} onChange={reload} />}
      {variant === 'H' && <FeedBody c={c} stats={stats} onChange={reload} />}
      {variant === 'I' && <PivotBody c={c} stats={stats} onChange={reload} />}
      {settings.analyticsConfigured && stats && (
        <>
          <h3 className="u-h3">All links combined</h3>
          <Bars series={stats.series.map((s) => ({ t: s.start, clicks: s.clicks }))} height={90} />
          <div className="cols3" style={{ marginTop: 16 }}>
            <TopList title="Countries" rows={stats.countries.map((r) => ({ key: r.country, clicks: r.clicks }))} total={inRange} />
            <TopList title="Referrer hosts" rows={stats.referrerHosts.map((r) => ({ key: r.host, clicks: r.clicks }))} total={inRange} />
            <TopList title="Device classes" rows={stats.deviceClasses.map((r) => ({ key: r.deviceClass, clicks: r.clicks }))} total={inRange} />
          </div>
          <p className="est">Breakdowns are estimates over the last 90 days, in {stats.tz}; each link counts from its own creation.</p>
        </>
      )}
      {!settings.analyticsConfigured && <div className="s-hint" style={{ marginTop: 16 }}><b>Click breakdowns are off.</b> Lifetime totals per link and for the campaign are still exact. Add a read-only analytics token with <code>npx furea analytics-token</code> to compare sources over time.</div>}
    </div>
  );
}

function CampaignHeader({ c, onChange }: { c: Full; onChange: () => void }) {
  const navigate = useNavigate();
  const to = useTo();
  const { variant } = useShell();
  const [editing, setEditing] = useState(false);
  const [d, setD] = useState({ name: '', utmCampaign: '', utmId: '', baseUrl: '' });
  const [e, setE] = useState<ApiError | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const rewrite = d.baseUrl !== c.baseUrl || d.utmCampaign !== c.utmCampaign || (d.utmId || null) !== c.utmId;
  const save = async (skip = false) => {
    try {
      const r = await api.patchCampaign(c.id, { name: d.name, utmCampaign: d.utmCampaign, utmId: d.utmId || null, baseUrl: d.baseUrl, ...(skip ? { screening: 'skip' as const } : {}) });
      setEditing(false); setConfirming(false); setE(null);
      setDone(r.rewritten ? `Rewrote ${r.rewritten} link destination${r.rewritten > 1 ? 's' : ''}.` : null);
      onChange();
    } catch (x) { setE(x as ApiError); setConfirming(false); }
  };
  const sample = c.links[0];
  return (
    <>
      <div className="s-link-head">
        <h1>{c.name}</h1>
        {c.syncPendingCount > 0 && <span className="badge sync">{c.syncPendingCount} sync pending</span>}
      </div>
      <div className="s-panel" style={{ marginTop: 10 }}>
        {editing ? (
          <>
            <label>Name<input value={d.name} onChange={(ev) => setD({ ...d, name: ev.target.value })} /></label>
            {e?.field('name') && <div className="s-field-err">{e.field('name')}</div>}
            <label>Base URL<input value={d.baseUrl} onChange={(ev) => setD({ ...d, baseUrl: ev.target.value })} /></label>
            {e?.field('baseUrl') && <div className="s-field-err">{e.field('baseUrl')}</div>}
            <div className="u-grid">
              <label>UTM campaign <code className="muted">utm_campaign</code><input name="utm_campaign" value={d.utmCampaign} onChange={(ev) => setD({ ...d, utmCampaign: ev.target.value })} /></label>
              <label>Campaign ID <code className="muted">utm_id</code><input name="utm_id" value={d.utmId} onChange={(ev) => setD({ ...d, utmId: ev.target.value })} /></label>
            </div>
            {e && e.code === 'validation_failed' && e.details.some((x) => x.field.startsWith('links.')) && <div className="error">Refused as a whole: {e.details.map((x) => x.message).join(' ')}</div>}
            {rewrite && sample && <>
              <label>Example: /{sample.slug} after saving</label>
              <Preview url={composeFor({ baseUrl: d.baseUrl, utmCampaign: d.utmCampaign, utmId: d.utmId || null }, sample.utm)} />
            </>}
            <FlaggedNotice e={e} action="Save anyway" onOverride={() => save(true)} />
            {confirming ? (
              <div className="u-flag" style={{ background: '#fffaeb', borderColor: '#fedf89', color: '#7a2e0e' }}>
                This rewrites the destination of <b>all {c.linkCount} links</b> in the campaign{c.linkCount - c.enabledCount ? `, ${c.linkCount - c.enabledCount} disabled included` : ''}.
                {d.utmCampaign !== c.utmCampaign && <> The destination site's analytics will see a <b>new campaign</b> (<code>{d.utmCampaign}</code>) from now on.</>}
                <div className="s-row"><button className="primary" onClick={() => save()}>Rewrite {c.linkCount} links</button><button className="ghost" onClick={() => setConfirming(false)}>Back</button></div>
              </div>
            ) : (
              <div className="s-row">
                <button className="primary" onClick={() => (rewrite && c.linkCount ? setConfirming(true) : save())}>Save</button>
                <button className="ghost" onClick={() => { setEditing(false); setE(null); }}>Cancel</button>
                {rewrite && c.linkCount > 0 && <span className="muted s-small">{c.linkCount} links will be rewritten</span>}
              </div>
            )}
          </>
        ) : (
          <>
            <dl className="s-dl">
              <dt>Base URL</dt><dd>{c.baseUrl}</dd>
              <dt>utm_campaign</dt><dd><code>{c.utmCampaign}</code></dd>
              <dt>utm_id</dt><dd>{c.utmId ? <code>{c.utmId}</code> : <span className="muted">—</span>}</dd>
            </dl>
            {done && <div className="s-ok">{done} Changes reach every short URL within a few minutes.</div>}
            <div className="s-row">
              <button onClick={() => { setD({ name: c.name, utmCampaign: c.utmCampaign, utmId: c.utmId ?? '', baseUrl: c.baseUrl }); setEditing(true); setDone(null); }}>Edit</button>
              {variant === 'G' && <RLink to={to(`/campaigns/${c.id}/add`)}><button className="primary" disabled={c.linkCount >= c.cap}>Add links</button></RLink>}
              <button onClick={async () => { await api.setCampaignEnabled(c.id, true); onChange(); }} disabled={c.enabledCount === c.linkCount}>Enable all</button>
              <button onClick={async () => { if (confirm(`Disable all ${c.linkCount} links? Each short URL will answer 404 until enabled again.`)) { await api.setCampaignEnabled(c.id, false); onChange(); } }} disabled={c.enabledCount === 0}>Disable all</button>
              <button className="danger" style={{ marginLeft: 'auto' }} onClick={async () => { if (confirm(`Delete the campaign "${c.name}"? Its ${c.linkCount} links stay (as plain links, same destinations); nothing is disabled or deleted.`)) { await api.deleteCampaign(c.id); navigate(to(variant === 'H' ? '/' : '/campaigns')); } }}>Delete campaign</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

const clicksOf = (stats: CampaignStats | null, slug: string) => stats?.perLink.find((p) => p.slug === slug);

// ---- G: a links table with a comparison bar per row, grouping toggle
function TableBody({ c, stats }: { c: Full; stats: CampaignStats | null; onChange: () => void }) {
  const to = useTo();
  const [by, setBy] = useState<'link' | 'source' | 'medium'>('link');
  const max = Math.max(1, ...(stats?.perLink.map((p) => p.clicks) ?? [1]));
  const total = stats?.perLink.reduce((a, p) => a + p.clicks, 0) ?? 0;
  return (
    <>
      <div className="s-row" style={{ justifyContent: 'space-between' }}>
        <h3 className="u-h3" style={{ margin: 0 }}>Links</h3>
        {stats && <div className="tabs">{(['link', 'source', 'medium'] as const).map((k) => <button key={k} className={by === k ? 'on' : ''} onClick={() => setBy(k)}>by {k}</button>)}</div>}
      </div>
      {by === 'link' || !stats ? (
        <table className="s-table" style={{ background: 'var(--panel)', marginTop: 8 }}>
          <thead><tr><th>Short URL</th><th>Source</th><th>Medium</th><th>Content</th><th>Term</th><th style={{ textAlign: 'right' }}>Lifetime</th>{stats && <th style={{ width: 180 }}>{stats.range}</th>}<th /></tr></thead>
          <tbody>
            {c.links.map((l) => {
              const p = clicksOf(stats, l.slug);
              return (
                <tr key={l.slug} className={l.enabled ? '' : 'u-off'}>
                  <td><RLink to={to(`/links/${l.slug}`)}><code>/{l.slug}</code></RLink>{!l.enabled && <> <span className="badge off">Disabled</span></>}{!l.cacheSynced && <> <span className="badge sync">Sync</span></>}</td>
                  <td>{l.utm.source}</td><td>{l.utm.medium}</td><td>{l.utm.content ?? <span className="muted">—</span>}</td><td>{l.utm.term ?? <span className="muted">—</span>}</td>
                  <td style={{ textAlign: 'right' }}>{l.clickCount.toLocaleString()}</td>
                  {stats && <td><span className="u-bar"><i style={{ width: `${((p?.clicks ?? 0) / max) * 100}%` }} /></span> <span className="s-small">{p?.clicks ?? 0}</span></td>}
                  <td><button onClick={() => copy(l.shortUrl)}>Copy</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div style={{ marginTop: 8 }}><TopList title={`Clicks by ${by}, ${stats.range}`} rows={by === 'source' ? stats.bySource : stats.byMedium} total={total} /></div>
      )}
      {c.links.length === 0 && <p className="muted">No links yet. <RLink to={to(`/campaigns/${c.id}/add`)}>Add links</RLink></p>}
      <CopyAll c={c} />
    </>
  );
}

function CopyAll({ c }: { c: Full }) {
  const [ok, setOk] = useState(false);
  if (!c.links.length) return null;
  const tsv = c.links.map((l) => [l.utm.source, l.utm.medium, l.utm.content ?? '', l.utm.term ?? '', l.shortUrl].join('\t')).join('\n');
  return <p className="s-small"><button onClick={() => { copy(`source\tmedium\tcontent\tterm\tshort URL\n${tsv}`); setOk(true); }}>Copy all as a table</button> {ok && <span className="s-ok">Copied, paste into a spreadsheet.</span>}</p>;
}

// ---- G: bulk creation as a row editor on its own page
export function AddLinks() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const to = useTo();
  const [c, setC] = useState<Full | null>(null);
  const empty = (): BulkItem => ({ source: '', medium: '', content: '', term: '', slug: '' });
  const [rows, setRows] = useState<BulkItem[]>([empty(), empty(), empty()]);
  const [paste, setPaste] = useState<string | null>(null);
  const [e, setE] = useState<ApiError | null>(null);
  useEffect(() => { api.campaign(id).then(setC); }, [id]);
  if (!c) return <p className="muted">Loading…</p>;
  const filled = rows.filter((r) => r.source.trim() || r.medium.trim() || r.content?.trim() || r.term?.trim() || r.slug?.trim());
  const setRow = (i: number, k: keyof BulkItem) => (ev: React.ChangeEvent<HTMLInputElement>) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: ev.target.value } : r)));
  const existing = new Map(c.links.map((l) => [comboKey(l.utm), l.slug]));
  const submit = async (skip = false) => {
    try {
      const items = filled.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v?.trim())) as BulkItem);
      await api.bulkCreate(c.id, items, skip);
      navigate(to(`/campaigns/${c.id}`));
    } catch (x) { setE(x as ApiError); }
  };
  // map error index (over filled rows) back to the visible row index
  const errFor = (i: number, k: string) => { const fi = filled.indexOf(rows[i]); return fi < 0 ? undefined : e?.field(`items[${fi}].${k}`); };
  const importPaste = () => {
    const parsed = (paste ?? '').split('\n').map((line) => line.split('\t')).filter((cols) => cols.some((x) => x.trim()))
      .filter((cols) => !/^source$/i.test(cols[0]?.trim() ?? ''))
      .map(([source = '', medium = '', content = '', term = '', slug = '']) => ({ source, medium, content, term, slug }));
    setRows([...rows.filter((r) => filled.includes(r)), ...parsed, empty()]); setPaste(null);
  };
  return (
    <div className="s-page" style={{ maxWidth: 1000 }}>
      <p><RLink to={to(`/campaigns/${c.id}`)}>← {c.name}</RLink></p>
      <h1>Add links to {c.name}</h1>
      <p className="muted s-small">Each row becomes one short link to <code>{c.baseUrl}</code> with <code>utm_campaign={c.utmCampaign}</code>{c.utmId && <> and <code>utm_id={c.utmId}</code></>}. Source and medium are required. All rows are created together, or none. {c.linkCount}/{c.cap} used.</p>
      <table className="s-table u-rows">
        <thead><tr><th>#</th><th>Source *</th><th>Medium *</th><th>Content</th><th>Term</th><th>Custom slug</th><th>Destination</th><th /></tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const dup = r.source.trim() && r.medium.trim() && existing.get(comboKey(r));
            const rowErr = ['source', 'medium', 'content', 'term', 'slug'].map((k) => errFor(i, k)).filter(Boolean);
            return (
              <Fragment key={i}>
                <tr className={rowErr.length ? 'u-rowerr' : ''}>
                  <td className="muted">{i + 1}</td>
                  {(['source', 'medium', 'content', 'term', 'slug'] as const).map((k) => (
                    <td key={k}><input name={k === 'slug' ? undefined : `utm_${k}`} autoComplete="on" value={r[k] ?? ''} onChange={setRow(i, k)} placeholder={k === 'slug' ? 'generated' : ''} /></td>
                  ))}
                  <td className="u-trunc s-small muted" title={r.source && r.medium ? composeFor(c, r) : ''}>{r.source && r.medium ? composeFor(c, r).replace(/^https?:\/\//, '') : '—'}</td>
                  <td><button className="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="remove row">×</button></td>
                </tr>
                {(rowErr.length > 0 || dup) && <tr><td /><td colSpan={7} className="s-field-err">{rowErr.join(' ')}{dup && !rowErr.length && `Already in the campaign as /${dup} (compared ignoring case).`}</td></tr>}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <div className="s-row">
        <button onClick={() => setRows([...rows, empty()])}>+ Row</button>
        <button onClick={() => setPaste('')}>Paste from spreadsheet…</button>
      </div>
      {paste !== null && (
        <div className="s-panel" style={{ marginTop: 10 }}>
          <label>Paste rows: source, medium, content, term, slug separated by tabs (copied spreadsheet cells)</label>
          <textarea rows={6} style={{ width: '100%', font: '13px ui-monospace, monospace' }} value={paste} onChange={(ev) => setPaste(ev.target.value)} placeholder={'newsletter\temail\ninstagram\tsocial\tstory\ninstagram\tsocial\tpost'} />
          <div className="s-row"><button className="primary" onClick={importPaste}>Add rows</button><button className="ghost" onClick={() => setPaste(null)}>Cancel</button></div>
        </div>
      )}
      {e?.field('items') && <div className="error">{e.field('items')}</div>}
      {e?.code === 'validation_failed' && !e.field('items') && <div className="error">Nothing was created: fix the {new Set(e.details.map((d) => d.field.match(/\[(\d+)\]/)?.[1])).size} marked row(s).</div>}
      <FlaggedNotice e={e} action={`Create ${filled.length} anyway`} onOverride={() => submit(true)} />
      <div className="s-row"><button className="primary" disabled={!filled.length} onClick={() => submit()}>Create {filled.length} link{filled.length === 1 ? '' : 's'}</button><RLink to={to(`/campaigns/${c.id}`)}>Cancel</RLink></div>
    </div>
  );
}

// ---- H: campaign as one card in the Links feed
export function CampaignGroupCard({ campaign, links, stats }: { campaign?: Campaign; links: Link[]; stats: InstanceStats | null; onChange: () => void }) {
  const to = useTo();
  const [open, setOpen] = useState(false);
  if (!campaign) return null;
  const series = stats && links[0] && stats.seriesBySlug[links[0].slug]
    ? stats.seriesBySlug[links[0].slug].map((_, i) => ({ clicks: links.reduce((a, l) => a + (stats.seriesBySlug[l.slug]?.[i]?.clicks ?? 0), 0) })) : null;
  return (
    <div className="c-card u-group">
      <div>
        <div className="short">
          <RLink to={to(`/campaigns/${campaign.id}`)} style={{ textDecoration: 'none', color: 'inherit' }}>⚑ {campaign.name}</RLink>
          {' '}<span className="badge">{campaign.linkCount} links</span>
          {campaign.enabledCount < campaign.linkCount && <span className="badge off">{campaign.linkCount - campaign.enabledCount} disabled</span>}
          {campaign.syncPendingCount > 0 && <span className="badge sync">{campaign.syncPendingCount} sync pending</span>}
        </div>
        <div className="dest">{campaign.baseUrl} · <code>{campaign.utmCampaign}</code></div>
        {open && (
          <table className="s-table" style={{ margin: '8px 0' }}>
            <tbody>{links.map((l) => (
              <tr key={l.slug} className={l.enabled ? '' : 'u-off'}>
                <td><RLink to={to(`/links/${l.slug}`)}><code>/{l.slug}</code></RLink></td>
                <td className="muted">{ownOf(l.destination)}</td>
                <td style={{ textAlign: 'right' }}>{l.clickCount.toLocaleString()}</td>
                <td style={{ width: 70 }}><button onClick={() => copy(l.shortUrl)}>Copy</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
        <div className="acts">
          <button onClick={() => setOpen(!open)}>{open ? 'Hide links' : `Show ${links.length} links`}</button>
          <RLink to={to(`/campaigns/${campaign.id}`)}><button>Open campaign</button></RLink>
        </div>
      </div>
      <div className="side">
        <b>{campaign.clickCount.toLocaleString()}</b>
        <span className="est">lifetime, all links{series ? ' · 7 d ↓' : ''}</span>
        {series && <Sparkline series={series} />}
      </div>
    </div>
  );
}
function ownOf(dest: string) {
  const q = new URLSearchParams(dest.split('#')[0].split('?')[1] ?? '');
  return ownLabel({ source: q.get('utm_source') ?? '', medium: q.get('utm_medium') ?? '', content: q.get('utm_content') ?? undefined, term: q.get('utm_term') ?? undefined });
}

// ---- H: detail body = compact list + the matrix generator inline
function FeedBody({ c, stats, onChange }: { c: Full; stats: CampaignStats | null; onChange: () => void }) {
  const to = useTo();
  return (
    <>
      <h3 className="u-h3">Links</h3>
      {c.links.map((l) => {
        const p = clicksOf(stats, l.slug);
        return (
          <div key={l.slug} className={`u-line ${l.enabled ? '' : 'u-off'}`}>
            <RLink to={to(`/links/${l.slug}`)}><code>/{l.slug}</code></RLink>
            <span>{ownLabel(l.utm)}</span>
            {!l.enabled && <span className="badge off">Disabled</span>}
            <span style={{ marginLeft: 'auto' }} className="muted s-small">{l.clickCount.toLocaleString()} lifetime{p ? ` · ${p.clicks} in ${stats!.range}` : ''}</span>
            {p && <span style={{ width: 90 }}><Sparkline series={p.series} /></span>}
            <button onClick={() => copy(l.shortUrl)}>Copy</button>
          </div>
        );
      })}
      <h3 className="u-h3">Add links</h3>
      <MatrixGenerator campaigns={[c]} fixed={c} onCreated={onChange} />
    </>
  );
}

// ---- H: bulk creation as a source × medium matrix (tick the combinations you want)
export function MatrixGenerator({ campaigns, fixed, onCreated }: { campaigns: Campaign[]; fixed?: Full; onCreated?: () => void }) {
  const navigate = useNavigate();
  const to = useTo();
  const [cmpId, setCmpId] = useState(fixed?.id ?? '');
  const [full, setFull] = useState<Full | null>(fixed ?? null);
  const [sources, setSources] = useState<string[]>([]);
  const [mediums, setMediums] = useState<string[]>([]);
  const [src, setSrc] = useState(''); const [med, setMed] = useState('');
  const [content, setContent] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [e, setE] = useState<ApiError | null>(null);
  useEffect(() => { if (fixed) setFull(fixed); else if (cmpId) api.campaign(cmpId).then(setFull); else setFull(null); }, [cmpId, fixed]);
  const existing = useMemo(() => new Map((full?.links ?? []).map((l) => [comboKey(l.utm), l.slug])), [full]);
  const key = (s: string, m: string) => `${s}\u0000${m}`;
  const items: BulkItem[] = [...picked].map((k) => { const [source, medium] = k.split('\u0000'); return { source, medium, ...(content.trim() ? { content: content.trim() } : {}) }; });
  const add = (list: string[], set: (x: string[]) => void, v: string, clear: () => void) => { const t = v.trim(); if (t && !list.some((x) => x.toLowerCase() === t.toLowerCase())) set([...list, t]); clear(); };
  const submit = async (skip = false) => {
    if (!full) return;
    try {
      await api.bulkCreate(full.id, items, skip);
      setPicked(new Set()); setE(null);
      if (onCreated) { onCreated(); api.campaign(full.id).then(setFull); } else navigate(to(`/campaigns/${full.id}`));
    } catch (x) { setE(x as ApiError); }
  };
  return (
    <div className="s-panel">
      {!fixed && (
        <label>Campaign
          <select value={cmpId} onChange={(ev) => setCmpId(ev.target.value)} style={{ width: '100%' }}>
            <option value="">Choose a campaign…</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.linkCount}/{c.cap})</option>)}
          </select>
          <span className="s-small">or <RLink to={to('/campaigns/new')}>create a new campaign</RLink></span>
        </label>
      )}
      {full && <>
        <div className="u-grid">
          <label>Sources <span className="muted">(Enter to add)</span>
            <input name="utm_source" autoComplete="on" value={src} onChange={(ev) => setSrc(ev.target.value)} onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(sources, setSources, src, () => setSrc('')); } }} placeholder="newsletter" />
          </label>
          <label>Mediums <span className="muted">(Enter to add)</span>
            <input name="utm_medium" autoComplete="on" value={med} onChange={(ev) => setMed(ev.target.value)} onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(mediums, setMediums, med, () => setMed('')); } }} placeholder="email" />
          </label>
        </div>
        {sources.length > 0 && mediums.length > 0 ? (
          <table className="u-matrix">
            <thead><tr><th /> {mediums.map((m) => <th key={m}>{m} <button className="ghost" onClick={() => setMediums(mediums.filter((x) => x !== m))}>×</button></th>)}</tr></thead>
            <tbody>{sources.map((s) => (
              <tr key={s}><th>{s} <button className="ghost" onClick={() => setSources(sources.filter((x) => x !== s))}>×</button></th>
                {mediums.map((m) => {
                  const ex = existing.get(comboKey({ source: s, medium: m, content: content.trim() || undefined }));
                  const k = key(s, m);
                  return <td key={m}>{ex ? <span className="muted s-small">/{ex}</span> : <input type="checkbox" checked={picked.has(k)} onChange={() => { const p = new Set(picked); p.has(k) ? p.delete(k) : p.add(k); setPicked(p); }} />}</td>;
                })}
              </tr>
            ))}</tbody>
          </table>
        ) : <p className="muted s-small">Add at least one source and one medium; every ticked combination becomes a link.</p>}
        <label>Content for all ticked links <span className="muted">(optional)</span> <code className="muted">utm_content</code><input name="utm_content" autoComplete="on" value={content} onChange={(ev) => setContent(ev.target.value)} /></label>
        {e?.code === 'validation_failed' && <div className="error">Nothing was created. {e.details.map((d) => { const i = Number(d.field.match(/\[(\d+)\]/)?.[1]); return `${Number.isNaN(i) ? '' : `${ownLabel(items[i])}: `}${d.message}`; }).join(' ')}</div>}
        <FlaggedNotice e={e} action={`Create ${items.length} anyway`} onOverride={() => submit(true)} />
        <div className="s-row"><button className="primary" disabled={!items.length} onClick={() => submit()}>Create {items.length} link{items.length === 1 ? '' : 's'}</button><span className="muted s-small">{full.linkCount}/{full.cap} used · slugs are generated (no custom slugs here)</span></div>
      </>}
    </div>
  );
}

// ---- I: detail body = source × medium pivot with clicks per cell; tick empty cells to create
function PivotBody({ c, stats, onChange }: { c: Full; stats: CampaignStats | null; onChange: () => void }) {
  const to = useTo();
  const [extraS, setExtraS] = useState<string[]>([]);
  const [extraM, setExtraM] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<MemberLink | null>(null);
  const [e, setE] = useState<ApiError | null>(null);
  const uniq = (xs: string[]) => xs.filter((x, i) => xs.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);
  const sources = uniq([...c.links.map((l) => l.utm.source), ...extraS]);
  const mediums = uniq([...c.links.map((l) => l.utm.medium), ...extraM]);
  const cell = (s: string, m: string) => c.links.filter((l) => l.utm.source.toLowerCase() === s.toLowerCase() && l.utm.medium.toLowerCase() === m.toLowerCase());
  const max = Math.max(1, ...(stats?.perLink.map((p) => p.clicks) ?? [1]));
  const val = (l: MemberLink) => (stats ? clicksOf(stats, l.slug)?.clicks ?? 0 : l.clickCount);
  const maxV = stats ? max : Math.max(1, ...c.links.map((l) => l.clickCount));
  const rowTotal = (s: string) => c.links.filter((l) => l.utm.source.toLowerCase() === s.toLowerCase()).reduce((a, l) => a + val(l), 0);
  const colTotal = (m: string) => c.links.filter((l) => l.utm.medium.toLowerCase() === m.toLowerCase()).reduce((a, l) => a + val(l), 0);
  const items: BulkItem[] = [...picked].map((k) => { const [source, medium] = k.split('\u0000'); return { source, medium }; });
  const submit = async (skip = false) => {
    try { await api.bulkCreate(c.id, items, skip); setPicked(new Set()); setExtraS([]); setExtraM([]); setE(null); onChange(); }
    catch (x) { setE(x as ApiError); }
  };
  const addContent = async (s: string, m: string) => {
    const content = prompt(`New content variant for ${s} / ${m} (utm_content):`);
    if (!content?.trim()) return;
    try { await api.bulkCreate(c.id, [{ source: s, medium: m, content }]); onChange(); } catch (x) { alert((x as ApiError).details.map((d) => d.message).join(' ') || (x as ApiError).message); }
  };
  return (
    <div className="u-pivot-wrap">
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3 className="u-h3">Source × medium <span className="muted s-small">— {stats ? `clicks in ${stats.range} (estimated)` : 'lifetime clicks (exact)'}; tick empty cells to create links</span></h3>
        <table className="u-pivot">
          <thead><tr><th />{mediums.map((m) => <th key={m}>{m}</th>)}<th className="u-tot">Σ</th></tr></thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s}>
                <th>{s}</th>
                {mediums.map((m) => {
                  const ls = cell(s, m); const k = `${s}\u0000${m}`;
                  return (
                    <td key={m}>
                      {ls.map((l) => (
                        <button key={l.slug} className={`u-chip ${sel?.slug === l.slug ? 'on' : ''} ${l.enabled ? '' : 'u-off'}`} onClick={() => setSel(l)} style={{ background: `rgba(79,124,255,${0.08 + (val(l) / maxV) * 0.55})` }}>
                          <b>{val(l).toLocaleString()}</b> <code>/{l.slug}</code>{l.utm.content && <span className="muted"> · {l.utm.content}</span>}{l.utm.term && <span className="muted"> · {l.utm.term}</span>}
                        </button>
                      ))}
                      {ls.length === 0 ? <label className="u-empty"><input type="checkbox" checked={picked.has(k)} onChange={() => { const p = new Set(picked); p.has(k) ? p.delete(k) : p.add(k); setPicked(p); }} /> +</label>
                        : <button className="ghost u-addc" onClick={() => addContent(s, m)} title="Add another content variant">+ content</button>}
                    </td>
                  );
                })}
                <td className="u-tot">{rowTotal(s).toLocaleString()}</td>
              </tr>
            ))}
            <tr><th className="u-tot">Σ</th>{mediums.map((m) => <td key={m} className="u-tot">{colTotal(m).toLocaleString()}</td>)}<td /></tr>
          </tbody>
        </table>
        <div className="s-row">
          <input name="utm_source" autoComplete="on" placeholder="+ source (row)" onKeyDown={(ev) => { const t = (ev.target as HTMLInputElement); if (ev.key === 'Enter' && t.value.trim()) { setExtraS([...extraS, t.value.trim()]); t.value = ''; } }} />
          <input name="utm_medium" autoComplete="on" placeholder="+ medium (column)" onKeyDown={(ev) => { const t = (ev.target as HTMLInputElement); if (ev.key === 'Enter' && t.value.trim()) { setExtraM([...extraM, t.value.trim()]); t.value = ''; } }} />
          <button className="primary" disabled={!items.length} onClick={() => submit()}>Create {items.length} link{items.length === 1 ? '' : 's'}</button>
          <span className="muted s-small">{c.linkCount}/{c.cap} used</span>
        </div>
        {e?.code === 'validation_failed' && <div className="error">Nothing was created. {e.details.map((d) => d.message).join(' ')}</div>}
        <FlaggedNotice e={e} action={`Create ${items.length} anyway`} onOverride={() => submit(true)} />
        <CopyAll c={c} />
      </div>
      {sel && (
        <aside className="u-side">
          <button className="ghost" style={{ float: 'right' }} onClick={() => setSel(null)}>×</button>
          <h3 style={{ margin: '0 0 6px' }}><code>/{sel.slug}</code></h3>
          <p className="s-small">{ownLabel(sel.utm)}</p>
          <Preview url={sel.destination} />
          <p className="s-small">{sel.clickCount.toLocaleString()} lifetime clicks{stats && <> · {clicksOf(stats, sel.slug)?.clicks ?? 0} in {stats.range}</>}</p>
          {stats && clicksOf(stats, sel.slug) && <Sparkline series={clicksOf(stats, sel.slug)!.series} />}
          <div className="s-row"><button onClick={() => copy(sel.shortUrl)}>Copy</button><RLink to={to(`/links/${sel.slug}`)}><button>Open link</button></RLink></div>
        </aside>
      )}
    </div>
  );
}
