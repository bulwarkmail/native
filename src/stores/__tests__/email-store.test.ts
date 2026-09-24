import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/email', () => ({
  getMailboxes: vi.fn(),
  // New helpers used by the incremental-sync path. Default behavior: behave
  // like a first-ever load — no prior state, full re-query expected.
  getMailboxesWithState: vi.fn(async () => ({ list: [], state: 'mb-state-0' })),
  getSharedMailboxes: vi.fn(async () => []),
  getMailboxesByIds: vi.fn(async () => ({ list: [], state: 'mb-state-0' })),
  getMailboxChanges: vi.fn(async () => null),
  queryEmails: vi.fn(),
  // A list page: Email/query, Email/get and Thread/get in one request.
  // beforeEach scripts it from the queryEmails / getEmailsWithState mocks.
  queryEmailPage: vi.fn(),
  // "All folders": one page per account; beforeEach runs each through
  // queryEmailPage.
  queryEmailPagesAcrossAccounts: vi.fn(),
  getEmailQueryChanges: vi.fn(async () => null),
  getEmails: vi.fn(),
  getEmailsWithState: vi.fn(async () => ({ list: [], state: 'em-state-0' })),
  getEmailChanges: vi.fn(async () => null),
  getThreads: vi.fn(async () => []),
  getFullEmail: vi.fn(),
  importEmailBlob: vi.fn(async () => 'imported-1'),
  patchKeywordsForEmails: vi.fn(),
  patchKeywordsPerEmail: vi.fn(),
  moveEmail: vi.fn(),
  moveEmails: vi.fn(),
  archiveEmails: vi.fn(),
  restoreEmailMailboxes: vi.fn(),
  setEmailMailboxes: vi.fn(),
  destroyEmails: vi.fn(),
  deleteEmail: vi.fn(),
  deleteEmails: vi.fn(),
  searchEmails: vi.fn(),
  markAsSpam: vi.fn(),
  undoSpam: vi.fn(),
  unprefixMailboxId: (id: string, accountId?: string) =>
    (accountId && id.startsWith(`${accountId}:`) ? id.slice(accountId.length + 1) : id),
}));

// locale-store pulls in expo-localization / react-native I18nManager; the
// store only needs t() for toast labels.
vi.mock('../../api/blob', () => ({
  uploadBytes: vi.fn(async () => ({ blobId: 'blob-new', size: 3, type: 'message/rfc822' })),
}));

vi.mock('../locale-store', () => ({
  t: (_key: string, fallback?: string) => fallback ?? _key,
  useLocaleStore: { getState: () => ({ locale: 'en', t: (_k: string, f?: string) => f ?? _k }) },
}));

// The mutations now route through the offline outbox. In tests we want the
// "online, nothing queued" fast path: run the supplied online runner (or the
// op's primitive) immediately so the existing api-call assertions still hold,
// without pulling in network-store / NetInfo.
vi.mock('../outbox-store', async () => {
  const api = await import('../../api/email') as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const runOp = async (op: { kind: string; emailId: string; accountId?: string; patch?: unknown; mailboxIds?: unknown }) => {
    if (op.kind === 'keywords') return api.patchKeywordsForEmails([op.emailId], op.patch, op.accountId);
    if (op.kind === 'mailboxes') return api.setEmailMailboxes(op.emailId, op.mailboxIds, op.accountId);
    if (op.kind === 'destroy') return api.destroyEmails([op.emailId], op.accountId);
  };
  const applyOrQueueBatch = async (ops: any[], onlineRun?: () => Promise<void>) => {
    if (onlineRun) await onlineRun();
    else await Promise.all(ops.map(runOp));
    return { queued: false };
  };
  return {
    applyOrQueueBatch,
    applyOrQueue: async (op: any, onlineRun?: () => Promise<void>) => applyOrQueueBatch([op], onlineRun),
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

// settings-store transitively pulls in jmap-client / expo-secure-store, which
// trip on react-native's Flow-typed entrypoint under vitest. The store only
// reads a handful of scalar settings, so a minimal stateful stub is enough.
vi.mock('../settings-store', () => {
  const settings: Record<string, unknown> = {
    archiveMode: 'single',
    emailsPerPage: 25,
    mailSortAscending: false,
  };
  return {
    useSettingsStore: {
      getState: () => ({
        ...settings,
        updateSetting: (key: string, value: unknown) => {
          settings[key] = value;
        },
      }),
    },
  };
});

// offline-cache-store is touched by selectMailbox (cache-seed fallback),
// getEmailDetail (best-effort body refresh), and setActiveAccount (account
// switch). Stub it as an empty cache so tests don't need to set up
// AsyncStorage.
vi.mock('../offline-cache-store', () => ({
  useOfflineCacheStore: {
    getState: () => ({
      activeAccountId: null,
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

// email-store now early-returns from fetch actions unless jmapClient is
// connected AND serving the same logical account the store has active
// (`generateAccountId(username, serverUrl) === activeAccountId`). The
// tests exercise those actions, so present a fully connected stub plus
// the matching username/serverUrl pair. beforeEach() syncs the store's
// activeAccountId to the id these credentials produce.
vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    isConnected: true,
    accountId: 'acc-1',
    username: 'test@example.com',
    serverUrl: 'https://mail.example.com',
    currentSession: { apiUrl: 'https://mail.example.com/jmap/' },
    // refreshEmails / loadMoreEmails chunk by this value when fetching ids.
    getMaxObjectsInGet: () => 500,
    getMaxCallsInRequest: () => 16,
    getSharedMailAccounts: () => [{ id: 'grp-1', name: 'Support' }],
    fetchBlobArrayBuffer: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
    // The keyword-sort polarity probe runs through this; answering
    // unsupportedSort keeps the sort at the plain receivedAt comparator the
    // assertions below expect.
    request: vi.fn(async () => ({ methodResponses: [['error', { type: 'unsupportedSort' }, 'asc']] })),
  },
}));

import { generateAccountId } from '../../lib/account-utils';
const TEST_ACCOUNT_ID = generateAccountId('test@example.com', 'https://mail.example.com');

import * as emailApi from '../../api/email';
import { useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';

const mockGetMailboxesWithState = emailApi.getMailboxesWithState as ReturnType<typeof vi.fn>;
const mockGetSharedMailboxes = emailApi.getSharedMailboxes as ReturnType<typeof vi.fn>;
const mockQueryEmails = emailApi.queryEmails as ReturnType<typeof vi.fn>;
const mockQueryEmailPage = emailApi.queryEmailPage as ReturnType<typeof vi.fn>;
const mockQueryAcross = emailApi.queryEmailPagesAcrossAccounts as ReturnType<typeof vi.fn>;
const mockGetThreads = emailApi.getThreads as ReturnType<typeof vi.fn>;
const mockGetEmailQueryChanges = emailApi.getEmailQueryChanges as ReturnType<typeof vi.fn>;
const mockGetEmails = emailApi.getEmails as ReturnType<typeof vi.fn>;
const mockGetEmailsWithState = emailApi.getEmailsWithState as ReturnType<typeof vi.fn>;
const mockGetFullEmail = emailApi.getFullEmail as ReturnType<typeof vi.fn>;
const mockPatchKeywords = emailApi.patchKeywordsForEmails as ReturnType<typeof vi.fn>;
const mockMoveEmail = emailApi.moveEmail as ReturnType<typeof vi.fn>;
const mockDeleteEmail = emailApi.deleteEmail as ReturnType<typeof vi.fn>;
const mockSearchEmails = emailApi.searchEmails as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  useEmailStore.getState().reset();
  // Wire the store's active account to the one the mocked jmapClient is
  // serving, so the guard inside fetchMailboxes / refreshEmails / etc.
  // doesn't short-circuit the tests.
  useEmailStore.setState({ activeAccountId: TEST_ACCOUNT_ID });
  useSettingsStore.getState().updateSetting('mailSortAscending', false);
  // Most tests describe a list page as its query and its Email/get; the
  // chained-request tests below script queryEmailPage directly.
  mockQueryEmailPage.mockImplementation(async (mailboxId: string | undefined, opts?: { accountId?: string }) => {
    const query = await emailApi.queryEmails(mailboxId, opts);
    const got = query.ids.length > 0
      ? await emailApi.getEmailsWithState(query.ids, opts?.accountId)
      : { list: [], state: 'em-state-0' };
    return { ...query, list: got.list, state: got.state, threads: [] };
  });
  mockQueryAcross.mockImplementation(async (
    targets: Array<{ accountId?: string; position: number; sort: unknown }>,
    opts: Record<string, unknown>,
  ) => Promise.all(targets.map(async (target) => {
    const page = await emailApi.queryEmailPage(undefined, {
      ...opts, position: target.position, sort: target.sort as never, accountId: target.accountId,
    });
    return { accountId: target.accountId, ok: true, total: page.total, list: page.list, threads: page.threads };
  })));
});

describe('email-store', () => {
  describe('fetchMailboxes', () => {
    it('should load mailboxes', async () => {
      const mailboxes = [
        { id: 'mb-1', name: 'Inbox', role: 'inbox' },
        { id: 'mb-2', name: 'Sent', role: 'sent' },
      ];
      mockGetMailboxesWithState.mockResolvedValue({ list: mailboxes, state: 'mb-state-1' });

      await useEmailStore.getState().fetchMailboxes();

      expect(useEmailStore.getState().mailboxes).toEqual(mailboxes);
    });

    it('should set error on failure', async () => {
      mockGetMailboxesWithState.mockRejectedValue(new Error('Network error'));

      await useEmailStore.getState().fetchMailboxes();

      expect(useEmailStore.getState().error).toBe('Network error');
    });
  });

  describe('selectMailbox', () => {
    it('should query and fetch emails for mailbox', async () => {
      mockQueryEmails.mockResolvedValue({ ids: ['e1', 'e2'], total: 2, queryState: 'q-1' });
      const emails = [
        { id: 'e1', subject: 'Email 1' },
        { id: 'e2', subject: 'Email 2' },
      ];
      mockGetEmailsWithState.mockResolvedValue({ list: emails, state: 'em-state-1' });

      await useEmailStore.getState().selectMailbox('mb-1');

      const state = useEmailStore.getState();
      expect(state.currentMailboxId).toBe('mb-1');
      expect(state.emails).toEqual(emails);
      expect(state.totalEmails).toBe(2);
      expect(state.loading).toBe(false);
    });

    it('should handle empty mailbox', async () => {
      mockQueryEmails.mockResolvedValue({ ids: [], total: 0, queryState: 'q-empty' });

      await useEmailStore.getState().selectMailbox('mb-empty');

      expect(useEmailStore.getState().emails).toEqual([]);
      // The page's chained Email/get still reports the folder's Email state.
      expect(useEmailStore.getState().emailStates).toEqual({ 'mb-empty': 'em-state-0' });
      expect(mockGetEmails).not.toHaveBeenCalled();
    });

    it('drops the search and browses the folder with "clear search when switching folders"', async () => {
      useSettingsStore.getState().updateSetting('clearSearchOnFolderChange', true);
      try {
        useEmailStore.setState({
          currentMailboxId: 'mb-1',
          mailboxes: [
            { id: 'mb-1', name: 'Inbox', isShared: false } as any,
            { id: 'mb-2', name: 'Receipts', isShared: false } as any,
          ],
          searchQuery: 'invoice',
          filters: { isUnread: true },
          emails: [{ id: 'hit' } as any],
        });
        mockQueryEmails.mockResolvedValue({ ids: [], total: 0, queryState: 'q' });

        await useEmailStore.getState().selectMailbox('mb-2');

        const state = useEmailStore.getState();
        expect(state.searchQuery).toBe('');
        expect(state.filters).toEqual({});
        // The search hits neither stay on screen nor become Inbox's snapshot.
        expect(state.emails).toEqual([]);
        expect(state.mailboxSnapshots['mb-1']).toBeUndefined();
        expect(mockQueryEmails.mock.calls[0][0]).toBe('mb-2');
        expect(mockQueryEmails.mock.calls[0][1].filter).toBeUndefined();
      } finally {
        useSettingsStore.getState().updateSetting('clearSearchOnFolderChange', false);
      }
    });
  });

  describe('loadMoreEmails', () => {
    it('should append batch to existing emails', async () => {
      // Set up state with initial load
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        emails: [{ id: 'e1' } as any],
        totalEmails: 2,
        loading: false,
      });

      mockQueryEmailPage.mockResolvedValue({
        ids: ['e2'], total: 2, list: [{ id: 'e2', subject: 'Email 2' }], threads: [],
      });

      await useEmailStore.getState().loadMoreEmails();

      expect(useEmailStore.getState().emails).toHaveLength(2);
    });

    it('should not load if already at total', async () => {
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        emails: [{ id: 'e1' } as any, { id: 'e2' } as any],
        totalEmails: 2,
        loading: false,
      });

      await useEmailStore.getState().loadMoreEmails();

      expect(mockQueryEmails).not.toHaveBeenCalled();
    });

    // B20: a row read in the Unread view stays on screen but has left the
    // server's result, so it must not count towards the next page's position.
    it('pages from the server position, not counting rows kept after they stopped matching', async () => {
      // e1 was just read (markRead keeps it in retainedIds).
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        filters: { isUnread: true },
        retainedIds: ['e1'],
        emails: [{ id: 'e1', keywords: { $seen: true } } as any, { id: 'e2', keywords: {} } as any, { id: 'e3', keywords: {} } as any],
        totalEmails: 10,
        loading: false,
      });
      mockQueryEmailPage.mockResolvedValue({
        ids: ['e4', 'e5'], total: 9, list: [{ id: 'e4' }, { id: 'e5' }], threads: [],
      });

      await useEmailStore.getState().loadMoreEmails();

      expect(mockQueryEmailPage).toHaveBeenCalledWith('mb-1', expect.objectContaining({
        position: 2,
        filter: { notKeyword: '$seen' },
      }));
      const state = useEmailStore.getState();
      expect(state.emails.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
      expect(state.totalEmails).toBe(9);
    });

    it('keeps loading when kept rows make the list look complete', async () => {
      // After a refresh: e2..e4 are the query's first page of 4, and e1 is
      // the row read earlier, kept in place.
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        filters: { isUnread: true },
        retainedIds: ['e1'],
        emails: ['e1', 'e2', 'e3', 'e4'].map((id) => ({ id, keywords: {} }) as any),
        totalEmails: 4,
        loading: false,
      });
      mockQueryEmailPage.mockResolvedValue({ ids: ['e5'], total: 4, list: [{ id: 'e5' }], threads: [] });

      await useEmailStore.getState().loadMoreEmails();

      expect(mockQueryEmailPage).toHaveBeenCalledWith('mb-1', expect.objectContaining({ position: 3 }));
      expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    });
  });

  describe('markRead', () => {
    it('should update keywords and optimistically update state', async () => {
      useEmailStore.setState({
        emails: [{ id: 'e1', keywords: {} } as any],
      });
      mockPatchKeywords.mockResolvedValue(undefined);

      await useEmailStore.getState().markRead('e1');

      expect(mockPatchKeywords).toHaveBeenCalledWith(['e1'], { $seen: true }, undefined);
      expect(useEmailStore.getState().emails[0].keywords.$seen).toBe(true);
    });
  });

  describe('markUnread', () => {
    it('should remove $seen keyword', async () => {
      useEmailStore.setState({
        emails: [{ id: 'e1', keywords: { $seen: true, $flagged: true } } as any],
      });
      mockPatchKeywords.mockResolvedValue(undefined);

      await useEmailStore.getState().markUnread('e1');

      expect(mockPatchKeywords).toHaveBeenCalledWith(['e1'], { $seen: null }, undefined);
      expect(useEmailStore.getState().emails[0].keywords).toEqual({ $flagged: true });
    });
  });

  describe('toggleStar', () => {
    it('should add $flagged keyword', async () => {
      useEmailStore.setState({
        emails: [{ id: 'e1', keywords: { $seen: true } } as any],
      });
      mockPatchKeywords.mockResolvedValue(undefined);

      await useEmailStore.getState().toggleStar('e1', true);

      expect(mockPatchKeywords).toHaveBeenCalledWith(['e1'], { $flagged: true }, undefined);
      expect(useEmailStore.getState().emails[0].keywords.$flagged).toBe(true);
    });

    it('should remove $flagged keyword', async () => {
      useEmailStore.setState({
        emails: [{ id: 'e1', keywords: { $seen: true, $flagged: true } } as any],
      });
      mockPatchKeywords.mockResolvedValue(undefined);

      await useEmailStore.getState().toggleStar('e1', false);

      expect(mockPatchKeywords).toHaveBeenCalledWith(['e1'], { $flagged: null }, undefined);
      expect(useEmailStore.getState().emails[0].keywords.$flagged).toBeUndefined();
    });
  });

  describe('moveToMailbox', () => {
    it('should move and remove from list', async () => {
      useEmailStore.setState({
        emails: [{ id: 'e1' } as any, { id: 'e2' } as any],
      });
      mockMoveEmail.mockResolvedValue(undefined);

      await useEmailStore.getState().moveToMailbox('e1', 'inbox', 'archive');

      expect(mockMoveEmail).toHaveBeenCalledWith('e1', 'inbox', 'archive', undefined);
      expect(useEmailStore.getState().emails).toHaveLength(1);
      expect(useEmailStore.getState().emails[0].id).toBe('e2');
    });
  });

  describe('deleteEmail', () => {
    it('should delete and remove from list', async () => {
      useEmailStore.setState({
        emails: [{ id: 'e1' } as any],
      });
      mockDeleteEmail.mockResolvedValue(undefined);

      await useEmailStore.getState().deleteEmail('e1', 'trash', 'inbox');

      expect(useEmailStore.getState().emails).toHaveLength(0);
    });
  });

  describe('searchEmails', () => {
    it('should search and return full email objects', async () => {
      mockSearchEmails.mockResolvedValue(['e1']);
      mockGetEmails.mockResolvedValue([{ id: 'e1', subject: 'Found' }]);

      const results = await useEmailStore.getState().searchEmails('test');

      expect(results).toEqual([{ id: 'e1', subject: 'Found' }]);
    });

    it('should return empty array for no results', async () => {
      mockSearchEmails.mockResolvedValue([]);

      const results = await useEmailStore.getState().searchEmails('nothing');

      expect(results).toEqual([]);
    });
  });

  // Issue #6: the "Unread" tri-state filter must reach Email/query as a
  // notKeyword condition and force the full re-query path (the incremental
  // path only serves the unfiltered base view).
  describe('filters (issue #6)', () => {
    it('applies the unread filter to the mailbox query', async () => {
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        emails: [],
        totalEmails: 0,
        searchQuery: '',
        filters: { isUnread: true },
        mailboxSnapshots: {
          'mb-1': { emails: [{ id: 'e9' } as any], total: 1, queryState: 'q-base' },
        },
      });
      mockQueryEmails.mockResolvedValue({ ids: ['e1'], total: 1, queryState: 'q-unread' });
      mockGetEmailsWithState.mockResolvedValue({ list: [{ id: 'e1' } as any], state: 'em-1' });

      await useEmailStore.getState().refreshEmails();

      expect(mockGetEmailQueryChanges).not.toHaveBeenCalled();
      const [mailboxId, opts] = mockQueryEmails.mock.calls[0];
      expect(mailboxId).toBe('mb-1');
      // The folder scope travels as the first argument (queryEmails adds the
      // inMailbox condition); the user filter is passed on its own.
      expect(opts.filter).toEqual({ notKeyword: '$seen' });
      // Filter results must not leak into the base-view snapshot.
      expect(useEmailStore.getState().mailboxSnapshots['mb-1'].emails).toEqual([{ id: 'e9' }]);
    });
  });

  // Issue #5: the sort-order toggle. Flipping it must drop every cached
  // snapshot / queryState (they belong to the old sort order) and re-query
  // with the new direction; the incremental queryChanges path must carry the
  // same sort as the query that produced its queryState.
  describe('sort order (issue #5)', () => {
    it('setSortAscending clears cached query state and re-queries ascending', async () => {
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        emails: [{ id: 'e1' } as any],
        totalEmails: 1,
        queryState: 'q-desc',
        mailboxSnapshots: {
          'mb-1': { emails: [{ id: 'e1' } as any], total: 1, queryState: 'q-desc' },
        },
        accountSnapshots: {
          'other-acc': {
            mailboxes: [],
            emailStates: {},
            currentMailboxId: null,
            mailboxSnapshots: { 'mb-9': { emails: [], total: 0, queryState: 'q-9' } },
          } as any,
        },
      });
      mockQueryEmails.mockResolvedValue({ ids: ['e1'], total: 1, queryState: 'q-asc' });
      mockGetEmailsWithState.mockResolvedValue({ list: [{ id: 'e1' } as any], state: 'em-1' });

      useEmailStore.getState().setSortAscending(true);

      // Synchronous invalidation: old-order caches are gone everywhere,
      // including accounts that are tucked away.
      expect(useEmailStore.getState().queryState).toBeUndefined();
      expect(useEmailStore.getState().mailboxSnapshots).toEqual({});
      expect(useEmailStore.getState().accountSnapshots['other-acc'].mailboxSnapshots).toEqual({});

      await vi.waitFor(() => expect(mockQueryEmails).toHaveBeenCalled());
      const [, opts] = mockQueryEmails.mock.calls[0];
      expect(opts.sort).toEqual([{ property: 'receivedAt', isAscending: true }]);
      // With the snapshot's queryState gone the incremental path must not run.
      expect(mockGetEmailQueryChanges).not.toHaveBeenCalled();
    });

    it('is a no-op when the direction is unchanged', () => {
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        mailboxSnapshots: { 'mb-1': { emails: [], total: 0, queryState: 'q-base' } },
      });

      useEmailStore.getState().setSortAscending(false);

      expect(useEmailStore.getState().mailboxSnapshots['mb-1']).toBeDefined();
      expect(mockQueryEmails).not.toHaveBeenCalled();
    });

    it('incremental refresh passes the active sort to Email/queryChanges', async () => {
      useSettingsStore.getState().updateSetting('mailSortAscending', true);
      const base = [{ id: 'e1' } as any];
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        emails: base,
        totalEmails: 1,
        searchQuery: '',
        filters: {},
        emailStates: { 'mb-1': 'em-1' },
        mailboxSnapshots: { 'mb-1': { emails: base, total: 1, queryState: 'q-asc' } },
      });
      mockGetEmailQueryChanges.mockResolvedValue({
        oldQueryState: 'q-asc',
        newQueryState: 'q-asc-2',
        total: 1,
        removed: [],
        added: [],
      });

      await useEmailStore.getState().refreshEmails();

      const [, , opts] = mockGetEmailQueryChanges.mock.calls[0];
      expect(opts.sort).toEqual([{ property: 'receivedAt', isAscending: true }]);
      expect(mockQueryEmails).not.toHaveBeenCalled();
    });
  });

  // Issue #10: after searching, the inbox stayed stuck on the search results.
  // Root cause: the incremental Email/queryChanges refresh diffed against the
  // on-screen list (search results) instead of the cached base view, then
  // wrote the result back into the persisted mailbox snapshot.
  describe('search / return to inbox (issue #10)', () => {
    const base = [
      { id: 'e1', subject: 'One' } as any,
      { id: 'e2', subject: 'Two' } as any,
    ];

    it('incremental refresh diffs against the snapshot, not on-screen search results', async () => {
      // Screen still shows a (stale) search-result list, but searchQuery is
      // already '' — the cold-start / just-cleared-search shape.
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        emails: [base[1]],
        totalEmails: 1,
        searchQuery: '',
        filters: {},
        emailStates: { 'mb-1': 'em-1' },
        mailboxSnapshots: { 'mb-1': { emails: base, total: 2, queryState: 'q-base' } },
      });
      mockGetEmailQueryChanges.mockResolvedValue({
        oldQueryState: 'q-base',
        newQueryState: 'q-2',
        total: 2,
        removed: [],
        added: [],
      });

      await useEmailStore.getState().refreshEmails();

      const state = useEmailStore.getState();
      expect(state.emails).toEqual(base);
      expect(state.mailboxSnapshots['mb-1'].emails).toEqual(base);
      expect(mockQueryEmails).not.toHaveBeenCalled();
    });

    it('does not write search results into the mailbox snapshot', async () => {
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        emails: base,
        totalEmails: 2,
        searchQuery: 'two',
        filters: {},
        queryState: 'q-base',
        mailboxSnapshots: { 'mb-1': { emails: base, total: 2, queryState: 'q-base' } },
      });
      mockQueryEmails.mockResolvedValue({ ids: ['e2'], total: 1, queryState: 'q-search' });
      mockGetEmailsWithState.mockResolvedValue({ list: [base[1]], state: 'em-1' });

      await useEmailStore.getState().refreshEmails();

      const state = useEmailStore.getState();
      // An "All folders" hit carries the account it came from (#1082).
      expect(state.emails).toEqual([{ ...base[1], jmapAccountId: 'acc-1' }]);
      // Base-view cache must survive the search untouched.
      expect(state.mailboxSnapshots['mb-1'].emails).toEqual(base);
      expect(state.queryState).toBe('q-base');
      expect(mockGetEmailQueryChanges).not.toHaveBeenCalled();
    });

    it('clearSearchAndFilters restores the cached base view immediately', () => {
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        emails: [base[1]],
        totalEmails: 1,
        searchQuery: 'two',
        filters: {},
        mailboxSnapshots: { 'mb-1': { emails: base, total: 2, queryState: 'q-base' } },
      });
      mockGetEmailQueryChanges.mockResolvedValue({
        oldQueryState: 'q-base',
        newQueryState: 'q-2',
        total: 2,
        removed: [],
        added: [],
      });

      useEmailStore.getState().clearSearchAndFilters();

      // Synchronously back on the base view — no waiting for the network.
      const state = useEmailStore.getState();
      expect(state.searchQuery).toBe('');
      expect(state.emails).toEqual(base);
      expect(state.totalEmails).toBe(2);
    });

    it('falls back to a full re-query when the snapshot window is incomplete', async () => {
      // A pre-fix install could have a poisoned snapshot: a handful of search
      // results stored against the base view's total. It can't be patched
      // incrementally — the refresh must rebuild it from the server.
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        emails: [base[1]],
        totalEmails: 1,
        searchQuery: '',
        filters: {},
        mailboxSnapshots: { 'mb-1': { emails: [base[1]], total: 50, queryState: 'q-base' } },
      });
      mockQueryEmails.mockResolvedValue({ ids: ['e1', 'e2'], total: 50, queryState: 'q-new' });
      mockGetEmailsWithState.mockResolvedValue({ list: base, state: 'em-2' });

      await useEmailStore.getState().refreshEmails();

      const state = useEmailStore.getState();
      expect(mockGetEmailQueryChanges).not.toHaveBeenCalled();
      expect(state.emails).toEqual(base);
      expect(state.mailboxSnapshots['mb-1'].emails).toEqual(base);
      expect(state.mailboxSnapshots['mb-1'].queryState).toBe('q-new');
    });
  });

  describe('getEmailDetail', () => {
    it('should fetch full email', async () => {
      const fullEmail = { id: 'e1', subject: 'Test', bodyValues: { html: { value: '<p>Hi</p>' } } };
      mockGetFullEmail.mockResolvedValue(fullEmail);

      const result = await useEmailStore.getState().getEmailDetail('e1');

      expect(result).toEqual(fullEmail);
    });
  });

  // ── Search scope (#788), tag view, keeping the search across folders (#553)
  describe('search scope', () => {
    it('searches every folder by default when a text query is active (#788)', async () => {
      useEmailStore.setState({ currentMailboxId: 'mb-1', searchQuery: 'invoice', filters: {} });
      mockQueryEmails.mockResolvedValue({ ids: [], total: 0, queryState: 'q' });

      await useEmailStore.getState().refreshEmails();

      const [mailboxId, opts] = mockQueryEmails.mock.calls[0];
      expect(mailboxId).toBeUndefined();
      expect(opts.filter).toEqual({ text: 'invoice*' });
    });

    it('scopes a search to the open folder or a picked folder when asked', async () => {
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        mailboxes: [
          { id: 'mb-1', name: 'Inbox', isShared: false } as any,
          { id: 'mb-2', name: 'Receipts', isShared: false } as any,
        ],
        searchQuery: 'invoice',
        filters: { folder: 'current' },
      });
      mockQueryEmails.mockResolvedValue({ ids: [], total: 0, queryState: 'q' });
      await useEmailStore.getState().refreshEmails();
      expect(mockQueryEmails.mock.calls[0][0]).toBe('mb-1');

      useEmailStore.setState({ filters: { folder: 'mb-2' } });
      await useEmailStore.getState().refreshEmails();
      expect(mockQueryEmails.mock.calls[1][0]).toBe('mb-2');
    });

    it('a tag view queries hasKeyword across all folders', async () => {
      useEmailStore.setState({ currentMailboxId: 'mb-1', searchQuery: '', filters: { keyword: '$label:work' } });
      mockQueryEmails.mockResolvedValue({ ids: [], total: 0, queryState: 'q' });

      await useEmailStore.getState().refreshEmails();

      const [mailboxId, opts] = mockQueryEmails.mock.calls[0];
      expect(mailboxId).toBeUndefined();
      expect(opts.filter).toEqual({ hasKeyword: '$label:work' });
    });

    it('keeps the search when switching folders (#553)', async () => {
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        mailboxes: [
          { id: 'mb-1', name: 'Inbox', isShared: false } as any,
          { id: 'mb-2', name: 'Receipts', isShared: false } as any,
        ],
        searchQuery: 'invoice',
        filters: { folder: 'current' },
        emails: [{ id: 'hit' } as any],
      });
      mockQueryEmails.mockResolvedValue({ ids: [], total: 0, queryState: 'q' });

      await useEmailStore.getState().selectMailbox('mb-2');

      expect(useEmailStore.getState().searchQuery).toBe('invoice');
      expect(mockQueryEmails.mock.calls[0][0]).toBe('mb-2');
      expect(mockQueryEmails.mock.calls[0][1].filter).toEqual({ text: 'invoice*' });
    });
  });

  describe('list hygiene', () => {
    it('load-more drops ids that are already on screen', async () => {
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        emails: [{ id: 'e1' } as any, { id: 'e2' } as any],
        totalEmails: 10,
      });
      mockQueryEmailPage.mockResolvedValue({
        ids: ['e2', 'e3'], total: 10, list: [{ id: 'e2' }, { id: 'e3' }], threads: [],
      });

      await useEmailStore.getState().loadMoreEmails();

      expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    });

    it('drains Email/changes while hasMoreChanges is set', async () => {
      const mockGetEmailChanges = emailApi.getEmailChanges as ReturnType<typeof vi.fn>;
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        emails: [{ id: 'e1', keywords: {} } as any],
        totalEmails: 1,
        queryState: 'q-1',
        emailStates: { 'mb-1': 'em-1' },
        mailboxSnapshots: { 'mb-1': { emails: [{ id: 'e1', keywords: {} } as any], total: 1, queryState: 'q-1' } },
      });
      mockGetEmailQueryChanges.mockResolvedValue({
        oldQueryState: 'q-1', newQueryState: 'q-2', total: 1, removed: [], added: [],
      });
      mockGetEmailChanges
        .mockResolvedValueOnce({ oldState: 'em-1', newState: 'em-2', hasMoreChanges: true, created: [], updated: ['e1'], destroyed: [] })
        .mockResolvedValueOnce({ oldState: 'em-2', newState: 'em-3', hasMoreChanges: false, created: [], updated: [], destroyed: [] });
      mockGetEmailsWithState.mockResolvedValue({ list: [{ id: 'e1', keywords: { $seen: true } }], state: 'em-3' });

      await useEmailStore.getState().refreshEmails();

      expect(mockGetEmailChanges).toHaveBeenCalledTimes(2);
      expect(mockGetEmailChanges.mock.calls[1][0]).toBe('em-2');
      expect(useEmailStore.getState().emailStates['mb-1']).toBe('em-3');
      expect(useEmailStore.getState().emails[0].keywords).toEqual({ $seen: true });
    });

    it('keeps a just-read row in an open Unread view until it is re-opened', async () => {
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        filters: { isUnread: true },
        emails: [{ id: 'e1', keywords: {} } as any, { id: 'e2', keywords: {} } as any],
        totalEmails: 2,
      });
      await useEmailStore.getState().markRead('e1');
      expect(useEmailStore.getState().retainedIds).toEqual(['e1']);

      mockQueryEmails.mockResolvedValue({ ids: ['e2'], total: 1, queryState: 'q' });
      mockGetEmailsWithState.mockResolvedValue({ list: [{ id: 'e2', keywords: {} }], state: 's' });
      await useEmailStore.getState().refreshEmails();
      expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['e1', 'e2']);

      // Re-opening the view (new filters) forgets the retained rows.
      useEmailStore.getState().setFilters({ isUnread: true });
      expect(useEmailStore.getState().retainedIds).toEqual([]);
    });

    it('coalesces overlapping refreshes into one run plus one re-run', async () => {
      useEmailStore.setState({ currentMailboxId: 'mb-1' });
      mockGetEmailQueryChanges.mockResolvedValue(null);
      let resolveQuery: (v: unknown) => void = () => {};
      mockQueryEmails.mockImplementationOnce(() => new Promise((r) => { resolveQuery = r; }));
      mockQueryEmails.mockResolvedValue({ ids: [], total: 0, queryState: 'q' });

      const first = useEmailStore.getState().refreshEmails();
      const second = useEmailStore.getState().refreshEmails();
      const third = useEmailStore.getState().refreshEmails();
      expect(second).toBe(first);
      expect(third).toBe(first);
      // The sort is resolved asynchronously before Email/query runs.
      await new Promise((r) => setTimeout(r, 0));
      resolveQuery({ ids: [], total: 0, queryState: 'q' });
      await first;
      await new Promise((r) => setTimeout(r, 0));

      expect(mockQueryEmails).toHaveBeenCalledTimes(2);
    });
  });

  // A keyword change must reach the server as `keywords/<name>` pointers:
  // sending the list's keyword map replaced the server's and erased stars and
  // tags the list didn't know about (audit B4).
  describe('keyword changes send only the keywords they change', () => {
    it('marks a message outside the loaded list read without touching its other keywords', async () => {
      useEmailStore.setState({ emails: [] });

      await useEmailStore.getState().markRead('e9', 'grp-1');
      await useEmailStore.getState().markRead('e8');

      expect(mockPatchKeywords).toHaveBeenNthCalledWith(1, ['e9'], { $seen: true }, 'grp-1');
      expect(mockPatchKeywords).toHaveBeenNthCalledWith(2, ['e8'], { $seen: true }, undefined);
    });

    it('stars from a stale list row by sending $flagged alone, keeping keywords that changed meanwhile', async () => {
      useEmailStore.setState({ emails: [{ id: 'e1', keywords: { $notjunk: true, $seen: true } } as any] });
      // The list refreshes while the request is in flight and picks up a tag
      // another client added.
      mockPatchKeywords.mockImplementationOnce(async () => {
        useEmailStore.setState({ emails: [{ id: 'e1', keywords: { $notjunk: true, $seen: true, '$label:work': true } } as any] });
      });

      await useEmailStore.getState().toggleStar('e1', true);

      expect(mockPatchKeywords).toHaveBeenCalledTimes(1);
      expect(mockPatchKeywords).toHaveBeenCalledWith(['e1'], { $flagged: true }, undefined);
      expect(useEmailStore.getState().emails[0].keywords).toEqual({
        $notjunk: true, $seen: true, '$label:work': true, $flagged: true,
      });
    });

    it('tags and untags a selection with one patch naming only that tag', async () => {
      useEmailStore.setState({
        emails: [
          { id: 'e1', keywords: { $seen: true } } as any,
          { id: 'e2', keywords: { $flagged: true, '$label:work': true } } as any,
        ],
      });

      await useEmailStore.getState().setKeywordForEmails(['e1', 'e2'], '$label:work', true);
      expect(mockPatchKeywords).toHaveBeenLastCalledWith(['e1', 'e2'], { '$label:work': true }, undefined);
      expect(useEmailStore.getState().emails.map((e) => e.keywords)).toEqual([
        { $seen: true, '$label:work': true },
        { $flagged: true, '$label:work': true },
      ]);

      await useEmailStore.getState().setKeywordForEmails(['e2'], '$label:work', false);
      expect(mockPatchKeywords).toHaveBeenLastCalledWith(['e2'], { '$label:work': null }, undefined);
      expect(useEmailStore.getState().emails[1].keywords).toEqual({ $flagged: true });
    });

    it('batch delete with trash-and-read marks only the unread messages read with a $seen patch', async () => {
      useSettingsStore.getState().updateSetting('deleteAction', 'trash-and-read');
      useEmailStore.setState({
        mailboxes: [
          { id: 'mb-1', name: 'Inbox', role: 'inbox', isShared: false } as any,
          { id: 'mb-trash', name: 'Trash', role: 'trash', isShared: false } as any,
        ],
        currentMailboxId: 'mb-1',
        emails: [
          { id: 'e1', keywords: { $flagged: true }, mailboxIds: { 'mb-1': true } } as any,
          { id: 'e2', keywords: { $seen: true }, mailboxIds: { 'mb-1': true } } as any,
        ],
      });

      await useEmailStore.getState().deleteEmailsBatch(['e1', 'e2'], 'mb-trash', 'mb-1');

      expect(mockPatchKeywords).toHaveBeenCalledTimes(1);
      expect(mockPatchKeywords).toHaveBeenCalledWith(['e1'], { $seen: true }, undefined);
      useSettingsStore.getState().updateSetting('deleteAction', 'trash');
    });
  });

  describe('bulk keyword actions', () => {
    const three = () => [
      { id: 'e1', keywords: {} } as any,
      { id: 'e2', keywords: { $flagged: true } } as any,
      { id: 'e3', keywords: { $seen: true, $flagged: true } } as any,
    ];

    it('marks a whole selection read with one patch instead of a request per message', async () => {
      useEmailStore.setState({ emails: three() });

      await useEmailStore.getState().setKeywordForEmails(['e1', 'e2', 'e3'], '$seen', true);

      expect(mockPatchKeywords).toHaveBeenCalledTimes(1);
      expect(mockPatchKeywords).toHaveBeenCalledWith(['e1', 'e2', 'e3'], { $seen: true }, undefined);
      expect(useEmailStore.getState().emails.map((e) => e.keywords)).toEqual([
        { $seen: true },
        { $flagged: true, $seen: true },
        { $seen: true, $flagged: true },
      ]);
    });

    it('keeps rows that leave the open Unread or Starred view, like the single actions', async () => {
      useEmailStore.setState({ emails: three(), filters: { isUnread: true } });
      await useEmailStore.getState().setKeywordForEmails(['e1', 'e2'], '$seen', true);
      expect(useEmailStore.getState().retainedIds).toEqual(['e1', 'e2']);

      useEmailStore.setState({ emails: three(), filters: { isStarred: true }, retainedIds: [] });
      await useEmailStore.getState().setKeywordForEmails(['e2', 'e3'], '$flagged', true);
      expect(useEmailStore.getState().retainedIds).toEqual([]);
      await useEmailStore.getState().setKeywordForEmails(['e2', 'e3'], '$flagged', false);
      expect(mockPatchKeywords).toHaveBeenLastCalledWith(['e2', 'e3'], { $flagged: null }, undefined);
      expect(useEmailStore.getState().retainedIds).toEqual(['e2', 'e3']);

      useEmailStore.setState({ emails: three(), filters: { isUnread: false }, retainedIds: [] });
      await useEmailStore.getState().setKeywordForEmails(['e3'], '$seen', false);
      expect(useEmailStore.getState().retainedIds).toEqual(['e3']);
    });
  });

  // B6: `inMailbox` is a mutable filter, so Stalwart's Email/queryChanges
  // reports every updated message as removed and re-added. Those rows used to
  // vanish until a pull-to-refresh, and visiting an empty folder dropped the
  // Email state that Email/changes needed.
  describe('delta refresh', () => {
    const mockGetEmailChanges = emailApi.getEmailChanges as ReturnType<typeof vi.fn>;
    const row = (id: string, keywords: Record<string, boolean> = {}) =>
      ({ id, keywords, mailboxIds: { 'mb-1': true } } as any);
    const inbox = [row('e1'), row('e2'), row('e3')];
    const noChanges = { oldState: 'em-1', newState: 'em-2', hasMoreChanges: false, created: [], updated: [], destroyed: [] };

    function openInbox(extra: Record<string, unknown> = {}) {
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        emails: inbox,
        totalEmails: 3,
        queryState: 'q-1',
        emailStates: { 'mb-1': 'em-1' },
        mailboxSnapshots: { 'mb-1': { emails: inbox, total: 3, queryState: 'q-1' } },
        ...extra,
      });
    }

    it('keeps a removed-and-re-added row at its new index with fresh keywords', async () => {
      openInbox();
      mockGetEmailQueryChanges.mockResolvedValue({
        oldQueryState: 'q-1', newQueryState: 'q-2', total: 3,
        removed: ['e2', 'e3'], added: [{ id: 'e3', index: 0 }, { id: 'e2', index: 2 }],
      });
      // Email/changes needn't list them: the queryChanges report is enough.
      mockGetEmailChanges.mockResolvedValue(noChanges);
      mockGetEmailsWithState.mockResolvedValue({
        list: [row('e3', { $flagged: true }), row('e2', { $seen: true })], state: 'em-2',
      });

      await useEmailStore.getState().refreshEmails();

      expect(mockGetEmailChanges).toHaveBeenCalledWith('em-1', undefined, undefined);
      expect(mockGetEmailsWithState).toHaveBeenCalledWith(['e3', 'e2'], undefined);
      expect(mockQueryEmails).not.toHaveBeenCalled();
      const state = useEmailStore.getState();
      expect(state.emails.map((e) => e.id)).toEqual(['e3', 'e1', 'e2']);
      expect(state.emails[0].keywords).toEqual({ $flagged: true });
      expect(state.emails[2].keywords).toEqual({ $seen: true });
      expect(state.mailboxSnapshots['mb-1'].emails.map((e) => e.id)).toEqual(['e3', 'e1', 'e2']);
      expect(state.emailStates['mb-1']).toBe('em-2');
    });

    it('does not duplicate a re-added row that Email/changes also reports', async () => {
      openInbox();
      mockGetEmailQueryChanges.mockResolvedValue({
        oldQueryState: 'q-1', newQueryState: 'q-2', total: 3,
        removed: ['e2'], added: [{ id: 'e2', index: 1 }],
      });
      mockGetEmailChanges.mockResolvedValue({ ...noChanges, updated: ['e2'] });
      mockGetEmailsWithState.mockResolvedValue({ list: [row('e2', { $flagged: true })], state: 'em-2' });

      await useEmailStore.getState().refreshEmails();

      expect(mockGetEmailsWithState).toHaveBeenCalledWith(['e2'], undefined);
      expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
      expect(useEmailStore.getState().emails[1].keywords).toEqual({ $flagged: true });
    });

    it('leaves an added row past the loaded window to load-more', async () => {
      openInbox({ totalEmails: 40, mailboxSnapshots: { 'mb-1': { emails: inbox, total: 40, queryState: 'q-1' } } });
      useSettingsStore.getState().updateSetting('emailsPerPage', 3);
      mockGetEmailQueryChanges.mockResolvedValue({
        oldQueryState: 'q-1', newQueryState: 'q-2', total: 40,
        removed: ['e3', 'e30'], added: [{ id: 'e30', index: 29 }],
      });
      mockGetEmailChanges.mockResolvedValue(noChanges);
      mockGetEmailsWithState.mockResolvedValue({ list: [row('e30', { $flagged: true })], state: 'em-2' });

      try {
        await useEmailStore.getState().refreshEmails();
      } finally {
        useSettingsStore.getState().updateSetting('emailsPerPage', 25);
      }

      // Not appended after e2: rows 2-28 would be skipped.
      expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['e1', 'e2']);
    });

    it('an empty folder keeps both its own and the other lists\' Email state', async () => {
      openInbox({ emailStates: { 'mb-1': 'em-1', 'mb-empty': 'em-0' } });
      // An empty result from a server that leaves `state` out of Email/get.
      mockQueryEmailPage.mockResolvedValueOnce({ ids: [], total: 0, queryState: 'q-empty', list: [], threads: [] });

      await useEmailStore.getState().selectMailbox('mb-empty');

      expect(useEmailStore.getState().emailStates).toEqual({ 'mb-1': 'em-1', 'mb-empty': 'em-0' });

      // Back in the Inbox, the refresh still runs Email/changes from the
      // Inbox's own state and patches the flagged row in place.
      mockGetEmailQueryChanges.mockResolvedValue({
        oldQueryState: 'q-1', newQueryState: 'q-2', total: 3,
        removed: ['e2'], added: [{ id: 'e2', index: 1 }],
      });
      mockGetEmailChanges.mockResolvedValue({ ...noChanges, updated: ['e2'] });
      mockGetEmailsWithState.mockResolvedValue({ list: [row('e2', { $flagged: true })], state: 'em-2' });

      await useEmailStore.getState().selectMailbox('mb-1');

      expect(mockGetEmailQueryChanges).toHaveBeenCalledWith('mb-1', 'q-1', expect.anything());
      expect(mockGetEmailChanges).toHaveBeenCalledWith('em-1', undefined, undefined);
      expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
      expect(useEmailStore.getState().emails[1].keywords).toEqual({ $flagged: true });
    });

    it('another folder\'s refresh does not move this list\'s baseline', async () => {
      openInbox();
      mockQueryEmails.mockResolvedValue({ ids: ['p1'], total: 1, queryState: 'q-p' });
      mockGetEmailsWithState.mockResolvedValue({ list: [row('p1')], state: 'em-9' });

      await useEmailStore.getState().selectMailbox('mb-2');

      expect(useEmailStore.getState().emailStates).toEqual({ 'mb-1': 'em-1', 'mb-2': 'em-9' });

      mockGetEmailQueryChanges.mockResolvedValue({
        oldQueryState: 'q-1', newQueryState: 'q-2', total: 3, removed: [], added: [],
      });
      mockGetEmailChanges.mockResolvedValue(noChanges);
      await useEmailStore.getState().selectMailbox('mb-1');

      expect(mockGetEmailChanges).toHaveBeenCalledWith('em-1', undefined, undefined);
    });

    it('re-queries a list that has no Email state of its own', async () => {
      openInbox({ emailStates: {} });
      mockQueryEmails.mockResolvedValue({ ids: ['e1'], total: 1, queryState: 'q-new' });
      mockGetEmailsWithState.mockResolvedValue({ list: [row('e1')], state: 'em-5' });

      await useEmailStore.getState().refreshEmails();

      expect(mockGetEmailQueryChanges).not.toHaveBeenCalled();
      expect(mockQueryEmails).toHaveBeenCalledWith('mb-1', expect.anything());
      expect(useEmailStore.getState().emailStates).toEqual({ 'mb-1': 'em-5' });
    });

    it('forgets the list state when Email/changes cannot calculate changes', async () => {
      openInbox();
      mockGetEmailQueryChanges.mockResolvedValue({
        oldQueryState: 'q-1', newQueryState: 'q-2', total: 3, removed: [], added: [],
      });
      mockGetEmailChanges.mockResolvedValue(null);

      await useEmailStore.getState().refreshEmails();

      expect(useEmailStore.getState().emailStates).toEqual({});
    });
  });

  // PF7: a list page or search used to be Email/query, then Email/get, then a
  // Thread/get the list screen fired after rendering.
  describe('list page requests', () => {
    const page = {
      ids: ['e1', 'e2'], total: 2, queryState: 'q-1', state: 'em-1',
      list: [{ id: 'e1', threadId: 't1', keywords: {} }, { id: 'e2', threadId: 't2', keywords: {} }],
      threads: [{ id: 't1', emailIds: ['e1', 'x1', 'x2'] }, { id: 't2', emailIds: ['e2'] }],
    };

    it('loads a folder page with its messages and thread sizes in one request', async () => {
      useEmailStore.setState({ currentMailboxId: 'mb-1' });
      mockQueryEmailPage.mockResolvedValueOnce(page);

      await useEmailStore.getState().refreshEmails();

      expect(mockQueryEmailPage).toHaveBeenCalledTimes(1);
      expect(mockQueryEmailPage).toHaveBeenCalledWith('mb-1', expect.objectContaining({ limit: 25, threads: true }));
      expect(mockQueryEmails).not.toHaveBeenCalled();
      expect(mockGetEmailsWithState).not.toHaveBeenCalled();
      expect(mockGetThreads).not.toHaveBeenCalled();
      const state = useEmailStore.getState();
      expect(state.emails.map((e) => e.id)).toEqual(['e1', 'e2']);
      expect(state.threadCounts).toEqual({ t1: 3, t2: 1 });
      expect(state.emailStates).toEqual({ 'mb-1': 'em-1' });
    });

    it('runs a search as the same single request', async () => {
      useEmailStore.setState({ currentMailboxId: 'mb-1' });
      mockQueryEmailPage.mockResolvedValue(page);

      useEmailStore.getState().setSearchQuery('invoice');
      // "All folders" rows and their threads are scoped by account (#1082).
      await vi.waitFor(() => expect(useEmailStore.getState().threadCounts).toEqual({ 'acc-1:t1': 3, 'acc-1:t2': 1 }));

      expect(mockQueryAcross).toHaveBeenCalledTimes(1);
      expect(mockQueryAcross.mock.calls[0][1]).toMatchObject({ filter: { text: 'invoice*' }, threads: true });
      expect(mockQueryEmailPage).toHaveBeenCalledTimes(1);
      expect(mockGetThreads).not.toHaveBeenCalled();
    });

    it('leaves Thread/get out when threading is off', async () => {
      useSettingsStore.getState().updateSetting('disableThreading', true);
      try {
        useEmailStore.setState({ currentMailboxId: 'mb-1' });
        mockQueryEmailPage.mockResolvedValueOnce({ ...page, threads: [] });

        await useEmailStore.getState().refreshEmails();

        expect(mockQueryEmailPage).toHaveBeenCalledWith('mb-1', expect.objectContaining({ threads: false }));
      } finally {
        useSettingsStore.getState().updateSetting('disableThreading', false);
      }
    });

    it('load-more adds the next page\'s thread sizes', async () => {
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        emails: [{ id: 'e0', threadId: 't0' } as any],
        totalEmails: 3,
        threadCounts: { t0: 2 },
      });
      mockQueryEmailPage.mockResolvedValueOnce({ ...page, total: 3 });

      await useEmailStore.getState().loadMoreEmails();

      expect(mockQueryEmailPage).toHaveBeenCalledWith('mb-1', expect.objectContaining({ position: 1, threads: true }));
      expect(mockGetThreads).not.toHaveBeenCalled();
      expect(useEmailStore.getState().threadCounts).toEqual({ t0: 2, t1: 3, t2: 1 });
    });

    it('fetches the thread sizes an incremental refresh has none for', async () => {
      const mockGetEmailChanges = emailApi.getEmailChanges as ReturnType<typeof vi.fn>;
      const rows = page.list as any[];
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        emails: rows,
        totalEmails: 2,
        queryState: 'q-1',
        emailStates: { 'mb-1': 'em-1' },
        threadCounts: { t1: 3 },
        mailboxSnapshots: { 'mb-1': { emails: rows, total: 2, queryState: 'q-1' } },
      });
      mockGetEmailQueryChanges.mockResolvedValue({
        oldQueryState: 'q-1', newQueryState: 'q-2', total: 2, removed: [], added: [],
      });
      mockGetEmailChanges.mockResolvedValue({
        oldState: 'em-1', newState: 'em-2', hasMoreChanges: false, created: [], updated: [], destroyed: [],
      });
      mockGetThreads.mockResolvedValueOnce([{ id: 't2', emailIds: ['e2', 'x3'] }]);

      await useEmailStore.getState().refreshEmails();

      await vi.waitFor(() => expect(useEmailStore.getState().threadCounts).toEqual({ t1: 3, t2: 2 }));
      expect(mockGetThreads).toHaveBeenCalledWith(['t2'], undefined);
      expect(mockQueryEmailPage).not.toHaveBeenCalled();
    });

    it('drops the thread sizes when another folder opens', async () => {
      useEmailStore.setState({ currentMailboxId: 'mb-1', threadCounts: { t1: 3 } });
      mockQueryEmailPage.mockResolvedValueOnce({ ids: [], total: 0, list: [], threads: [] });

      await useEmailStore.getState().selectMailbox('mb-2');

      expect(useEmailStore.getState().threadCounts).toEqual({});
    });
  });

  describe('pin and spam keywords', () => {
    it('togglePin writes $pinned, not $important', async () => {
      useEmailStore.setState({ emails: [{ id: 'e1', keywords: {} } as any] });
      await useEmailStore.getState().togglePin('e1', true);
      expect(mockPatchKeywords).toHaveBeenCalledWith(['e1'], { $pinned: true }, undefined);
      await useEmailStore.getState().togglePin('e1', false);
      expect(mockPatchKeywords).toHaveBeenLastCalledWith(['e1'], { $pinned: null }, undefined);
    });

    const RIGHTS = {} as any;
    const inbox = { id: 'mb-1', name: 'Inbox', role: 'inbox', myRights: RIGHTS, isShared: false } as any;
    const junk = { id: 'mb-junk', name: 'Junk', role: 'junk', myRights: RIGHTS, isShared: false } as any;

    it('markSpam files into Junk flipping $junk/$notjunk and offers an undo that restores keywords', async () => {
      const mockMarkAsSpam = emailApi.markAsSpam as ReturnType<typeof vi.fn>;
      const mockRestore = emailApi.restoreEmailMailboxes as ReturnType<typeof vi.fn>;
      const mockPatchPerEmail = emailApi.patchKeywordsPerEmail as ReturnType<typeof vi.fn>;
      useSettingsStore.getState().updateSetting('deleteAction', 'trash-and-read');
      useEmailStore.setState({
        mailboxes: [inbox, junk],
        currentMailboxId: 'mb-1',
        emails: [{ id: 'e1', keywords: { $notjunk: true }, mailboxIds: { 'mb-1': true } } as any],
      });

      await useEmailStore.getState().markSpam(['e1']);

      expect(mockMarkAsSpam).toHaveBeenCalledWith(['e1'], 'mb-junk', undefined, { markRead: true });
      expect(useEmailStore.getState().emails).toHaveLength(0);
      const undo = useEmailStore.getState().pendingUndo!;
      expect(undo.kind).toBe('spam');
      expect(undo.items[0].originalKeywords).toEqual({ $notjunk: true });

      await useEmailStore.getState().undoLast();
      expect(mockRestore).toHaveBeenCalledWith([{ id: 'e1', mailboxIds: { 'mb-1': true } }], undefined);
      // Only the keywords the spam action touched go back; `$seen` was set by
      // trash-and-read on a message that was unread before.
      expect(mockPatchPerEmail).toHaveBeenCalledWith(
        [{ id: 'e1', patch: { $junk: null, $notjunk: true, $seen: null } }],
        undefined,
      );
      expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['e1']);
      useSettingsStore.getState().updateSetting('deleteAction', 'trash');
    });

    it('unmarkSpam moves back to Inbox with $notjunk', async () => {
      const mockUndoSpam = emailApi.undoSpam as ReturnType<typeof vi.fn>;
      useEmailStore.setState({
        mailboxes: [inbox, junk],
        currentMailboxId: 'mb-junk',
        emails: [{ id: 'e1', keywords: { $junk: true }, mailboxIds: { 'mb-junk': true } } as any],
      });

      await useEmailStore.getState().unmarkSpam(['e1']);

      expect(mockUndoSpam).toHaveBeenCalledWith(['e1'], 'mb-1', undefined);
      expect(useEmailStore.getState().emails).toHaveLength(0);
      expect(useEmailStore.getState().pendingUndo?.items[0].originalKeywords).toEqual({ $junk: true });
    });
  });

  // ── Shared (Stalwart group account) mailboxes ────────────────────────────
  describe('shared mailboxes', () => {
    const RIGHTS = {
      mayReadItems: true, mayAddItems: true, mayRemoveItems: true,
      maySetSeen: true, maySetKeywords: true, mayCreateChild: true,
      mayRename: true, mayDelete: true, maySubmit: true,
    };
    const ownInbox = {
      id: 'mb-1', name: 'Inbox', role: 'inbox', totalEmails: 0, unreadEmails: 0,
      totalThreads: 0, unreadThreads: 0, myRights: RIGHTS,
      accountId: 'acc-1', isShared: false,
    } as any;
    const sharedInbox = {
      id: 'grp-1:s-inbox', originalId: 's-inbox', name: 'Inbox', role: 'inbox',
      totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
      myRights: RIGHTS, accountId: 'grp-1', accountName: 'Support', isShared: true,
    } as any;
    const sharedTrash = {
      ...sharedInbox, id: 'grp-1:s-trash', originalId: 's-trash', name: 'Trash', role: 'trash',
    } as any;

    it('merges shared folders in alongside the own ones', async () => {
      mockGetMailboxesWithState.mockResolvedValue({ list: [ownInbox], state: 'mb-1' });
      mockGetSharedMailboxes.mockResolvedValue([sharedInbox]);

      await useEmailStore.getState().fetchMailboxes();

      expect(useEmailStore.getState().mailboxes).toEqual([ownInbox, sharedInbox]);
    });

    it('keeps the own folders when a shared account cannot be reached', async () => {
      mockGetMailboxesWithState.mockResolvedValue({ list: [ownInbox], state: 'mb-1' });
      mockGetSharedMailboxes.mockRejectedValue(new Error('Session expired'));

      await useEmailStore.getState().fetchMailboxes();

      const state = useEmailStore.getState();
      expect(state.mailboxes).toEqual([ownInbox]);
      expect(state.error).toBeNull();
    });

    it('queries a shared folder against its owning account by raw id', async () => {
      useEmailStore.setState({ mailboxes: [ownInbox, sharedInbox] });
      mockQueryEmails.mockResolvedValue({ ids: ['e1'], total: 1, queryState: 'q-1' });
      mockGetEmailsWithState.mockResolvedValue({
        list: [{ id: 'e1', subject: 'Hi' }], state: 'em-1',
      });

      await useEmailStore.getState().selectMailbox('grp-1:s-inbox');

      expect(mockQueryEmails).toHaveBeenCalledWith('s-inbox', expect.objectContaining({
        accountId: 'grp-1',
      }));
      expect(mockGetEmailsWithState).toHaveBeenCalledWith(['e1'], 'grp-1');
      // Each folder list keeps the Email state it was synced at.
      expect(useEmailStore.getState().emailStates).toEqual({ 'grp-1:s-inbox': 'em-1' });
    });

    it('deletes from a shared folder against the owning account', async () => {
      useEmailStore.setState({
        mailboxes: [ownInbox, sharedInbox, sharedTrash],
        currentMailboxId: 'grp-1:s-inbox',
        emails: [{ id: 'e1', keywords: {}, mailboxIds: { 's-inbox': true } } as any],
      });

      await useEmailStore.getState().deleteEmail('e1', 'grp-1:s-trash', 'grp-1:s-inbox');

      expect(mockDeleteEmail).toHaveBeenCalledWith('e1', 's-trash', 's-inbox', 'grp-1');
      expect(useEmailStore.getState().emails).toHaveLength(0);
    });

    it('moves a message between accounts by copying the blob and destroying the original (1.7.2)', async () => {
      const mockImport = emailApi.importEmailBlob as ReturnType<typeof vi.fn>;
      const mockDestroy = emailApi.destroyEmails as ReturnType<typeof vi.fn>;
      useEmailStore.setState({
        mailboxes: [ownInbox, sharedInbox],
        currentMailboxId: 'grp-1:s-inbox',
        emails: [{ id: 'e1', blobId: 'blob-1', keywords: { $seen: true, $flagged: false }, mailboxIds: { 's-inbox': true } } as any],
      });

      await useEmailStore.getState().moveToMailbox('e1', 'grp-1:s-inbox', 'mb-1');

      expect(mockMoveEmail).not.toHaveBeenCalled();
      expect(mockImport).toHaveBeenCalledWith('blob-new', 'mb-1', { $seen: true }, undefined);
      expect(mockDestroy).toHaveBeenCalledWith(['e1'], 'grp-1');
      const state = useEmailStore.getState();
      expect(state.error).toBeNull();
      expect(state.emails).toHaveLength(0);
    });
  });
});
