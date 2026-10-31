import { describe, it, expect, vi, beforeEach } from 'vitest';

// Actions the viewer runs on the message it shows, which may live in another
// account than the open folder (unified inbox, notification, deep link).
// Stalwart ids are only unique per account, so the fixtures reuse the same
// message id ("e1") and raw folder ids ("a" = Inbox, "t" = Trash) in the
// user's own account and in the group account "grp-1".

vi.mock('../../api/email', () => ({
  getMailboxes: vi.fn(),
  getMailboxesWithState: vi.fn(async () => ({ list: [], state: 'mb-state-0' })),
  getSharedMailboxes: vi.fn(async () => []),
  getMailboxesByIds: vi.fn(async () => ({ list: [], state: 'mb-state-0' })),
  getMailboxChanges: vi.fn(async () => null),
  queryEmails: vi.fn(),
  getEmailQueryChanges: vi.fn(async () => null),
  getEmailListDelta: vi.fn(async () => ({ queryChanges: null, changes: null, added: [], addedFetched: false, threads: [] })),
  getEmails: vi.fn(),
  getEmailsWithState: vi.fn(async () => ({ list: [], state: 'em-state-0' })),
  getEmailChanges: vi.fn(async () => null),
  getFullEmail: vi.fn(),
  importEmailBlob: vi.fn(),
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

vi.mock('../locale-store', () => ({
  t: (_key: string, fallback?: string) => fallback ?? _key,
  useLocaleStore: { getState: () => ({ locale: 'en', t: (_k: string, f?: string) => f ?? _k }) },
}));

// Online with nothing queued: run the online runner straight away.
vi.mock('../outbox-store', () => {
  const applyOrQueueBatch = vi.fn(async (_ops: unknown[], onlineRun?: () => Promise<void>) => {
    if (onlineRun) await onlineRun();
    return { queued: false };
  });
  return {
    applyOrQueueBatch,
    applyOrQueue: async (op: unknown, onlineRun?: () => Promise<void>) => applyOrQueueBatch([op], onlineRun),
    useOutboxStore: {
      getState: () => ({ entries: [], count: () => 0, setAccount: vi.fn(async () => undefined), flush: vi.fn() }),
    },
  };
});

vi.mock('../settings-store', () => {
  const settings: Record<string, unknown> = { archiveMode: 'single', deleteAction: 'trash' };
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
    getMaxObjectsInGet: () => 500,
    getMaxCallsInRequest: () => 16,
    getSharedMailAccounts: () => [{ id: 'grp-1', name: 'Support' }],
    request: vi.fn(),
  },
}));

import * as emailApi from '../../api/email';
import { applyOrQueueBatch } from '../outbox-store';
import { useEmailStore, type ViewedEmail } from '../email-store';
import { useSettingsStore } from '../settings-store';
import type { Email, Mailbox } from '../../api/types';

const mockDeleteEmail = emailApi.deleteEmail as ReturnType<typeof vi.fn>;
const mockMoveEmail = emailApi.moveEmail as ReturnType<typeof vi.fn>;
const mockRestore = emailApi.restoreEmailMailboxes as ReturnType<typeof vi.fn>;
const mockMarkAsSpam = emailApi.markAsSpam as ReturnType<typeof vi.fn>;
const mockUndoSpam = emailApi.undoSpam as ReturnType<typeof vi.fn>;
const mockArchive = emailApi.archiveEmails as ReturnType<typeof vi.fn>;
const mockPatchKeywords = emailApi.patchKeywordsForEmails as ReturnType<typeof vi.fn>;
const mockApplyOrQueueBatch = applyOrQueueBatch as unknown as ReturnType<typeof vi.fn>;

function own(id: string, role: string): Mailbox {
  return { id, name: role, role, accountId: 'acc-1', isShared: false } as Mailbox;
}
function team(rawId: string, role: string): Mailbox {
  return { id: `grp-1:${rawId}`, originalId: rawId, name: role, role, accountId: 'grp-1', isShared: true } as Mailbox;
}

const MAILBOXES = [
  own('a', 'inbox'), own('t', 'trash'), own('x', 'archive'), own('j', 'junk'),
  team('a', 'inbox'), team('t', 'trash'), team('x', 'archive'), team('j', 'junk'),
];

const mockPatchPerEmail = emailApi.patchKeywordsPerEmail as ReturnType<typeof vi.fn>;
const ROW = { id: 'e1', subject: 'Hello', keywords: { $seen: true }, mailboxIds: { a: true } } as unknown as Email;

beforeEach(() => {
  vi.clearAllMocks();
  useEmailStore.getState().reset();
});

describe('keyword undo', () => {
  it('undoes a star made after a tag', async () => {
    useEmailStore.setState({ mailboxes: MAILBOXES, currentMailboxId: 'a', emails: [ROW] });

    await useEmailStore.getState().setKeywordForEmails(['e1'], '$label:orange', true);
    await useEmailStore.getState().setKeywordForEmails(['e1'], '$flagged', true);
    await useEmailStore.getState().undoLast();

    expect(mockPatchPerEmail).toHaveBeenLastCalledWith([{ id: 'e1', patch: { $flagged: null } }], undefined);
    expect(useEmailStore.getState().emails[0].keywords).toEqual({ $seen: true, '$label:orange': true });
  });

  it("does not offer the tag's Undo while the star after it is on its way", async () => {
    useEmailStore.setState({ mailboxes: MAILBOXES, currentMailboxId: 'a', emails: [ROW] });
    await useEmailStore.getState().setKeywordForEmails(['e1'], '$label:orange', true);
    expect(useEmailStore.getState().pendingUndo?.keywordPatch).toEqual({ '$label:orange': true });

    let release!: () => void;
    mockPatchKeywords.mockImplementationOnce(() => new Promise<void>((r) => { release = () => r(); }));
    const starring = useEmailStore.getState().setKeywordForEmails(['e1'], '$flagged', true);
    // Undo tapped on the bar still up from the tag.
    await useEmailStore.getState().undoLast();
    expect(mockPatchPerEmail).not.toHaveBeenCalled();

    release();
    await starring;
    await useEmailStore.getState().undoLast();
    expect(mockPatchPerEmail).toHaveBeenCalledTimes(1);
    expect(mockPatchPerEmail).toHaveBeenCalledWith([{ id: 'e1', patch: { $flagged: null } }], undefined);
    expect(useEmailStore.getState().emails[0].keywords).toEqual({ $seen: true, '$label:orange': true });
  });
});
