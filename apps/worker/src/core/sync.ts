// Write-through to the redirect cache (ADR 0004): one "sync one link to KV" step reused by the write path, the tail
// of every write API request and the Cron Trigger. A KV write that still fails after three attempts never fails
// the caller; the link becomes sync pending in D1 and a later pass repairs it. Takes the KV binding as an argument
// so a test can inject a store that fails chosen writes.

import { cacheEntryOf, writeCacheEntry } from "./cache.ts";
import { listSyncPending, markCacheSynced, markSyncPending, type LinkRow } from "./db/links.ts";
import { log } from "./log.ts";

export interface SyncOptions {
  /** Waits between the three attempts. KV takes one write per key per second, so the last wait passes that. */
  retryDelaysMs?: readonly number[];
}

const RETRY_DELAYS_MS = [250, 1000];

/** Whether the link's current cache entry reached KV within three attempts. */
async function putEntry(kv: KVNamespace, row: LinkRow, delays: readonly number[]): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await writeCacheEntry(kv, row.slug, cacheEntryOf(row));
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
