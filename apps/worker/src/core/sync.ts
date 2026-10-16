// Write-through to the redirect cache (ADR 0004): one "sync one link to KV" step reused by the write path, the tail
// of every write API request and the Cron Trigger. A KV write that still fails after three attempts never fails
// the caller; the link becomes sync pending in D1 and a later pass repairs it. Takes the KV binding as an argument
// so a test can inject a store that fails chosen writes.

import { cacheEntryOf, deleteCacheEntry, ROOT_CACHE_KEY, writeCacheEntry } from "./cache.ts";
import { listSyncPending, markCacheSynced, markSyncPending, type LinkRow } from "./db/links.ts";
import { getRootDestination, isRootSyncPending, markRootSynced, markRootSyncPending } from "./db/settings.ts";
import { log } from "./log.ts";

export interface SyncOptions {
  /** Waits between the three attempts. KV takes one write per key per second, so the last wait passes that. */
  retryDelaysMs?: readonly number[];
}

const RETRY_DELAYS_MS = [250, 1000];

/** Whether the link's current cache entry reached KV within three attempts. */
const putEntry = (kv: KVNamespace, row: LinkRow, delays: readonly number[]) =>
  withRetries(() => writeCacheEntry(kv, row.slug, cacheEntryOf(row)), delays);

/** Whether `write` succeeded within three attempts. */
async function withRetries(write: () => Promise<void>, delays: readonly number[]): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await write();
      return true;
    } catch {
      const delay = delays[attempt];
      if (delay === undefined) return false;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Writes a just-saved link's cache entry and returns the row with `cache_synced` as it now stands: `0` with a
 * `cache_sync_failed` log when the cache could not be written.
 */
export async function writeThrough(
  db: D1Database,
  kv: KVNamespace,
  row: LinkRow,
  { retryDelaysMs = RETRY_DELAYS_MS }: SyncOptions = {},
): Promise<LinkRow> {
  if (await putEntry(kv, row, retryDelaysMs)) {
    if (row.cache_synced === 0) await markCacheSynced(db, row);
    return { ...row, cache_synced: 1 };
  }
  await markSyncPending(db, row.slug);
  log({ event: "cache_sync_failed", slug: row.slug });
  return { ...row, cache_synced: 0 };
}

/** Writes (or, when unset, deletes) the root destination's entry under the reserved key, as D1 now has it. */
async function syncRoot(db: D1Database, kv: KVNamespace, delays: readonly number[]): Promise<boolean> {
  const destination = await getRootDestination(db);
  const synced = await withRetries(
    () =>
      destination === null
        ? deleteCacheEntry(kv, ROOT_CACHE_KEY)
        : writeCacheEntry(kv, ROOT_CACHE_KEY, { to: destination, disabled: false }),
    delays,
  );
  if (synced) await markRootSynced(db, destination);
  return synced;
}

/**
 * `writeThrough` for the root destination (ADR 0008): call it after the D1 write. Returns whether the cache now
 * matches; when it does not, the root is sync pending with a `cache_sync_failed` log under its key.
 */
export async function writeRootThrough(
  db: D1Database,
  kv: KVNamespace,
  { retryDelaysMs = RETRY_DELAYS_MS }: SyncOptions = {},
): Promise<boolean> {
  if (await syncRoot(db, kv, retryDelaysMs)) return true;
  await markRootSyncPending(db);
  log({ event: "cache_sync_failed", slug: ROOT_CACHE_KEY });
  return false;
}

export interface RepairResult {
  repaired: number;
  failed: number;
}

/**
 * One repair pass over the sync-pending links (all of them, or the `limit` least recently changed). Logs
 * `cache_repair` only when it repaired or failed something.
 */
export async function repairSyncPending(
  db: D1Database,
  kv: KVNamespace,
  { limit, retryDelaysMs = RETRY_DELAYS_MS }: SyncOptions & { limit?: number } = {},
): Promise<RepairResult> {
  const result: RepairResult = { repaired: 0, failed: 0 };
  // The root destination is one more entry, outside the link limit: there is never more than one of it.
  if (await isRootSyncPending(db)) {
    if (await syncRoot(db, kv, retryDelaysMs)) result.repaired++;
    else result.failed++;
  }
  for (const row of await listSyncPending(db, limit)) {
    if (await putEntry(kv, row, retryDelaysMs)) {
      await markCacheSynced(db, row);
      result.repaired++;
    } else {
      result.failed++;
    }
  }
  log({ event: "cache_repair", ...result });
  return result;
}
