import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/email', () => ({
  getMailboxes: vi.fn(),
  // New helpers used by the incremental-sync path. Default behavior: behave
  // like a first-ever load — no prior state, full re-query expected.
  getMailboxesWithState: vi.fn(async () => ({ list: [], state: 'mb-state-0' })),
  getMailboxesByIds: vi.fn(async () => ({ list: [], state: 'mb-state-0' })),
  getMailboxChanges: vi.fn(async () => null),
  queryEmails: vi.fn(),
  getEmailQueryChanges: vi.fn(async () => null),
  getEmails: vi.fn(),
  getEmailsWithState: vi.fn(async () => ({ list: [], state: 'em-state-0' })),
  getEmailChanges: vi.fn(async () => null),
  getFullEmail: vi.fn(),
  setEmailKeywords: vi.fn(),
  setKeywordsForEmails: vi.fn(),
  moveEmail: vi.fn(),
  moveEmails: vi.fn(),
  archiveEmails: vi.fn(),
  restoreEmailMailboxes: vi.fn(),
  setEmailMailboxes: vi.fn(),
  destroyEmails: vi.fn(),
  deleteEmail: vi.fn(),
  deleteEmails: vi.fn(),
  searchEmails: vi.fn(),
}));

// The mutations now route through the offline outbox. In tests we want the
// "online, nothing queued" fast path: run the supplied online runner (or the
// op's primitive) immediately so the existing api-call assertions still hold,
// without pulling in network-store / NetInfo.
vi.mock('../outbox-store', async () => {
  const api = await import('../../api/email') as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const runOp = async (op: { kind: string; emailId: string; keywords?: unknown; mailboxIds?: unknown }) => {
    if (op.kind === 'keywords') return api.setEmailKeywords(op.emailId, op.keywords);
    if (op.kind === 'mailboxes') return api.setEmailMailboxes(op.emailId, op.mailboxIds);
    if (op.kind === 'destroy') return api.destroyEmails([op.emailId]);
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
// reads archiveMode in archiveEmail, so a minimal stub is enough.
vi.mock('../settings-store', () => ({
  useSettingsStore: { getState: () => ({ archiveMode: 'single', emailsPerPage: 25 }) },
}));

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
  },
}));

import { generateAccountId } from '../../lib/account-utils';
const TEST_ACCOUNT_ID = generateAccountId('test@example.com', 'https://mail.example.com');

import * as emailApi from '../../api/email';
import { useEmailStore } from '../email-store';

const mockGetMailboxesWithState = emailApi.getMailboxesWithState as ReturnType<typeof vi.fn>;
const mockQueryEmails = emailApi.queryEmails as ReturnType<typeof vi.fn>;
const mockGetEmails = emailApi.getEmails as ReturnType<typeof vi.fn>;
const mockGetEmailsWithState = emailApi.getEmailsWithState as ReturnType<typeof vi.fn>;
const mockGetFullEmail = emailApi.getFullEmail as ReturnType<typeof vi.fn>;
const mockSetKeywords = emailApi.setEmailKeywords as ReturnType<typeof vi.fn>;
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
      // First-time load with no ids hits getEmailsWithState only to prime
      // emailState (with an empty ids array). It should NOT call legacy
      // getEmails — that path is reserved for pagination/search.
      expect(mockGetEmails).not.toHaveBeenCalled();
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

      mockQueryEmails.mockResolvedValue({ ids: ['e2'], total: 2 });
      mockGetEmails.mockResolvedValue([{ id: 'e2', subject: 'Email 2' }]);

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
  });

  describe('markRead', () => {
    it('should update keywords and optimistically update state', async () => {
      useEmailStore.setState({
        emails: [{ id: 'e1', keywords: {} } as any],
      });
      mockSetKeywords.mockResolvedValue(undefined);

      await useEmailStore.getState().markRead('e1');

      expect(mockSetKeywords).toHaveBeenCalledWith('e1', { $seen: true });
      expect(useEmailStore.getState().emails[0].keywords.$seen).toBe(true);
    });
  });

  describe('markUnread', () => {
    it('should remove $seen keyword', async () => {
      useEmailStore.setState({
        emails: [{ id: 'e1', keywords: { $seen: true, $flagged: true } } as any],
      });
      mockSetKeywords.mockResolvedValue(undefined);

      await useEmailStore.getState().markUnread('e1');

      expect(mockSetKeywords).toHaveBeenCalledWith('e1', { $flagged: true });
      expect(useEmailStore.getState().emails[0].keywords.$seen).toBeUndefined();
    });
  });

  describe('toggleStar', () => {
    it('should add $flagged keyword', async () => {
      useEmailStore.setState({
        emails: [{ id: 'e1', keywords: { $seen: true } } as any],
      });
      mockSetKeywords.mockResolvedValue(undefined);

      await useEmailStore.getState().toggleStar('e1', true);

      expect(useEmailStore.getState().emails[0].keywords.$flagged).toBe(true);
    });

    it('should remove $flagged keyword', async () => {
      useEmailStore.setState({
        emails: [{ id: 'e1', keywords: { $seen: true, $flagged: true } } as any],
      });
      mockSetKeywords.mockResolvedValue(undefined);

      await useEmailStore.getState().toggleStar('e1', false);

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

      expect(mockMoveEmail).toHaveBeenCalledWith('e1', 'inbox', 'archive');
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

  describe('getEmailDetail', () => {
    it('should fetch full email', async () => {
      const fullEmail = { id: 'e1', subject: 'Test', bodyValues: { html: { value: '<p>Hi</p>' } } };
      mockGetFullEmail.mockResolvedValue(fullEmail);

      const result = await useEmailStore.getState().getEmailDetail('e1');

      expect(result).toEqual(fullEmail);
    });
  });
});
