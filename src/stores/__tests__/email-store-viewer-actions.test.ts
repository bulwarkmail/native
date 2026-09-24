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
  const applyOrQueueBatch = async (_ops: unknown[], onlineRun?: () => Promise<void>) => {
    if (onlineRun) await onlineRun();
    return { queued: false };
  };
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
import { useEmailStore, type ViewedEmail } from '../email-store';
import { useSettingsStore } from '../settings-store';
import type { Email, Mailbox } from '../../api/types';

const mockDeleteEmail = emailApi.deleteEmail as ReturnType<typeof vi.fn>;
const mockMoveEmail = emailApi.moveEmail as ReturnType<typeof vi.fn>;
const mockRestore = emailApi.restoreEmailMailboxes as ReturnType<typeof vi.fn>;
const mockMarkAsSpam = emailApi.markAsSpam as ReturnType<typeof vi.fn>;
const mockUndoSpam = emailApi.undoSpam as ReturnType<typeof vi.fn>;

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
// The user's own "Security audit #18" and the team's message share the id.
const OWN_ROW = { id: 'e1', subject: 'Security audit #18', keywords: {}, mailboxIds: { a: true } } as unknown as Email;
const TEAM_MESSAGE = { id: 'e1', subject: 'Team message', keywords: {}, mailboxIds: { a: true } } as unknown as Email;
const TEAM_VIEWED: ViewedEmail = { email: TEAM_MESSAGE, accountId: 'grp-1' };

beforeEach(() => {
  vi.clearAllMocks();
  useEmailStore.getState().reset();
});

describe('viewer actions on another account\'s message (B3)', () => {
  it('trashes a team message in the team account and leaves the open inbox\'s same-id row alone', async () => {
    useEmailStore.setState({ mailboxes: MAILBOXES, currentMailboxId: 'a', emails: [OWN_ROW] });

    await useEmailStore.getState().deleteEmail('e1', 'grp-1:t', 'grp-1:a', TEAM_VIEWED);

    expect(mockDeleteEmail).toHaveBeenCalledWith('e1', 't', 'a', 'grp-1');
    expect(useEmailStore.getState().emails).toEqual([OWN_ROW]);
    const undo = useEmailStore.getState().pendingUndo!;
    expect(undo.accountId).toBe('grp-1');
    expect(undo.items[0].email.subject).toBe('Team message');

    // Undo restores it in the team account, and does not slot it into the
    // user's own Inbox although its raw folder id matches.
    await useEmailStore.getState().undoLast();
    expect(mockRestore).toHaveBeenCalledWith([{ id: 'e1', mailboxIds: { a: true } }], 'grp-1');
    expect(useEmailStore.getState().emails).toEqual([OWN_ROW]);
  });

  it('trashes an own message in the own account while a team folder is open', async () => {
    const teamRow = { ...TEAM_MESSAGE };
    useEmailStore.setState({ mailboxes: MAILBOXES, currentMailboxId: 'grp-1:a', emails: [teamRow] });

    await useEmailStore.getState().deleteEmail('e1', 't', 'a', { email: OWN_ROW, accountId: undefined });

    expect(mockDeleteEmail).toHaveBeenCalledWith('e1', 't', 'a', undefined);
    expect(useEmailStore.getState().emails).toEqual([teamRow]);
  });

  it('refuses to trash a team message into another account\'s Trash', async () => {
    useEmailStore.setState({ mailboxes: MAILBOXES, currentMailboxId: 'a', emails: [OWN_ROW] });

    await expect(useEmailStore.getState().deleteEmail('e1', 't', 'grp-1:a', TEAM_VIEWED))
      .rejects.toThrow(/same account/);

    expect(mockDeleteEmail).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails).toEqual([OWN_ROW]);
  });

  it('moves a team message within the team account', async () => {
    useEmailStore.setState({ mailboxes: MAILBOXES, currentMailboxId: 'a', emails: [OWN_ROW] });

    await useEmailStore.getState().moveToMailbox('e1', 'grp-1:a', 'grp-1:x', TEAM_VIEWED);

    expect(mockMoveEmail).toHaveBeenCalledWith('e1', 'a', 'x', 'grp-1');
    expect(useEmailStore.getState().emails).toEqual([OWN_ROW]);
  });

  it('refuses to move a team message into the user\'s own folders', async () => {
    useEmailStore.setState({ mailboxes: MAILBOXES, currentMailboxId: 'a', emails: [OWN_ROW] });

    await expect(useEmailStore.getState().moveToMailbox('e1', 'grp-1:a', 'x', TEAM_VIEWED))
      .rejects.toThrow(/same account/);

    expect(mockMoveEmail).not.toHaveBeenCalled();
  });

  it('still drops the row when the viewer acts on a message of the open folder\'s account', async () => {
    useEmailStore.setState({ mailboxes: MAILBOXES, currentMailboxId: 'a', emails: [OWN_ROW] });

    await useEmailStore.getState().deleteEmail('e1', 't', 'a', { email: OWN_ROW, accountId: undefined });

    expect(mockDeleteEmail).toHaveBeenCalledWith('e1', 't', 'a', undefined);
    expect(useEmailStore.getState().emails).toEqual([]);
  });
});

describe('viewer Spam takes the list and swipe path (#695)', () => {
  it('files a team message into the team Junk flipping $junk/$notjunk, and leaves the list alone', async () => {
    useEmailStore.setState({ mailboxes: MAILBOXES, currentMailboxId: 'a', emails: [OWN_ROW] });

    await useEmailStore.getState().markSpam(['e1'], TEAM_VIEWED);

    expect(mockMarkAsSpam).toHaveBeenCalledWith(['e1'], 'j', 'grp-1', { markRead: false });
    expect(useEmailStore.getState().emails).toEqual([OWN_ROW]);
    const undo = useEmailStore.getState().pendingUndo!;
    expect(undo).toMatchObject({ kind: 'spam', accountId: 'grp-1', keywordPatch: { $junk: true, $notjunk: null } });
    expect(undo.items[0].originalMailboxIds).toEqual({ a: true });
  });

  it('honours trash-and-read for a message the list does not hold', async () => {
    useSettingsStore.getState().updateSetting('deleteAction', 'trash-and-read');
    useEmailStore.setState({ mailboxes: MAILBOXES, currentMailboxId: 'a', emails: [] });

    await useEmailStore.getState().markSpam(['e1'], { email: OWN_ROW, accountId: undefined });

    expect(mockMarkAsSpam).toHaveBeenCalledWith(['e1'], 'j', undefined, { markRead: true });
    useSettingsStore.getState().updateSetting('deleteAction', 'trash');
  });

  it('files a team message back into the team Inbox with $notjunk', async () => {
    useEmailStore.setState({ mailboxes: MAILBOXES, currentMailboxId: 'a', emails: [OWN_ROW] });
    const junked = { ...TEAM_MESSAGE, keywords: { $junk: true }, mailboxIds: { j: true } } as unknown as Email;

    await useEmailStore.getState().unmarkSpam(['e1'], { email: junked, accountId: 'grp-1' });

    expect(mockUndoSpam).toHaveBeenCalledWith(['e1'], 'a', 'grp-1');
    expect(useEmailStore.getState().emails).toEqual([OWN_ROW]);
  });
});
