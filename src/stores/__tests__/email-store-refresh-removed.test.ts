import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A refresh re-queries the list and puts the page on screen. Deleting mails
// in quick succession overlaps those refreshes: the query of one can reach
// the server before the next delete does, and its page still carries that
// mail. The delete had already dropped the row, so landing the page put it
// back until the next refresh (webmail #966). Rows that left the list while
// the query was out must stay gone.

vi.mock('../../api/email', () => ({
  getMailboxesWithState: vi.fn(async () => ({ list: [], state: 'mb-state-0' })),
  getSharedMailboxes: vi.fn(async () => []),
  queryEmailPage: vi.fn(),
  queryEmailPagesAcrossAccounts: vi.fn(),
  getEmailListDelta: vi.fn(),
  getEmailsWithState: vi.fn(async () => ({ list: [], state: 'em-state-0' })),
  getEmailChanges: vi.fn(async () => null),
  getThreads: vi.fn(async () => []),
  setEmailMailboxes: vi.fn(),
  patchKeywordsForEmails: vi.fn(),
  destroyEmails: vi.fn(),
  deleteEmail: vi.fn(async () => undefined),
  unprefixMailboxId: (id: string, accountId?: string) =>
    (accountId && id.startsWith(`${accountId}:`) ? id.slice(accountId.length + 1) : id),
}));

vi.mock('../locale-store', () => ({
  t: (_key: string, fallback?: string) => fallback ?? _key,
  useLocaleStore: { getState: () => ({ locale: 'en', t: (_k: string, f?: string) => f ?? _k }) },
}));

// Online, nothing queued: run the store's online path.
vi.mock('../outbox-store', () => {
  const applyOrQueueBatch = async (_ops: unknown[], onlineRun?: (at: { gen: number; accountId: string }) => Promise<void>) => {
    // The scope the real outbox hands over: the connection, own account.
    if (onlineRun) await onlineRun({ gen: 0, accountId: 'acc-1' });
    return { queued: false };
  };
  return {
    applyOrQueueBatch,
    applyOrQueue: async (op: unknown, onlineRun?: (at: { gen: number; accountId: string }) => Promise<void>) => applyOrQueueBatch([op], onlineRun),
    useOutboxStore: {
      getState: () => ({
        entries: [],
        count: () => 0,
        setAccount: vi.fn(async () => undefined),
        flush: vi.fn(async () => undefined),
      }),
    },
  };
});

vi.mock('../settings-store', () => {
  const settings: Record<string, unknown> = { emailsPerPage: 25, mailSortAscending: false };
  return {
    useSettingsStore: {
      getState: () => ({
        ...settings,
        updateSetting: (key: string, value: unknown) => { settings[key] = value; },
      }),
    },
  };
});

vi.mock('../offline-cache-store', () => ({
  useOfflineCacheStore: {
    getState: () => ({
      hydrated: true,
      hydrate: vi.fn(),
      setAccount: vi.fn(async () => undefined),
      totalCount: () => 0,
      getEmailsInMailbox: vi.fn(async () => []),
      has: () => false,
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      patch: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }),
  },
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    isConnected: true,
    accountId: 'acc-1',
    username: 'test@example.com',
    serverUrl: 'https://mail.example.com',
    currentSession: { apiUrl: 'https://mail.example.com/jmap/' },
    getMaxObjectsInGet: () => 500,
    getMaxCallsInRequest: () => 16,
    getSharedMailAccounts: () => [{ id: 'grp-1', name: 'Support' }],
    // The keyword-sort polarity probe: unsupportedSort keeps the plain sort.
    request: vi.fn(async () => ({ methodResponses: [['error', { type: 'unsupportedSort' }, 'asc']] })),
  },
}));

import { generateAccountId } from '../../lib/account-utils';
import * as emailApi from '../../api/email';
import { useEmailStore } from '../email-store';
import { registerServedAccount } from './helpers/served-account';
import type { Email } from '../../api/types';

// The mocked client serves this account; the store checks that before acting.
beforeEach(() => {
  registerServedAccount('test@example.com', 'https://mail.example.com');
});

const TEST_ACCOUNT_ID = generateAccountId('test@example.com', 'https://mail.example.com');
const mockQueryEmailPage = emailApi.queryEmailPage as ReturnType<typeof vi.fn>;
const mockQueryAcross = emailApi.queryEmailPagesAcrossAccounts as ReturnType<typeof vi.fn>;
const mockListDelta = emailApi.getEmailListDelta as ReturnType<typeof vi.fn>;

const mail = (id: string, jmapAccountId?: string): Email => ({
  id,
  threadId: `t-${id}`,
  mailboxIds: { 'mb-1': true },
  keywords: { $seen: true },
  receivedAt: '2026-09-01T10:00:00Z',
  subject: `mail ${id}`,
  size: 1,
  hasAttachment: false,
  ...(jmapAccountId ? { jmapAccountId } : {}),
} as Email);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const page = (list: Email[], total: number) => ({ ids: list.map((e) => e.id), list, total, queryState: 'q-2', state: 'em-2', threads: [] });

/** What deleteEmail / moveToMailbox do once the server took the change. */
function dropRow(id: string) {
  useEmailStore.setState((s) => ({ emails: s.emails.filter((e) => e.id !== id) }));
}

const ids = () => useEmailStore.getState().emails.map((e) => e.id);

beforeEach(() => {
  vi.clearAllMocks();
  useEmailStore.getState().reset();
  useEmailStore.setState({ activeAccountId: TEST_ACCOUNT_ID, currentMailboxId: 'mb-1', searchQuery: '', filters: {} });
});

describe('refreshEmails with rows removed while the query was out (#966)', () => {
  it('folder: a mail deleted during the refresh does not come back from its stale page', async () => {
    useEmailStore.setState({ emails: [mail('a'), mail('b'), mail('c')], totalEmails: 3 });
    const res = deferred<unknown>();
    mockQueryEmailPage.mockReturnValue(res.promise);

    const refresh = useEmailStore.getState().refreshEmails();
    await vi.waitFor(() => expect(mockQueryEmailPage).toHaveBeenCalled());
    // The server answered before b's move landed (d had just arrived); the
    // move then completes.
    dropRow('b');
    res.resolve(page([mail('d'), mail('a'), mail('b'), mail('c')], 4));
    await refresh;

    expect(ids()).toEqual(['d', 'a', 'c']);
    expect(useEmailStore.getState().totalEmails).toBe(3);
    // The folder's snapshot holds what is shown.
    expect(useEmailStore.getState().mailboxSnapshots['mb-1'].emails.map((e) => e.id)).toEqual(['d', 'a', 'c']);
    expect(useEmailStore.getState().mailboxSnapshots['mb-1'].total).toBe(3);
  });

  it('folder: a mail moved to the trash through deleteEmail stays gone', async () => {
    useEmailStore.setState({ emails: [mail('a'), mail('b'), mail('c')], totalEmails: 3 });
    const res = deferred<unknown>();
    mockQueryEmailPage.mockReturnValue(res.promise);

    const refresh = useEmailStore.getState().refreshEmails();
    await vi.waitFor(() => expect(mockQueryEmailPage).toHaveBeenCalled());
    await useEmailStore.getState().deleteEmail('b', 'trash', 'mb-1');
    expect(ids()).toEqual(['a', 'c']);
    res.resolve(page([mail('a'), mail('b'), mail('c')], 3));
    await refresh;

    expect(ids()).toEqual(['a', 'c']);
    expect(useEmailStore.getState().totalEmails).toBe(2);
  });

  it('folder: a refresh started after the removal shows the row if the server lists it', async () => {
    // E.g. the mail was moved back: only rows that left during THIS query are held back.
    useEmailStore.setState({ emails: [mail('a'), mail('c')], totalEmails: 2 });
    mockQueryEmailPage.mockResolvedValue(page([mail('a'), mail('b'), mail('c')], 3));

    await useEmailStore.getState().refreshEmails();

    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(useEmailStore.getState().totalEmails).toBe(3);
  });

  it('filtered view: the removed row stays gone and the total never drops below 0', async () => {
    useEmailStore.setState({ emails: [mail('a')], totalEmails: 1, filters: { isUnread: true } });
    const res = deferred<unknown>();
    mockQueryEmailPage.mockReturnValue(res.promise);

    const refresh = useEmailStore.getState().refreshEmails();
    await vi.waitFor(() => expect(mockQueryEmailPage).toHaveBeenCalled());
    dropRow('a');
    // A server total already short of the page (counted after the move).
    res.resolve(page([mail('a')], 0));
    await refresh;

    expect(ids()).toEqual([]);
    expect(useEmailStore.getState().totalEmails).toBe(0);
  });

  it('incremental: a row the delta still carries stays gone', async () => {
    const base = [mail('a'), mail('b'), mail('c')];
    useEmailStore.setState({
      emails: base,
      totalEmails: 3,
      emailStates: { 'mb-1': 'em-1' },
      mailboxSnapshots: { 'mb-1': { emails: base, total: 3, queryState: 'q-1' } },
    });
    const res = deferred<unknown>();
    mockListDelta.mockReturnValue(res.promise);

    const refresh = useEmailStore.getState().refreshEmails();
    await vi.waitFor(() => expect(mockListDelta).toHaveBeenCalled());
    dropRow('b');
    // d arrived; the server had not seen b's move yet.
    res.resolve({
      queryChanges: { oldQueryState: 'q-1', newQueryState: 'q-2', total: 4, removed: [], added: [{ id: 'd', index: 0 }] },
      changes: { oldState: 'em-1', newState: 'em-2', hasMoreChanges: false, created: [], updated: [], destroyed: [] },
      added: [mail('d')],
      addedFetched: true,
      threads: [],
    });
    await refresh;

    expect(ids()).toEqual(['d', 'a', 'c']);
    expect(useEmailStore.getState().totalEmails).toBe(3);
    expect(useEmailStore.getState().mailboxSnapshots['mb-1'].emails.map((e) => e.id)).toEqual(['d', 'a', 'c']);
    expect(useEmailStore.getState().mailboxSnapshots['mb-1'].total).toBe(3);
  });

  it('All folders: only the removed row goes, not another account\'s row with the same id', async () => {
    // Ids repeat across accounts: rows are told apart by their row key.
    useEmailStore.setState({
      filters: { folder: 'all' },
      emails: [mail('a', 'acc-1'), mail('b', 'acc-1'), mail('b', 'grp-1')],
      totalEmails: 3,
    });
    const res = deferred<unknown>();
    mockQueryAcross.mockReturnValue(res.promise);

    const refresh = useEmailStore.getState().refreshEmails();
    await vi.waitFor(() => expect(mockQueryAcross).toHaveBeenCalled());
    useEmailStore.setState((s) => ({
      emails: s.emails.filter((e) => !(e.id === 'b' && e.jmapAccountId === 'acc-1')),
    }));
    res.resolve([
      { accountId: undefined, ok: true, total: 2, list: [mail('a'), mail('b')], threads: [] },
      { accountId: 'grp-1', ok: true, total: 1, list: [mail('b')], threads: [] },
    ]);
    await refresh;

    expect(useEmailStore.getState().emails.map((e) => `${e.jmapAccountId}:${e.id}`).sort())
      .toEqual(['acc-1:a', 'grp-1:b']);
    expect(useEmailStore.getState().totalEmails).toBe(2);
  });
});

// Rows held in place by an "unread first" order (just read) were spliced back
// in after the server reported them gone from the folder: moved or deleted
// elsewhere, they stayed on screen as ghosts (final review I2).
describe('incremental refresh with held rows the server reports gone', () => {
  beforeEach(async () => {
    const { useSettingsStore } = await import('../settings-store');
    useSettingsStore.getState().updateSetting('messageListOrder', [{ criterion: 'unread', direction: 'desc' }]);
    useSettingsStore.getState().updateSetting('messageListOrderScope', 'all');
    const base = [mail('a'), mail('b'), mail('c')];
    useEmailStore.setState({
      emails: base,
      totalEmails: 3,
      retainedIds: ['a'],
      emailStates: { 'mb-1': 'em-1' },
      mailboxSnapshots: { 'mb-1': { emails: base, total: 3, queryState: 'q-1' } },
    });
  });
  afterEach(async () => {
    const { useSettingsStore } = await import('../settings-store');
    useSettingsStore.getState().updateSetting('messageListOrder', []);
    useSettingsStore.getState().updateSetting('messageListOrderScope', 'inbox');
  });

  const delta = (removed: string[], destroyed: string[], added: Array<{ id: string; index: number }> = []) => ({
    queryChanges: { oldQueryState: 'q-1', newQueryState: 'q-2', total: 3 - removed.length + added.length, removed, added },
    changes: { oldState: 'em-1', newState: 'em-2', hasMoreChanges: false, created: [], updated: [], destroyed },
    added: added.map((a) => mail(a.id)),
    addedFetched: true,
    threads: [],
  });

  it('drops a held row the query reports removed', async () => {
    mockListDelta.mockResolvedValue(delta(['a'], []));
    await useEmailStore.getState().refreshEmails();

    expect(ids()).toEqual(['b', 'c']);
    expect(useEmailStore.getState().retainedIds).toEqual([]);
  });

  it('drops a held row the server reports destroyed', async () => {
    mockListDelta.mockResolvedValue(delta([], ['a']));
    await useEmailStore.getState().refreshEmails();

    expect(ids()).toEqual(['b', 'c']);
    expect(useEmailStore.getState().retainedIds).toEqual([]);
  });

  it('keeps a held row the query re-adds lower down where it was', async () => {
    mockListDelta.mockResolvedValue(delta(['a'], [], [{ id: 'a', index: 2 }]));
    await useEmailStore.getState().refreshEmails();

    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(useEmailStore.getState().retainedIds).toEqual(['a']);
  });
});
