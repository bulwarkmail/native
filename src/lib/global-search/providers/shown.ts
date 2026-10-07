import { jmapClient } from '../../../api/jmap-client';
import type { OpScope } from '../../../api/op-scope';
import { clientServesAccount } from '../../active-client-account';
import { isStaleLoad } from '../../network-error';
import { isShownAccount, requireShownAccountScope } from '../../../stores/email-store';
import type { RemoteSearchResult, SearchAccount } from '../types';

// Account rules every provider follows. The app holds one live connection,
// for the account it shows; contacts, calendar and files have no detached
// read path, so they search that account alone. A search takes its scope
// when it starts and keeps a result only while that account is still shown
// on that connection: ids repeat across accounts (Stalwart numbers them per
// account), so a result that lands after a switch would otherwise show the
// account being left's item "1" under the new account.

export const NO_HITS: RemoteSearchResult = { hits: [], hasMore: false };

/** Whether app account `appAccountId` is shown and the live client serves it. */
export function isShownAndServed(appAccountId: string): boolean {
  return isShownAccount(appAccountId) && clientServesAccount(appAccountId);
}

/** The connection a search of the shown account runs on, or null when `appAccountId` isn't shown and served. */
export function takeShownScope(appAccountId: string, jmapAccountId?: string): OpScope | null {
  try {
    return requireShownAccountScope(appAccountId, jmapAccountId);
  } catch {
    return null;
  }
}

/** Whether a result read on `at` for `appAccountId` may still be shown. */
export function scopeStillShown(appAccountId: string, at: OpScope): boolean {
  return jmapClient.connectionGen === at.gen && isShownAndServed(appAccountId);
}

/** The searched account the in-memory caches belong to, if any: the shown one, while it is served. */
export function shownCacheAccount(accounts: SearchAccount[]): SearchAccount | null {
  const shown = accounts.find((account) => isShownAccount(account.appAccountId));
  return shown && clientServesAccount(shown.appAccountId) ? shown : null;
}

export function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

/**
 * A search of the shown account: takes the scope now, runs `read` on it and
 * keeps its hits only while the account is still shown on that connection
 * (nothing at all when it isn't shown to begin with). A replaced connection
 * is a dropped result, not an error row.
 */
export async function searchShown(
  account: SearchAccount,
  signal: AbortSignal,
  read: (at: OpScope) => Promise<RemoteSearchResult>,
  jmapAccountId?: string,
): Promise<RemoteSearchResult> {
  const at = takeShownScope(account.appAccountId, jmapAccountId);
  if (!at) return NO_HITS;
  let result: RemoteSearchResult;
  try {
    result = await read(at);
  } catch (err) {
    if (signal.aborted) throw abortError();
    if (isStaleLoad(err)) return NO_HITS;
    throw err;
  }
  if (signal.aborted) throw abortError();
  return scopeStillShown(account.appAccountId, at) ? result : NO_HITS;
}

/**
 * `items` taken in turn from each owner (first-seen order), so a page cut at
 * the limit holds every account's best matches rather than the first
 * account's alone. Order within an owner is kept.
 */
export function interleaveByOwner<T>(items: T[], ownerOf: (item: T) => string): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = ownerOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const lists = [...groups.values()];
  const out: T[] = [];
  for (let i = 0; out.length < items.length; i++) {
    for (const list of lists) if (i < list.length) out.push(list[i]);
  }
  return out;
}
