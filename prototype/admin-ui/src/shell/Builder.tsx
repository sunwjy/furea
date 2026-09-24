// PROTOTYPE (ticket #33) — the UTM builder exactly as ADR 0014 settled it, shared by every variant:
//   plain link  — collapsed "UTM parameters" section, auto-open when the destination has a lowercase utm_*; no field
//                 required; two-way sync; nothing re-composed until a field is touched; warnings.
//   campaign    — always open; campaign fields + destination read-only; source/medium required.
// Plus the ADR 0013 screening refusal with its session-only "… anyway" action.
import { useState } from 'react';
import { compose, LABEL, parse, stripUtm, type UtmKey } from './utm';
import type { ApiError, Campaign, Own } from './v1api';

const OWN_KEYS: UtmKey[] = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'];

// Shows the composed destination with its UTM tail highlighted, so the operator sees what the builder touched.
export function Preview({ url }: { url: string }) {
  const base = stripUtm(url);
  const { utm } = parse(url);
  if (!Object.keys(utm).length) return <div className="u-preview">{url || <span className="muted">—</span>}</div>;
  // compose puts the UTM pairs right before the #fragment
  const h = base.indexOf('#');
  const head = h < 0 ? base : base.slice(0, h);
  const tail = h < 0 ? '' : base.slice(h);
  const pairs = url.slice(head.length, url.length - tail.length);
  return <div className="u-preview">{head}<mark>{pairs}</mark>{tail}</div>;
}

export function PlainBuilder({ destination, onChange }: { destination: string; onChange: (d: string) => void }) {
  const { utm, warnings } = parse(destination);
  const auto = Object.keys(utm).length > 0;
  const [open, setOpen] = useState<boolean | null>(null); // null = follow the destination
  const isOpen = open ?? auto;
  const set = (k: UtmKey) => (e: React.ChangeEvent<HTMLInputElement>) => onChange(compose(destination, { ...utm, [k]: e.target.value }));
  const anyFilled = OWN_KEYS.some((k) => utm[k]?.trim());
  const missing = (['utm_source', 'utm_medium', 'utm_campaign'] as UtmKey[]).filter((k) => !utm[k]?.trim());
  return (
    <div className={`u-box ${isOpen ? 'open' : ''}`}>
      <button type="button" className="u-toggle" onClick={() => setOpen(!isOpen)}>
        {isOpen ? '▾' : '▸'} UTM parameters {!isOpen && auto && <span className="badge">{Object.keys(utm).length} set</span>}
      </button>
      {isOpen && (
        <>
          <div className="u-grid">
            {OWN_KEYS.map((k) => (
              <label key={k}>{LABEL[k]} <code className="muted">{k}</code>
                <input name={k} autoComplete="on" value={utm[k] ?? ''} onChange={set(k)} disabled={!/^https?:\/\//.test(destination)} />
              </label>
            ))}
          </div>
          {!/^https?:\/\//.test(destination) && <p className="muted s-small">Enter a destination first.</p>}
          {anyFilled && missing.length > 0 && <div className="u-warn">Most analytics tools need source, medium and campaign; {missing.map((k) => LABEL[k].toLowerCase()).join(' and ')} {missing.length > 1 ? 'are' : 'is'} empty.</div>}
          {warnings.map((w) => <div key={w} className="u-warn">{w}</div>)}
        </>
      )}
    </div>
  );
}

export function CampaignFields({ campaign, own, onChange, errors, prefix = '' }: {
  campaign: Pick<Campaign, 'name' | 'baseUrl' | 'utmCampaign' | 'utmId'>; own: Own; onChange: (o: Own) => void; errors?: ApiError | null; prefix?: string;
}) {
  const dest = compose(campaign.baseUrl, { utm_id: campaign.utmId ?? '', utm_source: own.source, utm_medium: own.medium, utm_campaign: campaign.utmCampaign, utm_term: own.term ?? '', utm_content: own.content ?? '' });
  const f = (k: keyof Own, key: UtmKey, req?: boolean) => (
    <label>{LABEL[key]}{req ? ' *' : ''} <code className="muted">{key}</code>
      <input name={key} autoComplete="on" value={own[k] ?? ''} onChange={(e) => onChange({ ...own, [k]: e.target.value })} />
      {errors?.field(`${prefix}${k}`) && <div className="s-field-err">{errors.field(`${prefix}${k}`)}</div>}
    </label>
  );
  return (
    <div className="u-box open">
      <div className="u-toggle" style={{ cursor: 'default' }}>UTM parameters · campaign <b>{campaign.name}</b></div>
      <div className="u-grid">
        <label>Campaign <code className="muted">utm_campaign</code><input value={campaign.utmCampaign} readOnly className="ro" /></label>
        <label>Campaign ID <code className="muted">utm_id</code><input value={campaign.utmId ?? ''} readOnly className="ro" placeholder="—" /></label>
        {f('source', 'utm_source', true)}
        {f('medium', 'utm_medium', true)}
        {f('content', 'utm_content')}
        {f('term', 'utm_term')}
      </div>
      <label>Destination <span className="muted">(composed from the campaign; read-only)</span></label>
      <Preview url={dest} />
    </div>
  );
}

// ADR 0013: 422 destination_flagged → show the flagged host(s) and a session-only override.
export function FlaggedNotice({ e, action, onOverride }: { e: ApiError | null; action: string; onOverride: () => void }) {
  if (e?.code !== 'destination_flagged') return null;
  return (
    <div className="u-flag">
      <b>Destination flagged.</b> 1.1.1.1 for Families lists {e.details.length > 1 ? 'these hosts' : 'this host'} as malware or phishing:
      <ul>{[...new Set(e.details.map((d) => d.message))].map((m) => <li key={m}>{m}</li>)}</ul>
      <span className="muted">Screening is domain-level and can be wrong. Overriding is logged; API keys cannot override.</span>
      <div className="s-row" style={{ marginTop: 8 }}><button type="button" className="danger" onClick={onOverride}>{action}</button></div>
    </div>
  );
}
