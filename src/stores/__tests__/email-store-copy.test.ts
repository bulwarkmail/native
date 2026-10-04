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
  copyEmailsWithinAccount: vi.fn(),
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
    fetchBlobArrayBuffer: vi.fn(async () => new ArrayBuffer(4)),
  },
}));

vi.mock('../../api/blob', () => ({
  uploadBytes: vi.fn(async () => ({ blobId: 'uploaded-blob' })),
}));

vi.mock('../toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import * as emailApi from '../../api/email';
import { toast } from '../toast-store';
import { withFailureToast } from '../../lib/action-failure';
import { jmapClient } from '../../api/jmap-client';
import { useEmailStore } from '../email-store';
import type { Email, Mailbox } from '../../api/types';

const mockCopy = emailApi.copyEmailsWithinAccount as ReturnType<typeof vi.fn>;
const mockImport = emailApi.importEmailBlob as ReturnType<typeof vi.fn>;
const mockDestroy = emailApi.destroyEmails as ReturnType<typeof vi.fn>;
const mockMoveEmails = emailApi.moveEmails as ReturnType<typeof vi.fn>;
const mockFullEmail = emailApi.getFullEmail as ReturnType<typeof vi.fn>;

function own(id: string, role: string): Mailbox {
  return { id, name: role, role, accountId: 'acc-1', isShared: false } as Mailbox;
}
function team(rawId: string, role: string): Mailbox {
  return { id: `grp-1:${rawId}`, originalId: rawId, name: role, role, accountId: 'grp-1', isShared: true } as Mailbox;
}

const MAILBOXES = [own('a', 'inbox'), own('x', 'archive'), team('a', 'inbox'), team('x', 'archive')];
const ROW = {
  id: 'e1', subject: 'Hello', blobId: 'blob-1', receivedAt: '2026-01-02T03:04:05Z',
  keywords: { $seen: true, $flagged: true, gone: false }, mailboxIds: { a: true },
} as unknown as Email;
const ROW2 = { ...ROW, id: 'e2' } as Email;

beforeEach(() => {
  vi.clearAllMocks();
  useEmailStore.getState().reset();
  useEmailStore.setState({ mailboxes: MAILBOXES, currentMailboxId: 'a', emails: [ROW, ROW2] });
});

describe('copy to another folder of the same account', () => {
  it('a copy keeps the original where it was', async () => {
    await useEmailStore.getState().copyToMailbox('e1', 'x');

    // Server: only the destination is added; nothing moved or destroyed.
    expect(mockCopy).toHaveBeenCalledWith(['e1'], 'x', undefined);
    expect(mockMoveEmails).not.toHaveBeenCalled();
    expect(mockDestroy).not.toHaveBeenCalled();
    // Local: the row stays in the open list and gains the destination.
    const rows = useEmailStore.getState().emails;
    expect(rows.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(rows[0].mailboxIds).toEqual({ a: true, x: true });
    expect(rows[1].mailboxIds).toEqual({ a: true });
    expect(useEmailStore.getState().pendingUndo).toBeNull();
  });

  it('patches mailboxIds/<dest> only for a batch ', async () => {
    await useEmailStore.getState().copyEmailsToMailbox(['e1', 'e2'], 'x');

    expect(mockCopy).toHaveBeenCalledWith(['e1', 'e2'], 'x', undefined);
    expect(mockDestroy).not.toHaveBeenCalled();
    const state = useEmailStore.getState();
    expect(state.emails.map((e) => e.mailboxIds)).toEqual([{ a: true, x: true }, { a: true, x: true }]);
  });

  it('copies a team message within the team account', async () => {
    const teamRow = { ...ROW, jmapAccountId: 'grp-1' } as Email;
    useEmailStore.setState({ emails: [teamRow], currentMailboxId: 'grp-1:a' });

    await useEmailStore.getState().copyToMailbox('e1', 'grp-1:x', { email: teamRow, accountId: 'grp-1' });

    expect(mockCopy).toHaveBeenCalledWith(['e1'], 'x', 'grp-1');
    expect(mockDestroy).not.toHaveBeenCalled();
  });
});

describe('copy to another account', () => {
  it('imports into the destination with the original date and keywords, and destroys nothing', async () => {
    await useEmailStore.getState().copyToMailbox('e1', 'grp-1:x');

    expect(jmapClient.fetchBlobArrayBuffer).toHaveBeenCalledWith('blob-1', undefined, 'message/rfc822', undefined);
    expect(mockImport).toHaveBeenCalledWith(
      'uploaded-blob', 'x', { $seen: true, $flagged: true }, 'grp-1', '2026-01-02T03:04:05Z',
    );
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockCopy).not.toHaveBeenCalled();
    // The original stays in the open list, untouched.
    expect(useEmailStore.getState().emails).toEqual([ROW, ROW2]);
  });

  it('a batch copy imports every message and leaves the originals', async () => {
    await useEmailStore.getState().copyEmailsToMailbox(['e1', 'e2'], 'grp-1:x');

    expect(mockImport).toHaveBeenCalledTimes(2);
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails).toEqual([ROW, ROW2]);
  });

  it('fetches the blob when the row has none', async () => {
    useEmailStore.setState({ emails: [{ ...ROW, blobId: undefined } as unknown as Email] });
    mockFullEmail.mockResolvedValue({ ...ROW });

    await useEmailStore.getState().copyToMailbox('e1', 'grp-1:x');

    expect(mockFullEmail).toHaveBeenCalledWith('e1', undefined);
    expect(mockImport).toHaveBeenCalledTimes(1);
  });
});

describe('a failed copy', () => {
  it('reports a failed copy as a copy', async () => {
    mockCopy.mockRejectedValue(new Error('boom'));

    await withFailureToast(useEmailStore.getState().copyToMailbox('e1', 'x'), 'Copy failed');

    expect(toast.error).toHaveBeenCalledWith('Copy failed', 'boom');
    // Nothing is claimed locally for a copy that did not happen.
    expect(useEmailStore.getState().emails[0].mailboxIds).toEqual({ a: true });
    expect(useEmailStore.getState().error).toBeNull();
  });

  it('rejects a cross-account copy while offline', async () => {
    const { useNetworkStore } = await import('../network-store');
    useNetworkStore.setState({ online: false });
    try {
      await expect(useEmailStore.getState().copyToMailbox('e1', 'grp-1:x')).rejects.toThrow();
      expect(mockImport).not.toHaveBeenCalled();
    } finally {
      useNetworkStore.setState({ online: true });
    }
  });
});
