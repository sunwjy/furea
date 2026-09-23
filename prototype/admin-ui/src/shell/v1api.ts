// Client for the ADR 0009 mock under /api/v1. Types mirror the ADR, not the old placeholder API in ../api.ts.
export type Link = {
  slug: string; shortUrl: string; destination: string; title: string | null; enabled: boolean;
  clickCount: number; cacheSynced: boolean; createdAt: string; updatedAt: string;
};
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
  create: (b: { destination: string; slug?: string; title?: string }) => j<Link>('/links', send('POST', b)),
  patch: (slug: string, b: Partial<Pick<Link, 'destination' | 'title' | 'enabled'>>) => j<Link>(`/links/${slug}`, send('PATCH', b)),
  remove: (slug: string) => j<void>(`/links/${slug}`, send('DELETE')),
  linkStats: (slug: string, range: Range) => j<LinkStats>(`/links/${slug}/stats?range=${range}&tz=${TZ}`),
  stats: (range: Range = '7d') => j<InstanceStats>(`/stats?range=${range}&tz=${TZ}`),
  settings: () => j<Settings>('/settings'),
  patchSettings: (b: Partial<Pick<Settings, 'rootDestination' | 'access'>>) => j<Settings>('/settings', send('PATCH', b)),
  changePassword: (currentPassword: string, newPassword: string) => j<void>('/password', send('POST', { currentPassword, newPassword })),
  apiKeys: () => j<ApiKey[]>('/api-keys'),
  createKey: (name: string, scope: 'read' | 'write') => j<ApiKey & { key: string }>('/api-keys', send('POST', { name, scope })),
  revokeKey: (id: string) => j<void>(`/api-keys/${id}`, send('DELETE')),
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
