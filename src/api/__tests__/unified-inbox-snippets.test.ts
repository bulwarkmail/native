import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeJmap } from '../../stores/__tests__/fake-jmap-server';

// A search in the unified views highlights its hits like the folder list
// (webmail searchAcrossAccounts with deferSnippets, 2d67442a2): the page
// comes back first, each account's SearchSnippet/get follows, and the
// excerpts are keyed by account because ids repeat across them.

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
      // The fake answers mail calls; folders are answered here.
      if (calls[0][0] === 'Mailbox/get') {
        const accountId = calls[0][1].accountId as string;
        return { methodResponses: [['Mailbox/get', { accountId, list: [{ id: `${accountId}-in`, role: 'inbox', name: 'Inbox' }] }, calls[0][2]]] };
      }
      return server.current!.request(calls as never);
    }),
  },
  rewriteSessionUrl: (u: string) => u,
  extractOrigin: (u: string) => u,
  parseRetryAfter: () => 0,
  REQUEST_TIMEOUT_MS: 30000,
}));

import { fetchUnifiedInbox, resetUnifiedCache, unifiedSnippetStamp } from '../unified-inbox';
import { withSearchSnippets } from '../../lib/search-snippet';
import type { Email } from '../types';

// The live account's registry id: username@host.
const ACCOUNT = 'me@mail.example.com';

function mail(id: string, folder: string, day: number, subject: string, preview: string): Email {
  return {
    id, threadId: `t-${id}`, size: 1, hasAttachment: false,
    mailboxIds: { [folder]: true }, keywords: {},
    receivedAt: `2026-09-${String(day).padStart(2, '0')}T10:00:00Z`,
    subject, preview,
  };
}

beforeEach(() => {
  resetUnifiedCache();
  server.current = createFakeJmap({
    c: [mail('a', 'c-in', 20, 'Zephyr launch', 'own body'), mail('b', 'c-in', 19, 'Lunch', 'nothing')],
    team: [mail('a', 'team-in', 22, 'Team sync', 'the zephyr review')],
  });
});

describe('unified search snippets', () => {
  it("hands back each account's excerpts for its own rows", async () => {
    const result = await fetchUnifiedInbox([ACCOUNT], 25, { includeGroup: true, query: 'zephyr' });
    expect(result.emails.map((e) => `${e.jmapAccountId}:${e.id}`)).toEqual(['team:a', 'c:a']);
    expect(result.snippets).toBeDefined();

    const batches = await result.snippets!;
    const calls = server.current!.callsOf('SearchSnippet/get');
    expect(calls.map(([, args]) => [args.accountId, args.emailIds])).toEqual(
      expect.arrayContaining([['c', ['a']], ['team', ['a']]]),
    );
    const rows = withSearchSnippets(result.emails, batches, unifiedSnippetStamp);
    expect(rows.find((e) => e.jmapAccountId === 'team')?.searchSnippet)
      .toEqual({ subject: null, preview: 'the <mark>zephyr</mark> review' });
    expect(rows.find((e) => e.jmapAccountId === 'c')?.searchSnippet)
      .toEqual({ subject: '<mark>Zephyr</mark> launch', preview: null });
  });

  it('asks for no excerpts without a search', async () => {
    const result = await fetchUnifiedInbox([ACCOUNT], 25, { includeGroup: true });
    expect(result.emails).toHaveLength(3);
    expect(result.snippets).toBeUndefined();
    expect(server.current!.callsOf('SearchSnippet/get')).toHaveLength(0);
  });

  it('lists the page even when an account cannot excerpt', async () => {
    const release = server.current!.holdSnippets();
    const result = await fetchUnifiedInbox([ACCOUNT], 25, { includeGroup: true, query: 'zephyr' });
    expect(result.emails).toHaveLength(2);
    server.current!.failing.set('team', 'forbidden');
    release();
    const batches = await result.snippets!;
    expect(batches.map((b) => b.accountId)).toEqual([`${ACCOUNT}|c`]);
  });
});
