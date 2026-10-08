import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { ShareNotification } from './types';
import { batched } from './jmap-result';

const USING = [CAPABILITIES.CORE, CAPABILITIES.PRINCIPALS];

/**
 * Pending share notifications of the user's own account, oldest first. The
 * list stays small: each one is destroyed once it has been shown.
 */
export async function getShareNotifications(): Promise<ShareNotification[]> {
  if (!jmapClient.hasCapability(CAPABILITIES.PRINCIPALS)) return [];
  const accountId = jmapClient.accountId;
  const response = await jmapClient.request(
    [
      ['ShareNotification/query', {
        accountId,
        sort: [{ property: 'created', isAscending: true }],
      }, '0'],
      ['ShareNotification/get', {
        accountId,
        '#ids': { resultOf: '0', name: 'ShareNotification/query', path: '/ids' },
      }, '1'],
    ],
    USING,
  );
  const getResp = response.methodResponses?.find((r) => r[0] === 'ShareNotification/get');
  if (!getResp) {
    const error = response.methodResponses?.find((r) => r[0] === 'error')?.[1] as { description?: string } | undefined;
    throw new Error(error?.description || 'Failed to load share notifications');
  }
  return ((getResp[1] as { list?: ShareNotification[] }).list ?? []);
}

/**
 * Acknowledges (destroys) share notifications that were shown, on the JMAP
 * account they were fetched for. Nothing is sent once the client serves
 * another account; `stillServing` also tells the app account apart (JMAP
 * account ids repeat across servers) and is re-checked before every batch.
 */
export async function destroyShareNotifications(
  ids: string[],
  accountId: string,
  stillServing?: () => boolean,
): Promise<void> {
  if (ids.length === 0 || !jmapClient.hasCapability(CAPABILITIES.PRINCIPALS)) return;
  for (const batch of batched(ids, jmapClient.getMaxObjectsInSet())) {
    // Re-checked per batch: the account can switch while an earlier one runs.
    if (jmapClient.accountId !== accountId || (stillServing && !stillServing())) {
      console.warn('[share-notifications] destroy skipped: the active account changed');
      return;
    }
    await jmapClient.request(
      [['ShareNotification/set', { accountId, destroy: batch }, '0']],
      USING,
    );
  }
}
