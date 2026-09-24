// PROTOTYPE (ticket #33) — ADR 0014 parse/compose, shared by the builder (browser) and the mock (server), the way
// packages/shared will share it between apps/admin and apps/worker. Keeps every non-UTM byte as entered.
export const UTM_KEYS = ['utm_id', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export type Utm = Partial<Record<UtmKey, string>>;
export const LABEL: Record<UtmKey, string> = {
  utm_id: 'Campaign ID', utm_source: 'Source', utm_medium: 'Medium', utm_campaign: 'Campaign', utm_term: 'Term', utm_content: 'Content',
};

function split(url: string) {
  const h = url.indexOf('#');
  const beforeHash = h < 0 ? url : url.slice(0, h);
  const hash = h < 0 ? '' : url.slice(h);
  const q = beforeHash.indexOf('?');
  return { base: q < 0 ? beforeHash : beforeHash.slice(0, q), query: q < 0 ? null : beforeHash.slice(q + 1), hash };
}
const isUtm = (k: string): k is UtmKey => (UTM_KEYS as readonly string[]).includes(k);

export function parse(url: string): { utm: Utm; warnings: string[] } {
  const { query } = split(url);
  const utm: Utm = {}; const warnings: string[] = [];
  if (!query) return { utm, warnings };
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const k = i < 0 ? pair : pair.slice(0, i);
    const raw = i < 0 ? '' : pair.slice(i + 1);
    if (!isUtm(k)) {
      if (isUtm(k.toLowerCase())) warnings.push(`"${k}" is not lowercase, so analytics tools will likely ignore it. furea keeps it as ordinary query.`);
      continue;
    }
    let v: string;
    try { v = decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { v = raw; warnings.push(`${k} has a malformed % sequence; shown raw.`); }
    if (k in utm) { warnings.push(`${k} appears more than once; the first value is used and saving collapses it to one.`); continue; }
    utm[k] = v;
  }
  return { utm, warnings };
}

export function compose(url: string, utm: Utm): string {
  const { base, query, hash } = split(url);
  const kept = (query ?? '').split('&').filter((p) => p && !isUtm(p.slice(0, p.indexOf('=') < 0 ? p.length : p.indexOf('='))));
  const added = UTM_KEYS.map((k) => [k, (utm[k] ?? '').trim()] as const).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  const all = [...kept, ...added];
  return `${base}${all.length ? `?${all.join('&')}` : ''}${hash}`;
}

// the part compose keeps: used by adopt matching and to show a campaign link's base
export const stripUtm = (url: string) => compose(url, {});
export const hasUtm = (url: string) => Object.keys(parse(url).utm).length > 0;
