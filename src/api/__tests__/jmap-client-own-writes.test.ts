import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-secure-store', () => ({
  setItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import { JMAPClient } from '../jmap-client';
import { ownEmailWritesBetween, resetOwnWrites, whenOwnWritesSettled } from '../own-writes';
import type { JMAPSession } from '../types';

const SESSION: JMAPSession = {
  apiUrl: 'https://mail.example.com/jmap/',
  downloadUrl: 'https://mail.example.com/download/{accountId}/{blobId}/{name}?type={type}',
  uploadUrl: 'https://mail.example.com/upload/{accountId}/',
  eventSourceUrl: 'https://mail.example.com/eventsource/',
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc-1' },
  accounts: { 'acc-1': { name: 'user@example.com', isPersonal: true, isReadOnly: false, accountCapabilities: {} } },
  capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:mail': {} },
  state: 's1',
  username: 'user@example.com',
};

function respond(json: unknown) {
  const text = JSON.stringify(json);
  return {
    ok: true, status: 200, statusText: 'OK', redirected: false, url: '',
    headers: { get: () => null },
    json: async () => json,
    text: async () => text,
  };
}

async function connected(apiResponses: unknown[]): Promise<JMAPClient> {
  const queue = [SESSION, ...apiResponses];
  global.fetch = vi.fn(async () => respond(queue.shift())) as unknown as typeof fetch;
  const client = new JMAPClient();
  await client.connect('https://mail.example.com', 'user', 'pass');
  return client;
}

beforeEach(() => resetOwnWrites());

describe('JMAPClient.request logs our own mail writes', () => {
  it('records the states an Email/set moved between', async () => {
    const client = await connected([{
      methodResponses: [['Email/set', { accountId: 'acc-1', oldState: 'e1', newState: 'e2', updated: { m1: null } }, '0']],
    }]);

    const pending = client.request([['Email/set', { accountId: 'acc-1', update: { m1: { 'keywords/$seen': true } } }, '0']]);
    let settled = false;
    const wait = whenOwnWritesSettled(10_000).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await pending;
    await wait;

    expect(ownEmailWritesBetween('https://mail.example.com', 'acc-1', 'e1', 'e2')).toEqual([
      expect.objectContaining({ updated: [{ id: 'm1', patch: { 'keywords/$seen': true } }] }),
    ]);
  });

  it('does not turn a malformed response into a failed request', async () => {
    const client = await connected([{ methodResponses: [['Email/set', null, '0']] }]);
    await expect(client.request([['Email/set', { accountId: 'acc-1' }, '0']])).resolves.toBeDefined();
  });
});
