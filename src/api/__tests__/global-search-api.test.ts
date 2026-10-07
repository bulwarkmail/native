import { beforeEach, describe, expect, it, vi } from 'vitest';

// The server reads global search makes (src/lib/global-search/providers):
// one account's mail search, the contacts and calendar text queries and the
// cached file listing. Every request must go out on the connection its
// operation started on (`{ gen }`), so a switch never lets it land elsewhere.

const session = {
  primaryAccounts: {} as Record<string, string>,
  accounts: {} as Record<string, { name: string; isPersonal: boolean; accountCapabilities?: Record<string, unknown> }>,
  apiUrl: 'https://a.example/jmap',
};

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    connectionGen: 4,
    isConnected: true,
    username: 'me',
    serverUrl: 'https://a.example',
    get currentSession() { return session; },
    request: vi.fn(),
    getSharedMailAccounts: vi.fn(() => [] as { id: string; name: string }[]),
    getMaxObjectsInGet: () => 500,
    getMaxCallsInRequest: () => 16,
    getMaxObjectsInSet: () => 500,
    hasCapability: () => false,
    hasAccountCapability: () => false,
    getAccountCapability: () => ({ forbiddenNameChars: '/' }),
  },
  rewriteSessionUrl: (u: string) => u,
  extractOrigin: (u: string) => u,
  parseRetryAfter: () => 0,
  REQUEST_TIMEOUT_MS: 1000,
}));
vi.mock('../blob', () => ({ getDownloadUrl: vi.fn(), uploadBlob: vi.fn(), uploadBytes: vi.fn() }));

import { jmapClient } from '../jmap-client';
import { invalidateUnifiedMailboxes, resetUnifiedCache, searchAccountEmails } from '../unified-inbox';
import { searchContacts } from '../contacts';
import { searchEventsAcrossAccounts } from '../calendar';
import {
  FILE_LISTING_TTL_MS, deleteFileNodes, getFileListing, invalidateFileListing, peekFileListing, renameFileNode,
} from '../files';

const client = jmapClient as unknown as {
  connectionGen: number;
  accountId: string;
  username: string;
  request: ReturnType<typeof vi.fn>;
  getSharedMailAccounts: ReturnType<typeof vi.fn>;
};
const mockRequest = client.request;

type Call = [string, Record<string, unknown>, string];
const callsOf = (n: number) => mockRequest.mock.calls[n][0] as Call[];
const optsOf = (n: number) => mockRequest.mock.calls[n][2] as { gen?: number } | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  client.connectionGen = 4;
  client.accountId = 'acc-1';
  client.username = 'me';
  session.primaryAccounts = {};
  session.accounts = {};
  client.getSharedMailAccounts.mockReturnValue([]);
  resetUnifiedCache();
  invalidateFileListing();
});

// ---------------------------------------------------------------------------

describe('searchAccountEmails', () => {
  const answerMail = (byAccount: Record<string, { mailboxes: unknown[]; emails: Array<Record<string, unknown>> }>) => {
    mockRequest.mockImplementation(async (calls: Call[]) => {
      const [name, args] = calls[0];
      const data = byAccount[args.accountId as string];
      if (!data) return { methodResponses: [['error', { type: 'forbidden' }, '0']] };
      if (name === 'Mailbox/get') return { methodResponses: [['Mailbox/get', { list: data.mailboxes }, '0']] };
      return {
        methodResponses: [
          ['Email/query', { ids: data.emails.map((e) => e.id), total: 100 }, '0'],
          ['Email/get', { list: data.emails }, '1'],
        ],
      };
    });
  };

  it('queries the shown account on its scope, with the filter its folders give', async () => {
    answerMail({
      'acc-1': {
        mailboxes: [{ id: 'in', name: 'Inbox', role: 'inbox' }, { id: 'tr', name: 'Trash', role: 'trash' }],
        emails: [{ id: '1', subject: 'Zebra', receivedAt: '2026-01-01T00:00:00Z', mailboxIds: { in: true } }],
      },
    });
    const filter = vi.fn((mailboxes: Array<{ id: string; accountId?: string }>) => ({
      text: 'zebra', seen: mailboxes.map((m) => `${m.accountId}/${m.id}`),
    }));
    const result = await searchAccountEmails('me@a.example', {
      filter, limit: 10, position: 20, at: { gen: 4, accountId: 'acc-1' },
    });
    expect(filter).toHaveBeenCalledWith(expect.any(Array), 'acc-1');
    const query = callsOf(1);
    expect(query[0]).toEqual(['Email/query', {
      accountId: 'acc-1',
      filter: { text: 'zebra', seen: ['acc-1/in', 'acc-1/tr'] },
      sort: [{ property: 'receivedAt', isAscending: false }],
      position: 20,
      limit: 10,
      calculateTotal: true,
    }, '0']);
    expect(query[1][1]).toMatchObject({ accountId: 'acc-1', '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' } });
    // Every request on the scope's connection.
    expect(mockRequest.mock.calls.every((c) => (c[2] as { gen?: number } | undefined)?.gen === 4)).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(result.emails[0]).toMatchObject({
      id: '1', sourceAccountId: 'me@a.example', jmapAccountId: 'acc-1', isShared: false, sourceFolder: 'Inbox',
    });
  });

  it('adds the group accounts when asked, skipping one that fails', async () => {
    client.getSharedMailAccounts.mockReturnValue([{ id: 'grp', name: 'Support' }, { id: 'gone', name: 'Gone' }]);
    answerMail({
      'acc-1': { mailboxes: [], emails: [{ id: '1', receivedAt: '2026-01-01T00:00:00Z', mailboxIds: {} }] },
      grp: { mailboxes: [{ id: 'gi', name: 'Group inbox', role: 'inbox' }], emails: [{ id: '1', receivedAt: '2026-01-02T00:00:00Z', mailboxIds: { gi: true } }] },
    });
    const result = await searchAccountEmails('me@a.example', {
      filter: () => ({ text: 'x' }), limit: 10, includeGroup: true, at: { gen: 4, accountId: 'acc-1' },
    });
    expect(result.emails.map((e) => [e.jmapAccountId, e.id, e.isShared, e.sourceFolder])).toEqual([
      ['grp', '1', true, 'Group inbox'],
      ['acc-1', '1', false, undefined],
    ]);
  });

  it('a null filter skips that account without a query', async () => {
    answerMail({ 'acc-1': { mailboxes: [], emails: [] } });
    const result = await searchAccountEmails('me@a.example', { filter: () => null, limit: 10, at: { gen: 4, accountId: 'acc-1' } });
    expect(result).toEqual({ emails: [], hasMore: false });
    expect(mockRequest.mock.calls.map((c) => (c[0] as Call[])[0][0])).toEqual(['Mailbox/get']);
  });

  it('never sends on a newer connection than the scope', async () => {
    answerMail({ 'acc-1': { mailboxes: [], emails: [] } });
    client.connectionGen = 5;
    await searchAccountEmails('me@a.example', { filter: () => ({ text: 'x' }), limit: 10, at: { gen: 4, accountId: 'acc-1' } });
    expect(optsOf(0)).toEqual({ gen: 4 });
  });

  it('binds the live client to the connection it started on for an account read without a scope', async () => {
    // The live client serves `me@a.example` but it is not the shown account.
    answerMail({ 'acc-1': { mailboxes: [], emails: [] } });
    await searchAccountEmails('me@a.example', { filter: () => ({ text: 'x' }), limit: 10 });
    expect(mockRequest.mock.calls.length).toBeGreaterThan(0);
    expect(mockRequest.mock.calls.every((c) => (c[2] as { gen?: number } | undefined)?.gen === 4)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('searchAccountEmails folder lists (final review M8)', () => {
  const folderNames: string[][] = [];
  beforeEach(() => {
    folderNames.length = 0;
    let mailboxes = [{ id: 'in', name: 'Inbox', role: 'inbox' }];
    mockRequest.mockImplementation(async (calls: Call[]) => {
      const [name] = calls[0];
      if (name === 'Mailbox/get') {
        const list = mailboxes;
        // A folder created after the first read.
        mailboxes = [...mailboxes, { id: 'new', name: 'Projects', role: null as unknown as string }];
        return { methodResponses: [['Mailbox/get', { list }, '0']] };
      }
      return { methodResponses: [['Email/query', { ids: [], total: 0 }, '0'], ['Email/get', { list: [] }, '1']] };
    });
  });
  const search = () => searchAccountEmails('me@a.example', {
    filter: (mailboxes) => { folderNames.push(mailboxes.map((m) => m.name)); return { text: 'x' }; },
    limit: 10,
    at: { gen: 4, accountId: 'acc-1' },
  });

  it('re-reads the folders of an account after a Mailbox change, so a new folder is seen', async () => {
    await search();
    await search();
    // Cached between the two.
    expect(folderNames).toEqual([['Inbox'], ['Inbox']]);

    invalidateUnifiedMailboxes('me@a.example');
    await search();
    expect(folderNames[2]).toEqual(['Inbox', 'Projects']);
  });
});

describe('searchContacts', () => {
  it('asks each contacts account for one page of text matches on the scope', async () => {
    session.primaryAccounts = { 'urn:ietf:params:jmap:contacts': 'acc-1' };
    session.accounts = {
      'acc-1': { name: 'me', isPersonal: true },
      owner: { name: 'Owner', isPersonal: false },
    };
    mockRequest.mockImplementation(async (calls: Call[]) => {
      const accountId = calls[0][1].accountId as string;
      return {
        methodResponses: [
          ['ContactCard/query', { ids: ['1'], total: 9 }, '0'],
          ['ContactCard/get', { list: [{ id: '1', name: { full: `Bob ${accountId}` }, addressBookIds: { b: true } }] }, '1'],
        ],
      };
    });
    const cards = await searchContacts('bob', 5, { gen: 4, accountId: 'acc-1' });
    expect(callsOf(0)[0]).toEqual(['ContactCard/query', { accountId: 'acc-1', filter: { text: 'bob' }, limit: 5 }, '0']);
    expect(callsOf(0)[1]).toEqual(['ContactCard/get', {
      accountId: 'acc-1', '#ids': { resultOf: '0', name: 'ContactCard/query', path: '/ids' },
    }, '1']);
    expect(optsOf(0)).toEqual({ gen: 4 });
    expect(optsOf(1)).toEqual({ gen: 4 });
    expect(cards.map((c) => [c.id, c.originalId, c.accountId, c.isShared])).toEqual([
      ['1', undefined, undefined, undefined],
      ['owner:1', '1', 'owner', true],
    ]);
    expect(cards[1].addressBookIds).toEqual({ 'owner:b': true });
  });

  it('a failing shared account is skipped, a failing own account throws', async () => {
    session.accounts = { 'acc-1': { name: 'me', isPersonal: true }, owner: { name: 'Owner', isPersonal: false } };
    mockRequest.mockImplementation(async (calls: Call[]) => (calls[0][1].accountId === 'owner'
      ? { methodResponses: [['error', { type: 'forbidden' }, '0']] }
      : { methodResponses: [['ContactCard/query', { ids: [] }, '0'], ['ContactCard/get', { list: [] }, '1']] }));
    await expect(searchContacts('bob', 5, { gen: 4, accountId: 'acc-1' })).resolves.toEqual([]);
    mockRequest.mockResolvedValue({ methodResponses: [['error', { type: 'serverFail' }, '0']] });
    await expect(searchContacts('bob', 5, { gen: 4, accountId: 'acc-1' })).rejects.toThrow('serverFail');
  });
});

// ---------------------------------------------------------------------------

describe('searchEventsAcrossAccounts', () => {
  it('queries text and day bounds newest first, own and shared calendars, on the scope', async () => {
    session.accounts = {
      'acc-1': { name: 'me', isPersonal: true },
      grp: { name: 'Team', isPersonal: false, accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} } },
    };
    mockRequest.mockImplementation(async (calls: Call[]) => ({
      methodResponses: [
        ['CalendarEvent/query', { ids: ['1'] }, '0'],
        ['CalendarEvent/get', { list: [{ id: '1', title: `Sync ${calls[0][1].accountId}`, calendarIds: {} }] }, '1'],
      ],
    }));
    const events = await searchEventsAcrossAccounts(
      { text: 'sync', after: '2026-01-01T00:00:00', before: '2026-02-01T23:59:59' }, 10, { gen: 4, accountId: 'acc-1' },
    );
    const [query, get] = callsOf(0);
    expect(query[0]).toBe('CalendarEvent/query');
    expect(query[1]).toMatchObject({
      accountId: 'acc-1',
      filter: { text: 'sync', after: '2026-01-01T00:00:00', before: '2026-02-01T23:59:59' },
      sort: [{ property: 'start', isAscending: false }],
      limit: 10,
    });
    expect(get[1]).toMatchObject({ accountId: 'acc-1', '#ids': { resultOf: '0', name: 'CalendarEvent/query', path: '/ids' } });
    expect(optsOf(0)).toEqual({ gen: 4 });
    expect(callsOf(1)[0][1]).toMatchObject({ accountId: 'grp' });
    expect(events.map((e) => [e.id, e.accountId, e.isShared, e.title])).toEqual([
      ['1', undefined, undefined, 'Sync acc-1'],
      ['1', 'grp', true, 'Sync grp'],
    ]);
  });

  it('leaves an absent bound out of the filter', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['CalendarEvent/query', { ids: [] }, '0'], ['CalendarEvent/get', { list: [] }, '1']],
    });
    await searchEventsAcrossAccounts({ text: 'sync' }, 10, { gen: 4, accountId: 'acc-1' });
    expect(callsOf(0)[0][1].filter).toEqual({ text: 'sync' });
  });
});

// ---------------------------------------------------------------------------

describe('file listing for search', () => {
  const listing = (name: string) => ({
    methodResponses: [['FileNode/get', { list: [{ id: '1', name, type: 't', blobId: 'b', parentId: null }] }, '0']],
  });

  it('caches the listing per account for a minute, on the scope connection', async () => {
    vi.useFakeTimers();
    mockRequest.mockResolvedValue(listing('a.txt'));
    const at = { gen: 4, accountId: 'acc-1' };
    expect(peekFileListing('login-a')).toBeNull();
    const first = await getFileListing('login-a', at);
    expect(first.map((n) => n.name)).toEqual(['a.txt']);
    expect(optsOf(0)).toEqual({ gen: 4 });
    expect(peekFileListing('login-a')?.map((n) => n.name)).toEqual(['a.txt']);
    await getFileListing('login-a', at);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    // Another account never reads it.
    expect(peekFileListing('login-b')).toBeNull();
    vi.advanceTimersByTime(FILE_LISTING_TTL_MS + 1);
    await getFileListing('login-a', at);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('a new connection does not reuse the listing', async () => {
    mockRequest.mockResolvedValue(listing('a.txt'));
    await getFileListing('login-a', { gen: 4, accountId: 'acc-1' });
    client.connectionGen = 5;
    expect(peekFileListing('login-a')).toBeNull();
    await getFileListing('login-a', { gen: 5, accountId: 'acc-1' });
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('a file mutation drops the cached listing', async () => {
    mockRequest.mockResolvedValue(listing('a.txt'));
    await getFileListing('login-a', { gen: 4, accountId: 'acc-1' });
    mockRequest.mockResolvedValueOnce({ methodResponses: [['FileNode/set', { updated: { 1: null } }, '0']] });
    await renameFileNode('1', 'b.txt');
    expect(peekFileListing('login-a')).toBeNull();

    await getFileListing('login-a', { gen: 4, accountId: 'acc-1' });
    mockRequest.mockResolvedValueOnce({ methodResponses: [['error', { type: 'forbidden' }, '0']] });
    await expect(deleteFileNodes(['1'])).rejects.toThrow();
    // Even a refused one: part of it may have gone through.
    expect(peekFileListing('login-a')).toBeNull();
  });

  it('does not cache a failed listing', async () => {
    mockRequest.mockRejectedValueOnce(new Error('boom'));
    await expect(getFileListing('login-a', { gen: 4, accountId: 'acc-1' })).rejects.toThrow('boom');
    mockRequest.mockResolvedValue(listing('a.txt'));
    expect(await getFileListing('login-a', { gen: 4, accountId: 'acc-1' })).toHaveLength(1);
  });
});
