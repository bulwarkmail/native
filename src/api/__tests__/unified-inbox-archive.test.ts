import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeJmap } from '../../stores/__tests__/fake-jmap-server';

// A unified list spans accounts, and not every account has an Archive
// folder. The hover Archive button is offered per row from what the fetch
// already knows of the row's account.

const server = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('../../stores/__tests__/fake-jmap-server').createFakeJmap> }));

vi.mock('../jmap-client', () => ({
  jmapClient: {
    isConnected: true,
    accountId: 'c',
    username: 'me',
    serverUrl: 'https://mail.example.com',
    currentSession: { apiUrl: 'https://mail.example.com/jmap/', accounts: {} },
    getSharedMailAccounts: () => [{ id: 'team', name: 'Team' }],
    request: vi.fn(async (calls: Array<[string, Record<string, unknown>, string]>) => {
      if (calls[0][0] === 'Mailbox/get') {
        const accountId = calls[0][1].accountId as string;
        const list = [{ id: `${accountId}-in`, role: 'inbox', name: 'Inbox' }];
        // Only the user's own account has an Archive folder.
        if (accountId === 'c') list.push({ id: 'c-arch', role: 'archive', name: 'Archive' });
        return { methodResponses: [['Mailbox/get', { accountId, list }, calls[0][2]]] };
      }
      return server.current!.request(calls as never);
    }),
  },
  rewriteSessionUrl: (u: string) => u,
  extractOrigin: (u: string) => u,
  parseRetryAfter: () => 0,
  REQUEST_TIMEOUT_MS: 30000,
}));

import { fetchUnifiedInbox, resetUnifiedCache, unifiedCanArchive, type UnifiedEmail } from '../unified-inbox';
import type { Email } from '../types';

// The live account's registry id: username@host.
const ACCOUNT = 'me@mail.example.com';

function mail(id: string, folder: string, day: number): Email {
  return {
    id, threadId: `t-${id}`, size: 1, hasAttachment: false,
    mailboxIds: { [folder]: true }, keywords: {},
    receivedAt: `2026-09-${String(day).padStart(2, '0')}T10:00:00Z`,
    subject: id, preview: '',
  };
}

beforeEach(() => {
  resetUnifiedCache();
  server.current = createFakeJmap({ c: [mail('a', 'c-in', 20)], team: [mail('b', 'team-in', 22)] });
});

describe('archive in a unified list', () => {
  it('is offered on a row whose account has an Archive folder, and not on one without', async () => {
    const { emails } = await fetchUnifiedInbox([ACCOUNT], 25, { includeGroup: true });
    const own = emails.find((e) => e.jmapAccountId === 'c')!;
    const shared = emails.find((e) => e.jmapAccountId === 'team')!;
    expect(unifiedCanArchive(own)).toBe(true);
    expect(unifiedCanArchive(shared)).toBe(false);
  });

  it('stays offered while the account\'s folders are not known', () => {
    const row = { ...mail('z', 'x-in', 1), sourceAccountId: 'other@mail.example.com', jmapAccountId: 'x' } as UnifiedEmail;
    expect(unifiedCanArchive(row)).toBe(true);
  });
});
