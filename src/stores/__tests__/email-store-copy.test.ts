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
  const applyOrQueueBatch = vi.fn(async (_ops: unknown[], onlineRun?: (at: { gen: number; accountId: string }) => Promise<void>) => {
    // The scope the real outbox hands over: the connection, own account.
    if (onlineRun) await onlineRun({ gen: 0, accountId: 'acc-1' });
    return { queued: false };
  });
  return {
    applyOrQueueBatch,
    applyOrQueue: async (op: unknown, onlineRun?: (at: { gen: number; accountId: string }) => Promise<void>) => applyOrQueueBatch([op], onlineRun),
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
    // The connection a cross-account copy is bound to, end to end.
    connectionGen: 7,
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
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import * as emailApi from '../../api/email';
import { toast } from '../toast-store';
import { withFailureToast } from '../../lib/action-failure';
import { jmapClient } from '../../api/jmap-client';
import { useEmailStore, requireShownAccountScope, AccountNotServedError } from '../email-store';
import { registerServedAccount } from './helpers/served-account';
import type { Email, Mailbox } from '../../api/types';

// The mocked client serves this account, shown as active; the store checks
// that before acting.
beforeEach(() => {
  useEmailStore.setState({ activeAccountId: registerServedAccount('test@example.com', 'https://mail.example.com') });
});

const mockCopy = emailApi.copyEmailsWithinAccount as ReturnType<typeof vi.fn>;
const mockImport = emailApi.importEmailBlob as ReturnType<typeof vi.fn>;
const mockDestroy = emailApi.destroyEmails as ReturnType<typeof vi.fn>;
const mockMoveEmails = emailApi.moveEmails as ReturnType<typeof vi.fn>;
const mockFullEmail = emailApi.getFullEmail as ReturnType<typeof vi.fn>;

/** The scope an action passes: JMAP account `accountId` on the connection it started on. */
const onAccount = (accountId: string) => expect.objectContaining({ accountId });

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
    expect(mockCopy).toHaveBeenCalledWith(['e1'], 'x', onAccount('acc-1'));
    expect(mockMoveEmails).not.toHaveBeenCalled();
    expect(mockDestroy).not.toHaveBeenCalled();
    // Local: the row stays in the open list and gains the destination.
    const rows = useEmailStore.getState().emails;
    expect(rows.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(rows[0].mailboxIds).toEqual({ a: true, x: true });
    expect(rows[1].mailboxIds).toEqual({ a: true });
    expect(useEmailStore.getState().pendingUndo).toBeNull();
  });

  it('patches mailboxIds/<dest> only for a batch', async () => {
    await useEmailStore.getState().copyEmailsToMailbox(['e1', 'e2'], 'x');

    expect(mockCopy).toHaveBeenCalledWith(['e1', 'e2'], 'x', onAccount('acc-1'));
    expect(mockDestroy).not.toHaveBeenCalled();
    const state = useEmailStore.getState();
    expect(state.emails.map((e) => e.mailboxIds)).toEqual([{ a: true, x: true }, { a: true, x: true }]);
  });

  it('copies a team message within the team account', async () => {
    const teamRow = { ...ROW, jmapAccountId: 'grp-1' } as Email;
    useEmailStore.setState({ emails: [teamRow], currentMailboxId: 'grp-1:a' });

    await useEmailStore.getState().copyToMailbox('e1', 'grp-1:x', { email: teamRow, accountId: 'grp-1' });

    expect(mockCopy).toHaveBeenCalledWith(['e1'], 'x', onAccount('grp-1'));
    expect(mockDestroy).not.toHaveBeenCalled();
  });
});

describe('copy to another account', () => {
  it('imports into the destination with the original date and keywords, and destroys nothing', async () => {
    await useEmailStore.getState().copyToMailbox('e1', 'grp-1:x');

    expect(jmapClient.fetchBlobArrayBuffer).toHaveBeenCalledWith('blob-1', undefined, 'message/rfc822', 'acc-1', 7);
    expect(mockImport).toHaveBeenCalledWith(
      'uploaded-blob', 'x', { $seen: true, $flagged: true }, onAccount('grp-1'), '2026-01-02T03:04:05Z',
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

    expect(mockFullEmail).toHaveBeenCalledWith('e1', onAccount('acc-1'));
    expect(mockImport).toHaveBeenCalledTimes(1);
  });
});

describe('copy from the viewer when the list does not hold the message', () => {
  it('copies a team message within the team account while an own folder is open', async () => {
    useEmailStore.setState({ emails: [], currentMailboxId: 'a' });
    const viewed = { email: { ...ROW, blobId: undefined } as unknown as Email, accountId: 'grp-1' };

    await useEmailStore.getState().copyToMailbox('e1', 'grp-1:x', viewed);

    expect(mockCopy).toHaveBeenCalledWith(['e1'], 'x', onAccount('grp-1'));
    expect(jmapClient.fetchBlobArrayBuffer).not.toHaveBeenCalled();
    expect(mockFullEmail).not.toHaveBeenCalled();
    expect(mockImport).not.toHaveBeenCalled();
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('copies an own message with a plain patch while a team folder is open', async () => {
    useEmailStore.setState({ emails: [], currentMailboxId: 'grp-1:a' });

    await useEmailStore.getState().copyToMailbox('e1', 'x', { email: ROW, accountId: undefined });

    expect(mockCopy).toHaveBeenCalledWith(['e1'], 'x', onAccount('acc-1'));
    expect(jmapClient.fetchBlobArrayBuffer).not.toHaveBeenCalled();
    expect(mockImport).not.toHaveBeenCalled();
  });
});

describe('copy from the viewer into another account', () => {
  it('refuses with a copy message, not the move one', async () => {
    useEmailStore.setState({ emails: [], currentMailboxId: 'a' });
    const viewed = { email: { ...ROW, blobId: undefined } as unknown as Email, accountId: 'grp-1' };

    await expect(useEmailStore.getState().copyToMailbox('e1', 'x', viewed)).rejects.toThrow(
      'Messages can only be copied within the same account',
    );
    expect(mockCopy).not.toHaveBeenCalled();
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
      await expect(useEmailStore.getState().copyToMailbox('e1', 'grp-1:x')).rejects.toThrow('Copying needs a connection');
      await expect(useEmailStore.getState().copyToMailbox('e1', 'x')).rejects.toThrow('Copying needs a connection');
      expect(mockImport).not.toHaveBeenCalled();
    } finally {
      useNetworkStore.setState({ online: true });
    }
  });
});

describe('a failed cross-account move', () => {
  it('rejects so the caller can report it as a failed move, and keeps the row', async () => {
    mockImport.mockRejectedValue(new Error('boom'));

    await withFailureToast(useEmailStore.getState().moveToMailbox('e1', 'a', 'grp-1:x'), 'Move failed');

    expect(toast.error).toHaveBeenCalledWith('Move failed', 'boom');
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails).toEqual([ROW, ROW2]);
  });

  it('rejects a batch move the same way', async () => {
    mockImport.mockRejectedValue(new Error('boom'));

    await expect(useEmailStore.getState().moveEmailsToMailbox(['e1', 'e2'], 'grp-1:x')).rejects.toThrow('boom');
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails).toEqual([ROW, ROW2]);
  });
});

// C1 (R15): in the switch window the store already shows B while the client
// still serves A. Actions that can't wait in the outbox (copies, moves between
// accounts, imports) are refused, and nothing reaches A, whose message with
// the same id is another one.
describe('direct actions while the client serves another account (C1)', () => {
  const NOT_READY = 'This account is still loading. Try again in a moment.';
  beforeEach(() => {
    // B is shown; the client (test@example.com) serves A.
    useEmailStore.setState({ activeAccountId: 'bob@b.example.com' });
  });
  const nothingSent = () => {
    expect(mockCopy).not.toHaveBeenCalled();
    expect(mockImport).not.toHaveBeenCalled();
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockFullEmail).not.toHaveBeenCalled();
    expect(jmapClient.fetchBlobArrayBuffer).not.toHaveBeenCalled();
  };

  it('refuses a copy within the account', async () => {
    await expect(useEmailStore.getState().copyToMailbox('e1', 'x')).rejects.toThrow(NOT_READY);
    nothingSent();
  });

  it('refuses a copy to another account', async () => {
    await expect(useEmailStore.getState().copyEmailsToMailbox(['e1', 'e2'], 'grp-1:x')).rejects.toThrow(NOT_READY);
    nothingSent();
  });

  it('refuses a move to another account, keeping the rows', async () => {
    await expect(useEmailStore.getState().moveToMailbox('e1', 'a', 'grp-1:x')).rejects.toThrow(NOT_READY);
    await expect(useEmailStore.getState().moveEmailsToMailbox(['e1', 'e2'], 'grp-1:x')).rejects.toThrow(NOT_READY);
    nothingSent();
    expect(useEmailStore.getState().emails).toEqual([ROW, ROW2]);
  });

  it('refuses to mark a message outside the list read in another account', async () => {
    useEmailStore.setState({ emails: [] });
    await expect(useEmailStore.getState().markRead('e9', 'grp-1')).rejects.toThrow(NOT_READY);
    expect(emailApi.patchKeywordsForEmails).not.toHaveBeenCalled();
  });

  it('refuses an import', async () => {
    await expect(useEmailStore.getState().importEmails([{ uri: 'file:///a.eml', name: 'a.eml', mimeType: 'message/rfc822' }] as never, 'a'))
      .rejects.toThrow(NOT_READY);
    nothingSent();
  });
});

// R16: a screen that showed one account's folders or message binds its action
// to that account, at the tap. Ids repeat across accounts (Stalwart numbers
// them per account), so the account and connection must both match.
describe('requireShownAccountScope', () => {
  const A = () => useEmailStore.getState().activeAccountId!;

  it('binds the action to the connection serving the shown account', () => {
    expect(requireShownAccountScope(A())).toEqual({ gen: 7, accountId: 'acc-1' });
    expect(requireShownAccountScope(A(), 'grp-1')).toEqual({ gen: 7, accountId: 'grp-1' });
  });

  it('refuses ("switch back") once another account is shown', () => {
    const a = A();
    // A notification tap shows B; the client still serves A.
    useEmailStore.setState({ activeAccountId: 'bob@b.example.com' });
    expect(() => requireShownAccountScope(a)).toThrow(/Switch back to it/);
    expect(() => requireShownAccountScope(a)).toThrow(AccountNotServedError);
  });

  it('refuses ("try again") the shown account while the client serves another', () => {
    useEmailStore.setState({ activeAccountId: 'bob@b.example.com' });
    expect(() => requireShownAccountScope('bob@b.example.com')).toThrow('This account is still loading. Try again in a moment.');
  });

  it('refuses when no account was captured', () => {
    expect(() => requireShownAccountScope(null)).toThrow(/Try again/);
  });
});

// I1/I3 (R15): a move between accounts takes its connection once, when it
// starts, and sends the download, upload, import and destroy all on it.
describe('a move between accounts stays on one connection', () => {
  it('binds every step to the connection it started on', async () => {
    const { uploadBytes } = await import('../../api/blob');
    // An earlier block left the import failing.
    mockImport.mockResolvedValue('imported-1');
    await useEmailStore.getState().moveToMailbox('e1', 'a', 'grp-1:x');
    expect(jmapClient.fetchBlobArrayBuffer).toHaveBeenCalledWith('blob-1', undefined, 'message/rfc822', 'acc-1', 7);
    expect(uploadBytes).toHaveBeenCalledWith(expect.any(Uint8Array), 'message/rfc822', { gen: 7, accountId: 'grp-1' });
    expect(mockImport).toHaveBeenCalledWith('uploaded-blob', 'x', expect.anything(), { gen: 7, accountId: 'grp-1' }, ROW.receivedAt);
    expect(mockDestroy).toHaveBeenCalledWith(['e1'], { gen: 7, accountId: 'acc-1' });
  });

  // R16: a switch (or a reload) between the import and the removal of the
  // original stops the move unsent, which the caller drops silently.
  const stale = () => Object.assign(new Error('Superseded'), { name: 'StaleLoadError' });
  const MAY_REMAIN = 'The moved copy may also remain in the original folder.';

  it('says the message may be in both places when it stops after the import', async () => {
    mockImport.mockResolvedValue('imported-1');
    mockDestroy.mockRejectedValueOnce(stale());
    await expect(useEmailStore.getState().moveToMailbox('e1', 'a', 'grp-1:x')).rejects.toThrow('Superseded');
    expect(toast.warning).toHaveBeenCalledWith(MAY_REMAIN);
  });

  it('says nothing when it stops before anything was imported', async () => {
    mockImport.mockRejectedValueOnce(stale());
    await expect(useEmailStore.getState().moveToMailbox('e1', 'a', 'grp-1:x')).rejects.toThrow('Superseded');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('says nothing for a copy, which keeps the original anyway', async () => {
    mockImport.mockRejectedValueOnce(stale());
    await expect(useEmailStore.getState().copyToMailbox('e1', 'grp-1:x')).rejects.toThrow('Superseded');
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('a failed bulk action on a list spanning accounts', () => {
  const TEAM_ROW = { ...ROW, id: 'e3', jmapAccountId: 'grp-1' } as Email;
  beforeEach(() => {
    useEmailStore.setState({
      mailboxes: [...MAILBOXES, own('t', 'trash'), team('t', 'trash'), own('j', 'junk'), team('j', 'junk')],
      emails: [ROW, TEAM_ROW],
    });
    for (const m of [mockMoveEmails, emailApi.archiveEmails, emailApi.restoreEmailMailboxes, emailApi.setEmailMailboxes, mockDestroy,
      emailApi.markAsSpam, emailApi.patchKeywordsForEmails, emailApi.patchKeywordsPerEmail]) {
      (m as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    }
  });

  it.each([
    ['archive', () => useEmailStore.getState().archiveEmailsBatch(['e1', 'grp-1:e3'])],
    ['delete', () => useEmailStore.getState().deleteEmailsBatch(['e1', 'grp-1:e3'], 't', 'a')],
    ['spam', () => useEmailStore.getState().markSpam(['e1', 'grp-1:e3'])],
  ])('%s rejects', async (_name, run) => {
    await expect(run()).rejects.toThrow('boom');
  });
});
