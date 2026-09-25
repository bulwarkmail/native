// Background sync that fills the offline mail cache. Runs the discovery
// query (Email/query filtered by `after`) for the user's own account and
// every shared (group) account in the session, then fetches full bodies in
// batches, reporting progress to the offline-cache-store so the
// OfflineCacheBanner and the Settings screen can show live updates.

import { jmapClient } from '../api/jmap-client';
import { queryEmailsByFilter, getFullEmails } from '../api/email';
import { useOfflineCacheStore, cacheKey } from '../stores/offline-cache-store';
import type { Email } from '../api/types';
import { generateAccountId } from './account-utils';

// The sync reads through the JMAP client and writes into the cache's loaded
// bucket. During an account switch the two name different accounts for a
// while (the stores switch first, then the client), so a sync goes on only
// while both are on the account it started for. When they are not, the
// progress on screen belongs to the other account and is left alone.
function onAccount(accountId: string): boolean {
  if (useOfflineCacheStore.getState().activeAccountId !== accountId) return false;
  const { username, serverUrl } = jmapClient;
  if (!username || !serverUrl) return false;
  return generateAccountId(username, serverUrl) === accountId;
}

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
// to enumerate 100k messages. Shared accounts share the budget.
const DISCOVERY_LIMIT = 5000;
// Each Email/get request is bounded by the server's maxObjectsInGet. We
// further chunk to keep individual responses small (a 50-message response
// with full bodies + body values is already several MB).
const FETCH_CHUNK_FALLBACK = 25;

export interface RunOptions {
  days: number;
  /** Hard cap on the cache in megabytes; oldest mail is evicted to fit. */
  maxMB?: number;
}

interface SyncTarget {
  /** JMAP account override; undefined = the user's own account. */
  accountId?: string;
  ids: string[];
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
  const account = useOfflineCacheStore.getState().activeAccountId;
  if (!account || !onAccount(account)) return;
  cache.resetSync();

  const startedAt = Date.now();
  cache.setSyncState({ phase: 'scanning', startedAt });

  const since = new Date(startedAt - opts.days * 24 * 60 * 60 * 1000).toISOString();

  // Own mail first, then each shared/group account. A shared account that
  // cannot be reached is skipped rather than failing the whole sync; the
  // own-account discovery failing is fatal as before.
  const targets: SyncTarget[] = [];
  try {
    targets.push({ accountId: undefined, ids: await queryEmailsByFilter({ after: since }, DISCOVERY_LIMIT) });
  } catch (err) {
    if (!onAccount(account)) return;
    cache.setSyncState({
      phase: 'error',
      message: err instanceof Error ? err.message : 'Discovery query failed',
      finishedAt: Date.now(),
    });
    return;
  }
  let budget = Math.max(0, DISCOVERY_LIMIT - targets[0].ids.length);
  for (const acc of jmapClient.getSharedMailAccounts()) {
    if (budget <= 0) break;
    try {
      const ids = await queryEmailsByFilter({ after: since }, budget, acc.id);
      targets.push({ accountId: acc.id, ids });
      budget -= ids.length;
    } catch (err) {
      console.warn('[offline-sync] shared account discovery failed:', acc.id, err);
    }
  }
  // The ids found name messages of whichever account the client served.
  if (!onAccount(account)) return;

  // Drop entries from the cache that fell out of the lookback window — the
  // user expects the cache to track "the last X days", not grow forever.
  const keepSet = new Set<string>();
  for (const tgt of targets) for (const id of tgt.ids) keepSet.add(cacheKey(id, tgt.accountId));
  const staleByAccount = new Map<string | undefined, string[]>();
  for (const entry of Object.values(useOfflineCacheStore.getState().index.entries)) {
    const key = cacheKey(entry.id, entry.jmapAccountId);
    if (keepSet.has(key)) continue;
    const list = staleByAccount.get(entry.jmapAccountId);
    if (list) list.push(entry.id); else staleByAccount.set(entry.jmapAccountId, [entry.id]);
  }
  for (const [accountId, ids] of staleByAccount) {
    if (!onAccount(account)) return;
    if (ids.length > 0) await cache.remove(ids, accountId);
  }
  if (!onAccount(account)) return;

  const total = targets.reduce((n, tgt) => n + tgt.ids.length, 0);
  cache.setSyncState({ phase: 'fetching', total, completed: 0, fetched: 0, bytes: 0 });

  // Skip already-cached ids — bodies on disk are immutable per messageId.
  const work = targets.map((tgt) => ({
    accountId: tgt.accountId,
    ids: tgt.ids.filter((id) => !cache.has(id, tgt.accountId)),
  }));
  const toFetchCount = work.reduce((n, tgt) => n + tgt.ids.length, 0);
  const skipped = total - toFetchCount;
  cache.setSyncState({ completed: skipped });

  if (toFetchCount === 0) {
    if (opts.maxMB) await cache.evictToFit(opts.maxMB * 1024 * 1024);
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

  for (const tgt of work) {
    for (let i = 0; i < tgt.ids.length; i += chunkSize) {
      if (!onAccount(account)) return;
      if (useOfflineCacheStore.getState().consumeAbort()) {
        cache.setSyncState({
          phase: 'cancelled',
          finishedAt: Date.now(),
        });
        return;
      }

      const chunk = tgt.ids.slice(i, i + chunkSize);
      let emails: Email[];
      try {
        emails = await getFullEmails(chunk, tgt.accountId);
      } catch (err) {
        if (!onAccount(account)) return;
        cache.setSyncState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'Fetch failed',
          finishedAt: Date.now(),
        });
        return;
      }
      // Read through a client that may have moved on to another account.
      if (!onAccount(account)) return;

      for (const email of emails) {
        const size = approxSize(email);
        await cache.put(email, size, tgt.accountId, account);
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
  }

  // Trim the cache back under its size cap, shedding the oldest mail. Done
  // after fetching so we never evict something we're about to keep.
  if (!onAccount(account)) return;
  if (opts.maxMB) await cache.evictToFit(opts.maxMB * 1024 * 1024);

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
