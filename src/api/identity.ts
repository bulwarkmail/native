import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { Identity } from './types';

export async function getIdentities(): Promise<Identity[]> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['Identity/get', { accountId }, '0']],
    [CAPABILITIES.CORE, CAPABILITIES.SUBMISSION],
  );
  return res.methodResponses[0][1].list;
}

export async function createIdentity(
  identity: Partial<Identity>,
): Promise<Identity> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['Identity/set', {
      accountId,
      create: { 'new-identity': identity },
    }, '0']],
    [CAPABILITIES.CORE, CAPABILITIES.SUBMISSION],
  );
  return res.methodResponses[0][1].created['new-identity'];
}

export async function updateIdentity(
  id: string,
  changes: Partial<Identity>,
): Promise<void> {
  const accountId = jmapClient.accountId;
  await jmapClient.request(
    [['Identity/set', { accountId, update: { [id]: changes } }, '0']],
    [CAPABILITIES.CORE, CAPABILITIES.SUBMISSION],
  );
}

export async function deleteIdentity(id: string): Promise<void> {
  const accountId = jmapClient.accountId;
  await jmapClient.request(
    [['Identity/set', { accountId, destroy: [id] }, '0']],
    [CAPABILITIES.CORE, CAPABILITIES.SUBMISSION],
  );
}
