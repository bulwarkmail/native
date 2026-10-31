// "Recover deleted items" (webmail JMAPClient.queryArchivedItemIds and
// friends, #1319): Stalwart's x:ArchivedItem methods. The pure parts are in
// lib/recovery/archived-items.
//
// Every call names the account it is for. The page passes `stillSameLogin`,
// which is asked right before each write: a switch of logins while a restore
// runs must not send the rest of it to the other login's server.

import { jmapClient } from './jmap-client';
import { JMAPMethodError, batched } from './jmap-result';
import type { JMAPMethodCall } from './types';
import {
  ARCHIVED_ITEM_USING,
  STALWART_CAPABILITY,
  buildRestoreCalls,
  hasArchivedEmail as peekArchive,
  listArchivedEmailsPaged,
  readRestoreResults,
  type ArchiveCall,
  type ArchiveIo,
  type ArchiveListResult,
  type ArchiveQueryPage,
  type RestoreResult,
} from '../lib/recovery/archived-items';

function methodError(result: unknown, fallback: string): JMAPMethodError {
  const error = result as { type?: string; description?: string } | undefined;
  return new JMAPMethodError(error?.type ?? 'serverFail', error?.description || fallback);
}

/**
 * Whether the account lists Stalwart's own capability. Stalwart puts it in
 * the account's accountCapabilities only, never at session level, so this
 * reads the account (webmail hasAccountCapability).
 */
export function advertisesArchivedItems(accountId: string = jmapClient.accountId): boolean {
  const caps = jmapClient.currentSession?.accounts?.[accountId]?.accountCapabilities;
  return !!caps && STALWART_CAPABILITY in caps;
}

/** Accounts whose server refused the `accountId` filter (every user without Impersonate). */
const filterRefused = new Set<string>();

/** For tests: forget which accounts refused the filter. */
export function resetArchiveFilterMemory(): void {
  filterRefused.clear();
}

/**
 * One page of the account's archived item ids, newest first. A request of
 * its own: without an Enterprise license Stalwart refuses it (`forbidden`),
 * and that must not take other calls down with it. The `accountId` filter
 * keeps an admin's answer to this account; a normal user is refused it
 * (`unsupportedFilter`) and asked again without it, once per account.
 */
export async function queryArchivedItemIds(
  accountId: string = jmapClient.accountId,
  options: { position?: number; limit?: number; calculateTotal?: boolean } = {},
): Promise<ArchiveQueryPage> {
  const args: Record<string, unknown> = { accountId };
  if (options.position) args.position = options.position;
  if (options.limit) args.limit = options.limit;
  if (options.calculateTotal) args.calculateTotal = true;
  const ask = async (filtered: boolean) => {
    const res = await jmapClient.request(
      [['x:ArchivedItem/query', filtered ? { ...args, filter: { accountId } } : args, 'q']],
      ARCHIVED_ITEM_USING,
    );
    return res.methodResponses?.[0] ?? [];
  };
  let [method, result] = await ask(!filterRefused.has(accountId));
  if (method === 'error' && (result as { type?: string } | undefined)?.type === 'unsupportedFilter' && !filterRefused.has(accountId)) {
    filterRefused.add(accountId);
    [method, result] = await ask(false);
  }
  if (method !== 'x:ArchivedItem/query') throw methodError(result, 'Failed to list deleted items');
  const { ids, total } = result as { ids?: unknown; total?: unknown };
  return {
    ids: Array.isArray(ids) ? ids.filter((v): v is string => typeof v === 'string') : [],
    total: typeof total === 'number' ? total : null,
  };
}

function archiveIo(accountId: string): ArchiveIo {
  return {
    query: (position, limit) => queryArchivedItemIds(accountId, { position, limit, calculateTotal: true }),
    get: async (ids) => {
      const calls: JMAPMethodCall[] = batched(ids, jmapClient.getMaxObjectsInGet())
        .map((batch, i): JMAPMethodCall => ['x:ArchivedItem/get', { accountId, ids: batch }, `g${i}`]);
      const list: unknown[] = [];
      for (const group of batched(calls, jmapClient.getMaxCallsInRequest())) {
        const res = await jmapClient.request(group, ARCHIVED_ITEM_USING);
        for (const [method, result] of res.methodResponses ?? []) {
          if (method !== 'x:ArchivedItem/get') throw methodError(result, 'Failed to read deleted items');
          const items = (result as { list?: unknown }).list;
          if (Array.isArray(items)) list.push(...items);
        }
      }
      return list;
    },
  };
}

/** The account's deleted messages inside the days window, newest first, in pages. */
export async function listArchivedEmails(
  accountId: string = jmapClient.accountId,
  options: { days?: number; startPosition?: number } = {},
): Promise<ArchiveListResult> {
  return listArchivedEmailsPaged(archiveIo(accountId), accountId, {
    days: options.days ?? 0,
    startPosition: options.startPosition,
  });
}

/** Whether at least one deleted message of the account is inside the days window. */
export async function hasArchivedEmail(
  accountId: string = jmapClient.accountId,
  options: { days?: number } = {},
): Promise<boolean> {
  return peekArchive(archiveIo(accountId), accountId, { days: options.days ?? 0 });
}

/** The reason a restore was not sent: another login is active now. */
export const LOGIN_SWITCHED = 'The account was switched';

/**
 * Asks the server to put `ids` back. Never throws: a request that fails, or
 * one not sent because the login changed, marks its items failed.
 */
export async function restoreArchivedItems(
  ids: string[],
  accountId: string = jmapClient.accountId,
  stillSameLogin: () => boolean = () => true,
): Promise<RestoreResult[]> {
  const calls = buildRestoreCalls(ids, accountId, jmapClient.getMaxObjectsInSet());
  const results: RestoreResult[] = [];
  const failGroup = (group: ArchiveCall[], reason: string) => {
    for (const [, args] of group) {
      results.push(...Object.keys(args.update as Record<string, unknown>).map((itemId) => ({ id: itemId, ok: false, error: reason })));
    }
  };
  for (const group of batched(calls, jmapClient.getMaxCallsInRequest())) {
    if (!stillSameLogin()) {
      failGroup(group, LOGIN_SWITCHED);
      continue;
    }
    try {
      const res = await jmapClient.request(group, ARCHIVED_ITEM_USING);
      results.push(...readRestoreResults(group, (res.methodResponses ?? []) as ArchiveCall[]));
    } catch (error) {
      failGroup(group, error instanceof Error ? error.message : String(error));
    }
  }
  return results;
}
