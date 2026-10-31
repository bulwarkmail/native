import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeJmap } from '../../stores/__tests__/fake-jmap-server';

// The unified views use the connected client for the live account and stored
// credentials for the others. Which account is live followed the old
// host-only id rule, so with a client signed in to :8016 an account from the
// days before ports (me@10.10.10.62, on :8120) was taken for the live one and
// asked the :8016 server for its mail. The live account's id is the one
// generateAccountId gives, registry included.

const server = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('../../stores/__tests__/fake-jmap-server').createFakeJmap> }));
const client = vi.hoisted(() => ({
  request: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  getStoredCredentials: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
}));

vi.mock('../jmap-client', () => {
  client.request = vi.fn(async (calls: Array<[string, Record<string, unknown>, string]>) => {
    if (calls[0][0] === 'Mailbox/get') {
      const accountId = calls[0][1].accountId as string;
      return { methodResponses: [['Mailbox/get', { accountId, list: [{ id: `${accountId}-in`, role: 'inbox', name: 'Inbox' }] }, calls[0][2]]] };
    }
    return server.current!.request(calls as never);
  });
  client.getStoredCredentials = vi.fn(async () => null);
  return {
    jmapClient: {
      isConnected: true,
      accountId: 'c',
      username: 'me',
      serverUrl: 'http://10.10.10.62:8016',
      currentSession: { apiUrl: 'http://10.10.10.62:8016/jmap/', accounts: {} },
      getSharedMailAccounts: () => [],
      request: client.request,
      getStoredCredentials: client.getStoredCredentials,
    },
    rewriteSessionUrl: (u: string) => u,
    extractOrigin: (u: string) => u,
    parseRetryAfter: () => 0,
    REQUEST_TIMEOUT_MS: 30000,
  };
});

import { fetchUnifiedInbox, resetUnifiedCache } from '../unified-inbox';
import { setKnownAccounts } from '../../lib/account-utils';

const OLD_8120 = 'me@10.10.10.62';
const LIVE_8016 = 'me@10.10.10.62:8016';

beforeEach(() => {
  resetUnifiedCache();
  client.request.mockClear();
  client.getStoredCredentials.mockClear();
  server.current = createFakeJmap({
    c: [{
      id: 'a', threadId: 't-a', size: 1, hasAttachment: false, mailboxIds: { 'c-in': true }, keywords: {},
      receivedAt: '2026-10-20T10:00:00Z', subject: 'On 8016', preview: '',
    }],
  });
  setKnownAccounts([
    { id: OLD_8120, username: 'me', serverUrl: 'http://10.10.10.62:8120' },
    { id: LIVE_8016, username: 'me', serverUrl: 'http://10.10.10.62:8016' },
  ]);
});

describe('the live account in the unified views', () => {
  it('is not an older host-only account on another port of the same host', async () => {
    await fetchUnifiedInbox([OLD_8120], 25, {}).catch(() => undefined);
    expect(client.request).not.toHaveBeenCalled();
    expect(client.getStoredCredentials).toHaveBeenCalledWith(OLD_8120);
  });

  it('is the account with the port the client is signed in to', async () => {
    const result = await fetchUnifiedInbox([LIVE_8016], 25, {});
    expect(client.getStoredCredentials).not.toHaveBeenCalled();
    expect(result.emails.map((e) => e.subject)).toEqual(['On 8016']);
  });
});
