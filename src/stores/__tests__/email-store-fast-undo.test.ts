import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/email', () => ({
  getMailboxes: vi.fn(),
  getMailboxesWithState: vi.fn(async () => ({ list: [], state: 'mb-state-0' })),
  getSharedMailboxes: vi.fn(async () => []),
  getMailboxesByIds: vi.fn(async () => ({ list: [], state: 'mb-state-0' })),
  getMailboxChanges: vi.fn(async () => null),
  queryEmails: vi.fn(),
  queryEmailPage: vi.fn(),
  queryEmailPagesAcrossAccounts: vi.fn(),
  getEmailQueryChanges: vi.fn(async () => null),
  getEmailListDelta: vi.fn(),
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

vi.mock('../../api/blob', () => ({
  uploadBytes: vi.fn(async () => ({ blobId: 'blob-new', size: 3, type: 'message/rfc822' })),
}));

vi.mock('../locale-store', () => ({
  t: (_key: string, fallback?: string) => fallback ?? _key,
  useLocaleStore: { getState: () => ({ locale: 'en', t: (_k: string, f?: string) => f ?? _k }) },
}));

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
    fetchBlobArrayBuffer: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
    request: vi.fn(async () => ({ methodResponses: [['error', { type: 'unsupportedSort' }, 'asc']] })),
  },
}));

import { generateAccountId } from '../../lib/account-utils';
const TEST_ACCOUNT_ID = generateAccountId('test@example.com', 'https://mail.example.com');

import * as emailApi from '../../api/email';
import { useEmailStore, pagingTotal } from '../email-store';
import { useSettingsStore } from '../settings-store';


const mockArchive = emailApi.archiveEmails as ReturnType<typeof vi.fn>;
const mockRestore = emailApi.restoreEmailMailboxes as ReturnType<typeof vi.fn>;

const RIGHTS = {} as any;
const inbox = { id: 'mb-1', name: 'Inbox', role: 'inbox', myRights: RIGHTS, isShared: false } as any;
const archive = { id: 'mb-arch', name: 'Archive', role: 'archive', myRights: RIGHTS, isShared: false } as any;
const mail = (id: string, hour: number, keywords: Record<string, boolean> = {}) => ({
  id, keywords, mailboxIds: { 'mb-1': true }, receivedAt: `2026-11-15T${String(hour).padStart(2, '0')}:00:00Z`,
}) as any;

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const listed = () => useEmailStore.getState().emails.map((e) => e.id);

beforeEach(() => {
  vi.clearAllMocks();
  useEmailStore.getState().reset();
  useEmailStore.setState({
    activeAccountId: TEST_ACCOUNT_ID,
    mailboxes: [inbox, archive],
    currentMailboxId: 'mb-1',
    emails: [mail('a', 10), mail('b', 9), mail('c', 8)],
  });
  useSettingsStore.getState().updateSetting('mailSortAscending', false);
  mockArchive.mockResolvedValue(undefined);
  mockRestore.mockResolvedValue(undefined);
});

describe('archive and undo in quick succession', () => {
  it('puts the mail back the moment undo is tapped, before the server answers', async () => {
    await useEmailStore.getState().archiveEmail('b');
    expect(listed()).toEqual(['a', 'c']);
    const server = deferred();
    mockRestore.mockReturnValueOnce(server.promise);

    const undo = useEmailStore.getState().undoLast();
    await flush();
    expect(listed()).toEqual(['a', 'b', 'c']);

    server.resolve();
    await undo;
    expect(listed()).toEqual(['a', 'b', 'c']);
  });

  it('takes the mail out again and says so when the server refuses the undo', async () => {
    await useEmailStore.getState().archiveEmail('b');
    mockRestore.mockRejectedValueOnce(new Error('offline'));

    await useEmailStore.getState().undoLast();

    expect(listed()).toEqual(['a', 'c']);
    expect(useEmailStore.getState().error).toBe('offline');
  });

  it('puts the mail back where the list sorts it, pinned mail first', async () => {
    useEmailStore.setState({ emails: [mail('p', 7, { $pinned: true }), mail('a', 10), mail('c', 8)] });

    await useEmailStore.getState().archiveEmail('a');
    await useEmailStore.getState().undoLast();

    expect(listed()).toEqual(['p', 'a', 'c']);
  });

  it('marks the mail it put back so the list can animate it in', async () => {
    await useEmailStore.getState().archiveEmail('b');
    await useEmailStore.getState().undoLast();

    expect(useEmailStore.getState().lastRestored?.keys).toEqual(['b']);
  });

  it('sends a new archive of the same mail only after the undo reached the server', async () => {
    await useEmailStore.getState().archiveEmail('b');
    const server = deferred();
    mockRestore.mockReturnValueOnce(server.promise);

    const undo = useEmailStore.getState().undoLast();
    await flush();
    const again = useEmailStore.getState().archiveEmail('b');
    await flush();
    expect(mockArchive).toHaveBeenCalledTimes(1);

    server.resolve();
    await Promise.all([undo, again]);

    expect(mockArchive).toHaveBeenCalledTimes(2);
    expect(mockRestore.mock.invocationCallOrder[0]).toBeLessThan(mockArchive.mock.invocationCallOrder[1]);
    expect(listed()).toEqual(['a', 'c']);
    expect(useEmailStore.getState().pendingUndo?.kind).toBe('archive');
  });

  it('restores once when undo is tapped twice', async () => {
    await useEmailStore.getState().archiveEmail('b');

    await Promise.all([useEmailStore.getState().undoLast(), useEmailStore.getState().undoLast()]);

    expect(mockRestore).toHaveBeenCalledTimes(1);
    expect(listed()).toEqual(['a', 'b', 'c']);
  });

  it('lists the mail exactly once after archive, undo, archive, undo as fast as the bar allows', async () => {
    const pending: Promise<void>[] = [];
    for (let round = 0; round < 2; round++) {
      pending.push(useEmailStore.getState().archiveEmail('b'));
      await flush();
      pending.push(useEmailStore.getState().undoLast());
      await flush();
    }
    await Promise.all(pending);

    expect(listed()).toEqual(['a', 'b', 'c']);
    expect(mockArchive).toHaveBeenCalledTimes(2);
    expect(mockRestore).toHaveBeenCalledTimes(2);
    const order = [
      ...mockArchive.mock.invocationCallOrder.map((n) => [n, 'archive'] as const),
      ...mockRestore.mock.invocationCallOrder.map((n) => [n, 'restore'] as const),
    ].sort((x, y) => x[0] - y[0]).map(([, op]) => op);
    expect(order).toEqual(['archive', 'restore', 'archive', 'restore']);
  });
});
