// Client for the ADR 0009 mock under /api/v1. Types mirror the ADR, not the old placeholder API in ../api.ts.
export type Link = {
  slug: string; shortUrl: string; destination: string; title: string | null; enabled: boolean;
  clickCount: number; cacheSynced: boolean; createdAt: string; updatedAt: string;
  campaign: { id: string; name: string } | null; // ticket #33
};
// ---- ticket #33 (shapes guessed; ticket #32 decides the real API) ----
export type Own = { source: string; medium: string; content?: string; term?: string };
export type Campaign = {
  id: string; name: string; utmCampaign: string; utmId: string | null; baseUrl: string; createdAt: string; updatedAt: string;
  linkCount: number; enabledCount: number; clickCount: number; syncPendingCount: number; cap: number;
};
export type MemberLink = Link & { utm: Own };
export type CampaignStats = {
  range: Range; tz: string; series: Bucket[];
  perLink: (Own & { slug: string; clicks: number; series: Bucket[] })[];
  bySource: { key: string; clicks: number }[]; byMedium: { key: string; clicks: number }[];
  countries: { country: string; clicks: number }[]; referrerHosts: { host: string; clicks: number }[]; deviceClasses: { deviceClass: string; clicks: number }[];
};
export type BulkItem = Own & { slug?: string; title?: string };
type Skip = { screening?: 'skip' };
export type Range = '24h' | '7d' | '30d' | '90d';
export const RANGES: Range[] = ['24h', '7d', '30d', '90d'];
export type Bucket = { start: string; clicks: number };
export type LinkStats = {
  range: Range; tz: string; series: Bucket[];
  countries: { country: string; clicks: number }[];
  referrerHosts: { host: string; clicks: number }[];
  deviceClasses: { deviceClass: string; clicks: number }[];
};
export type InstanceStats = { today: number; last7d: number; last30d: number; topLinks: { slug: string; clicks: number }[]; seriesBySlug: Record<string, Bucket[]> };
export type Settings = { rootDestination: string | null; access: { teamDomain: string; aud: string } | null; analyticsConfigured: boolean; version: string };
export type Session = { kind: 'session' | 'access' | 'apiKey'; scope: 'read' | 'write'; apiKey: null };
export type ApiKey = { id: string; name: string; prefix: string; scope: 'read' | 'write'; createdAt: string; lastUsedAt: string | null };
export type FieldError = { field: string; code: string; message: string };

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details: FieldError[] = [], public retryAfter?: number) { super(message); }
  field(name: string) { return this.details.find((d) => d.field === name)?.message; }
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/v1${path}`, { ...init, headers: { 'content-type': 'application/json' } });
  if (r.status === 204) return undefined as T;
  const body = await r.json();
  if (!r.ok) {
    const e = body.error ?? {};
    const err = new ApiError(r.status, e.code, e.message, e.details, Number(r.headers.get('retry-after')) || undefined);
    // any 401 outside the login call sends the SPA back to the login page
    if (r.status === 401 && e.code === 'unauthorized') window.dispatchEvent(new CustomEvent('furea:unauthorized'));
    throw err;
  }
  return body;
}
const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  login: (password: string) => j<void>('/auth/login', send('POST', { password })),
  logout: () => j<void>('/auth/logout', send('POST')),
  session: () => j<Session>('/auth/session'),
  links: (q = '') => j<{ items: Link[]; nextCursor: string | null }>(`/links?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  link: (slug: string) => j<Link>(`/links/${slug}`),
  create: (b: { destination: string; slug?: string; title?: string } & Skip) => j<Link>('/links', send('POST', b)),
  patch: (slug: string, b: Partial<Pick<Link, 'destination' | 'title' | 'enabled'>> & Skip) => j<Link>(`/links/${slug}`, send('PATCH', b)),
  remove: (slug: string) => j<void>(`/links/${slug}`, send('DELETE')),
  linkStats: (slug: string, range: Range) => j<LinkStats>(`/links/${slug}/stats?range=${range}&tz=${TZ}`),
  stats: (range: Range = '7d') => j<InstanceStats>(`/stats?range=${range}&tz=${TZ}`),
  settings: () => j<Settings>('/settings'),
  patchSettings: (b: Partial<Pick<Settings, 'rootDestination' | 'access'>>) => j<Settings>('/settings', send('PATCH', b)),
  changePassword: (currentPassword: string, newPassword: string) => j<void>('/password', send('POST', { currentPassword, newPassword })),
  apiKeys: () => j<ApiKey[]>('/api-keys'),
  createKey: (name: string, scope: 'read' | 'write') => j<ApiKey & { key: string }>('/api-keys', send('POST', { name, scope })),
  revokeKey: (id: string) => j<void>(`/api-keys/${id}`, send('DELETE')),
  // ticket #33
  campaigns: () => j<{ items: Campaign[] }>('/campaigns'),
  campaign: (id: string) => j<Campaign & { links: MemberLink[] }>(`/campaigns/${id}`),
  createCampaign: (b: { name: string; utmCampaign?: string; utmId?: string; baseUrl: string } & Skip) => j<Campaign>('/campaigns', send('POST', b)),
  patchCampaign: (id: string, b: Partial<Pick<Campaign, 'name' | 'utmCampaign' | 'utmId' | 'baseUrl'>> & Skip) => j<Campaign & { rewritten: number }>(`/campaigns/${id}`, send('PATCH', b)),
  deleteCampaign: (id: string) => j<void>(`/campaigns/${id}`, send('DELETE')),
  bulkCreate: (id: string, items: BulkItem[], skip?: boolean) => j<{ items: MemberLink[] }>(`/campaigns/${id}/links`, send('POST', { items, ...(skip ? { screening: 'skip' } : {}) })),
  patchMember: (id: string, slug: string, b: Partial<Own>) => j<MemberLink>(`/campaigns/${id}/links/${slug}`, send('PATCH', b)),
  adopt: (id: string, slug: string) => j<MemberLink>(`/campaigns/${id}/adopt`, send('POST', { slug })),
  detach: (slug: string) => j<Link>(`/links/${slug}/detach`, send('POST')),
  setCampaignEnabled: (id: string, enabled: boolean) => j<Campaign>(`/campaigns/${id}/enabled`, send('POST', { enabled })),
  campaignStats: (id: string, range: Range) => j<CampaignStats>(`/campaigns/${id}/stats?range=${range}&tz=${TZ}`),
};

export const copy = (text: string) => navigator.clipboard?.writeText(text);
export const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
