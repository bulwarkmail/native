// Background sync that fills the offline mail cache. Runs the discovery
// query (Email/query filtered by `after`), then fetches full bodies in
// batches, reporting progress to the offline-cache-store so the
// OfflineCacheBanner and the Settings screen can show live updates.

import { jmapClient } from '../api/jmap-client';
import { queryEmailsByFilter, getFullEmails } from '../api/email';
import { useOfflineCacheStore } from '../stores/offline-cache-store';
import type { Email } from '../api/types';

// Approximate the on-disk size of a serialised Email so we can show "Y MB
// downloaded" without measuring AsyncStorage usage. Body values dominate; the
// envelope is small. Using JSON.stringify().length is correct in code-units
// not bytes, but it's close enough for a UI-facing estimate.
function approxSize(email: Email): number {
  try {
    return JSON.stringify(email).length;
  } catch {
    return 0;
  }
}

// Hard cap so a misconfigured "30 days" against a noisy account doesn't try
// to enumerate 100k messages.
const DISCOVERY_LIMIT = 5000;
// Each Email/get request is bounded by the server's maxObjectsInGet. We
// further chunk to keep individual responses small (a 50-message response
// with full bodies + body values is already several MB).
const FETCH_CHUNK_FALLBACK = 25;

export interface RunOptions {
  days: number;
}

export async function runOfflineSync(opts: RunOptions): Promise<void> {
  const cache = useOfflineCacheStore.getState();
  // If a sync is in flight, request its abort and wait for the next caller
  // to start fresh. We don't queue — the most recent intent wins.
  if (cache.sync.phase === 'scanning' || cache.sync.phase === 'fetching') {
    cache.requestAbort();
    return;
  }
  if (!cache.hydrated) await cache.hydrate();
  cache.resetSync();

  const startedAt = Date.now();
  cache.setSyncState({ phase: 'scanning', startedAt });

  const since = new Date(startedAt - opts.days * 24 * 60 * 60 * 1000).toISOString();

  let ids: string[] = [];
  try {
    ids = await queryEmailsByFilter({ after: since }, DISCOVERY_LIMIT);
  } catch (err) {
    cache.setSyncState({
      phase: 'error',
      message: err instanceof Error ? err.message : 'Discovery query failed',
      finishedAt: Date.now(),
    });
    return;
  }

  // Drop entries from the cache that fell out of the lookback window — the
  // user expects the cache to track "the last X days", not grow forever.
  const keepSet = new Set(ids);
  const stale = Object.keys(cache.index.entries).filter((id) => !keepSet.has(id));
  if (stale.length > 0) {
    await cache.remove(stale);
  }

  const total = ids.length;
  cache.setSyncState({ phase: 'fetching', total, completed: 0, fetched: 0, bytes: 0 });

  // Skip already-cached ids — bodies on disk are immutable per messageId.
  const toFetch = ids.filter((id) => !cache.has(id));
  const skipped = total - toFetch.length;
  cache.setSyncState({ completed: skipped });

  if (toFetch.length === 0) {
    cache.setSyncState({
      phase: 'done',
      finishedAt: Date.now(),
    });
    return;
  }

  const chunkSize = Math.min(
    FETCH_CHUNK_FALLBACK,
    Math.max(1, jmapClient.getMaxObjectsInGet()),
  );

  let fetched = 0;
  let bytes = 0;
  let completed = skipped;

  for (let i = 0; i < toFetch.length; i += chunkSize) {
    if (useOfflineCacheStore.getState().consumeAbort()) {
      cache.setSyncState({
        phase: 'cancelled',
        finishedAt: Date.now(),
      });
      return;
    }

    const chunk = toFetch.slice(i, i + chunkSize);
    let emails: Email[];
    try {
      emails = await getFullEmails(chunk);
    } catch (err) {
      cache.setSyncState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'Fetch failed',
        finishedAt: Date.now(),
      });
      return;
    }

    for (const email of emails) {
      const size = approxSize(email);
      await cache.put(email, size);
      fetched += 1;
      bytes += size;
      completed += 1;
    }

    // Some chunked ids may have been deleted server-side between query and
    // fetch — they don't come back. Account for that in the completed count
    // so the progress bar still finishes at 100%.
    completed += chunk.length - emails.length;

    cache.setSyncState({ completed, fetched, bytes });
  }

  cache.setSyncState({
    phase: 'done',
    completed: total,
    fetched,
    bytes,
    finishedAt: Date.now(),
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
