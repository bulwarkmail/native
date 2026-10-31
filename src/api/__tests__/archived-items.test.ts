import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'ci',
    request: vi.fn(),
    currentSession: null as unknown,
    getMaxObjectsInGet: () => 500,
    getMaxObjectsInSet: () => 500,
    getMaxCallsInRequest: () => 16,
  },
}));

import { jmapClient } from '../jmap-client';
import { jmapErrorType } from '../jmap-result';
import {
  LOGIN_SWITCHED,
  advertisesArchivedItems,
  hasArchivedEmail,
  listArchivedEmails,
  queryArchivedItemIds,
  resetArchiveFilterMemory,
  restoreArchivedItems,
} from '../archived-items';
import { ACCOUNT, LICENSE_REFUSAL, archivedEmail, bigArchive, fakeArchiveServer } from '../../lib/recovery/__tests__/fixtures';

// Ported from the webmail's lib/__tests__/jmap-archived-items.test.ts.

type Call = [string, Record<string, unknown>, string];
const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

function setSession(stalwart: boolean) {
  (jmapClient as { currentSession: unknown }).currentSession = {
    capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:mail': {} },
    accounts: {
      [ACCOUNT]: {
        name: 'org-alice@example.org', isPersonal: true, isReadOnly: false,
        accountCapabilities: stalwart
          ? { 'urn:ietf:params:jmap:mail': {}, 'urn:stalwart:jmap': {} }
          : { 'urn:ietf:params:jmap:mail': {} },
      },
    },
  };
}

function serve(answer: (body: { methodCalls: Call[] }) => unknown) {
  mockRequest.mockImplementation(async (methodCalls: Call[]) => answer({ methodCalls }));
}

const sent = () => mockRequest.mock.calls.map(([calls, using]) => ({ calls: calls as Call[], using: using as string[] }));
const queries = () => sent().flatMap((b) => b.calls).filter(([m]) => m === 'x:ArchivedItem/query');

beforeEach(() => {
  vi.clearAllMocks();
  resetArchiveFilterMemory();
  setSession(true);
});

describe('archived items API', () => {
  it('advertises them only where the account lists urn:stalwart:jmap', () => {
    expect(advertisesArchivedItems()).toBe(true);
    setSession(false);
    expect(advertisesArchivedItems()).toBe(false);
    // Session-level only (never how Stalwart sends it) doesn't count either.
    (jmapClient as { currentSession: unknown }).currentSession = {
      capabilities: { 'urn:stalwart:jmap': {} },
      accounts: { [ACCOUNT]: { name: 'a', isPersonal: true, isReadOnly: false, accountCapabilities: {} } },
    };
    expect(advertisesArchivedItems()).toBe(false);
  });

  it('asks the account filter first and, once refused, never again for that account', async () => {
    serve(fakeArchiveServer([archivedEmail('a')]).answer);
    await expect(queryArchivedItemIds(ACCOUNT, { limit: 1 })).resolves.toEqual({ ids: ['a'], total: null });
    await queryArchivedItemIds(ACCOUNT, { limit: 1 });
    expect(queries().map(([, args]) => args)).toEqual([
      { accountId: ACCOUNT, limit: 1, filter: { accountId: ACCOUNT } },
      { accountId: ACCOUNT, limit: 1 },
      { accountId: ACCOUNT, limit: 1 },
    ]);
    expect(sent()[0].using).toEqual(['urn:ietf:params:jmap:core', 'urn:stalwart:jmap']);
  });

  it("keeps an admin's answer to the account through the filter, and drops other accounts' items anyway", async () => {
    serve(fakeArchiveServer([
      archivedEmail('i3'),
      archivedEmail('i2', { accountId: 'cz' }),
      archivedEmail('i1', { accountId: undefined }),
    ], { impersonate: true }).answer);
    const result = await listArchivedEmails(ACCOUNT, { days: 0 });
    expect(result.items.map((i) => i.id)).toEqual(['i3']);
    expect(queries().every(([, args]) => (args.filter as { accountId?: string })?.accountId === ACCOUNT)).toBe(true);
  });

  it('throws the refusal with its type when the server has no license', async () => {
    serve(() => ({ methodResponses: [['error', LICENSE_REFUSAL, 'q']] }));
    const error = await queryArchivedItemIds(ACCOUNT).catch((e: unknown) => e);
    expect(jmapErrorType(error)).toBe('forbidden');
  });

  it('pages with calculateTotal, so the newest of more than 5000 items comes first', async () => {
    serve(fakeArchiveServer(bigArchive(6000, Date.now())).answer);
    const first = await listArchivedEmails(ACCOUNT, { days: 0 });
    expect(first.items[0].id).toBe('i006000');
    expect(first.nextPosition).toBe(2000);
    const pages = queries().filter(([, args]) => args.calculateTotal && !args.filter);
    expect(pages.map(([, args]) => [args.position ?? 0, args.limit])).toEqual([[0, 500], [500, 500], [1000, 500], [1500, 500]]);
    const gets = sent().flatMap((b) => b.calls).filter(([m]) => m === 'x:ArchivedItem/get');
    expect(gets.every(([, args]) => (args.ids as string[]).length <= 500 && args.accountId === ACCOUNT)).toBe(true);
    const older = await listArchivedEmails(ACCOUNT, { days: 0, startPosition: 2000 });
    expect(older.items[0].id).toBe('i004000');
  });

  it('checks for the Trash link with one-item pages and stops at the first message', async () => {
    serve(fakeArchiveServer(bigArchive(30, Date.now())).answer);
    await expect(hasArchivedEmail(ACCOUNT, { days: 7 })).resolves.toBe(true);
    expect(queries().filter(([, args]) => args.calculateTotal && !args.filter).map(([, args]) => args.limit)).toEqual([1]);
  });

  it('restores with requestRestore in the account it was asked for and reports notFound per item', async () => {
    const server = fakeArchiveServer([archivedEmail('a')]);
    serve(server.answer);
    const results = await restoreArchivedItems(['a', 'b'], ACCOUNT);
    expect(results).toEqual([{ id: 'a', ok: true }, { id: 'b', ok: false, error: 'notFound', type: 'notFound' }]);
    expect(sent()[0].calls).toEqual([
      ['x:ArchivedItem/set', { accountId: ACCOUNT, update: { a: { status: 'requestRestore' }, b: { status: 'requestRestore' } } }, 'r0'],
    ]);
    expect(server.remaining()).toEqual([]);
  });

  it('fails every item of a request that fails instead of throwing', async () => {
    mockRequest.mockRejectedValue(new Error('offline'));
    await expect(restoreArchivedItems(['a'], ACCOUNT)).resolves.toEqual([{ id: 'a', ok: false, error: 'offline' }]);
  });

  it('sends nothing once the login it was opened in is no longer active', async () => {
    serve(fakeArchiveServer([archivedEmail('a')]).answer);
    const results = await restoreArchivedItems(['a'], ACCOUNT, () => false);
    expect(results).toEqual([{ id: 'a', ok: false, error: LOGIN_SWITCHED }]);
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
