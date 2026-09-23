// PROTOTYPE — in-memory mock of the instance. Resets on restart. Numbers are fake.
export type Link = {
  slug: string;
  destination: string;
  title: string | null;
  disabled: boolean;
  syncPending: boolean;
  clickCount: number; // lifetime total (exact, D1)
  createdAt: string;
};
export type Range = '24h' | '7d' | '30d' | '90d';
export type Breakdown = {
  range: Range;
  estimated: true;
  series: { t: string; clicks: number }[];
  countries: { key: string; clicks: number }[];
  referrers: { key: string; clicks: number }[];
  devices: { key: string; clicks: number }[];
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h >>> 0) % 10000) / 10000;
  };
}
export function generateSlug() {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

const daysAgo = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
const seed: Omit<Link, 'clickCount' | 'syncPending'>[] = [
  { slug: 'launch', destination: 'https://blog.example.com/2026/09/furea-launch-announcement', title: 'Launch post', disabled: false, createdAt: daysAgo(80) },
  { slug: 'docs', destination: 'https://docs.example.com/getting-started', title: 'Docs', disabled: false, createdAt: daysAgo(75) },
  { slug: 'gh', destination: 'https://github.com/sunwjy/furea', title: 'GitHub repo', disabled: false, createdAt: daysAgo(70) },
  { slug: 'Q3-report', destination: 'https://drive.example.com/file/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ/view?usp=sharing', title: 'Q3 report (internal)', disabled: false, createdAt: daysAgo(40) },
  { slug: 'promo', destination: 'https://shop.example.com/collections/autumn-2026?utm_source=short', title: 'Autumn promo', disabled: true, createdAt: daysAgo(30) },
  { slug: 'Kx7pQ2', destination: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: null, disabled: false, createdAt: daysAgo(21) },
  { slug: 'cal', destination: 'https://cal.example.com/sun/30min', title: 'Book a call', disabled: false, createdAt: daysAgo(14) },
  { slug: 'newsletter', destination: 'https://news.example.com/subscribe', title: 'Newsletter signup', disabled: false, createdAt: daysAgo(10) },
  { slug: 'mN4vBw', destination: 'https://en.wikipedia.org/wiki/URL_shortening', title: null, disabled: false, createdAt: daysAgo(6) },
  { slug: 'hiring', destination: 'https://jobs.example.com/positions/backend-engineer', title: 'Hiring page', disabled: false, createdAt: daysAgo(3) },
  { slug: 'z9TrEe', destination: 'https://maps.app.goo.gl/abcdef123456', title: 'Office map', disabled: false, createdAt: daysAgo(1) },
  { slug: 'deck', destination: 'https://slides.example.com/d/furea-v1-plan', title: 'v1 planning deck', disabled: false, createdAt: daysAgo(0.2) },
];

export const links: Link[] = seed.map((l, i) => {
  const r = rng(l.slug);
  const age = (Date.now() - Date.parse(l.createdAt)) / 864e5;
  return {
    ...l,
    syncPending: i === 3,
    clickCount: Math.floor(age * (5 + r() * 120) + r() * 40),
  };
});

export function findLink(slug: string) {
  return links.find((l) => l.slug === slug) ?? null;
}

export function breakdown(slug: string, range: Range): Breakdown {
  const link = findLink(slug);
  const r = rng(slug + range);
  const buckets = range === '24h' ? 24 : range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const createdMs = link ? Date.parse(link.createdAt) : 0;
  const series = Array.from({ length: buckets }, (_, i) => {
    const back = buckets - 1 - i;
    const t = range === '24h' ? new Date(Date.now() - back * 36e5) : new Date(Date.now() - back * 864e5);
    const before = t.getTime() < createdMs;
    const base = link ? Math.max(1, link.clickCount / Math.max(1, (Date.now() - createdMs) / 864e5)) : 0;
    const scale = range === '24h' ? base / 24 : base;
    return { t: t.toISOString(), clicks: before ? 0 : Math.round(scale * (0.3 + r() * 1.6)) };
  });
  const total = series.reduce((a, b) => a + b.clicks, 0) || 1;
  const split = (keys: string[]) => {
    const w = keys.map(() => r() + 0.05);
    const s = w.reduce((a, b) => a + b, 0);
    return keys.map((key, i) => ({ key, clicks: Math.round((total * w[i]) / s) })).sort((a, b) => b.clicks - a.clicks);
  };
  return {
    range,
    estimated: true,
    series,
    countries: split(['KR', 'US', 'JP', 'DE', 'GB', 'FR', 'IN', 'XX']),
    referrers: split(['direct', 'twitter.com', 'news.ycombinator.com', 'linkedin.com', 'slack.com', 'mail.google.com']),
    devices: split(['desktop', 'mobile', 'tablet', 'bot', 'unknown']),
  };
}

export function instanceOverview(range: Range) {
  const r = rng('instance' + range);
  const sum = (days: number) => links.reduce((a, l) => a + Math.round(Math.min(days, 90) * (l.clickCount / 90) * (0.6 + r() * 0.8)), 0);
  const top = links
    .map((l) => ({ slug: l.slug, title: l.title, clicks: breakdown(l.slug, range).series.reduce((a, b) => a + b.clicks, 0) }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10);
  return { estimated: true as const, today: sum(1), last7d: sum(7), last30d: sum(30), top, range };
}
