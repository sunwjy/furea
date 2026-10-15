// The redirect cache (ADR 0004): KV mirrors every link under its slug. D1 is the source of truth; these functions
// take the KV binding as an argument so a test can inject a store that fails chosen writes.

/** A cache entry: enough to redirect or to answer a disabled link like an unknown slug, nothing more. */
export interface CacheEntry {
  to: string;
  disabled: boolean;
}

/** The edge read cache in front of KV (ADR 0004, *Read path*). */
const READ_CACHE_TTL_SECONDS = 60;

export function cacheEntryOf(link: { destination: string; enabled: 0 | 1 }): CacheEntry {
  return { to: link.destination, disabled: link.enabled === 0 };
}

export async function readCacheEntry(kv: KVNamespace, slug: string): Promise<CacheEntry | null> {
  return kv.get<CacheEntry>(slug, { type: "json", cacheTtl: READ_CACHE_TTL_SECONDS });
}

/** No expiration TTL: an entry lives until the link changes or is deleted. */
export async function writeCacheEntry(kv: KVNamespace, slug: string, entry: CacheEntry): Promise<void> {
  await kv.put(slug, JSON.stringify(entry));
}

export async function deleteCacheEntry(kv: KVNamespace, slug: string): Promise<void> {
  await kv.delete(slug);
}
