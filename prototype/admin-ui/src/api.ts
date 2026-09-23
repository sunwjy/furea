// Thin client for the mock API. Shapes are placeholders (public API surface is ticket #15).
export type Link = { slug: string; destination: string; title: string | null; disabled: boolean; syncPending: boolean; clickCount: number; createdAt: string };
export type Range = '24h' | '7d' | '30d' | '90d';
export const RANGES: Range[] = ['24h', '7d', '30d', '90d'];
export type Row = { key: string; clicks: number };
export type Breakdown = { range: Range; estimated: true; series: { t: string; clicks: number }[]; countries: Row[]; referrers: Row[]; devices: Row[] };
export type Overview = { today: number; last7d: number; last30d: number; top: { slug: string; title: string | null; clicks: number }[]; range: Range };

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { headers: { 'content-type': 'application/json' }, ...init });
  if (r.status === 204) return undefined as T;
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? r.statusText);
  return body;
}
export const api = {
  links: () => j<{ links: Link[] }>('/api/links').then((x) => x.links),
  link: (slug: string) => j<Link>(`/api/links/${slug}`),
  breakdown: (slug: string, range: Range) => j<Breakdown>(`/api/links/${slug}/breakdown?range=${range}`),
  overview: (range: Range = '7d') => j<Overview>(`/api/overview?range=${range}`),
  create: (input: { destination: string; slug?: string; title?: string }) => j<Link>('/api/links', { method: 'POST', body: JSON.stringify(input) }),
  update: (slug: string, patch: Partial<Pick<Link, 'destination' | 'title' | 'disabled'>>) => j<Link>(`/api/links/${slug}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (slug: string) => j<void>(`/api/links/${slug}`, { method: 'DELETE' }),
};
export const SHORT_HOST = 'https://s.example.com';
export const shortUrl = (slug: string) => `${SHORT_HOST}/${slug}`;
export const copy = (text: string) => navigator.clipboard?.writeText(text);
