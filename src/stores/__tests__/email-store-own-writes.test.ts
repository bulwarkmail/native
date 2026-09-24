import { describe, it, expect, vi, beforeEach } from 'vitest';

// The echo of the app's own writes (PF6): a push that only reports what our
// own Email/set did must not re-read the list, and a folder push must only
// re-read the part of the folder list that changed.

vi.mock('../../api/email', () => ({
  getMailboxesWithState: vi.fn(async () => ({ list: [], state: 'mbs-0' })),
  getSharedMailboxes: vi.fn(async () => []),
  getMailboxesByIds: vi.fn(async () => ({ list: [], state: 'mbs-0' })),
  getMailboxChanges: vi.fn(async () => null),
  queryEmailPage: vi.fn(async () => ({ ids: [], total: 0, list: [], threads: [] })),
  getEmailQueryChanges: vi.fn(async () => null),
  getEmails: vi.fn(),
  getEmailsWithState: vi.fn(async () => ({ list: [], state: 'em-0' })),
  getEmailChanges: vi.fn(async () => null),
  getThreads: vi.fn(async () => []),
  getFullEmail: vi.fn(),
  importEmailBlob: vi.fn(),
  patchKeywordsForEmails: vi.fn(async () => undefined),
  patchKeywordsPerEmail: vi.fn(),
  moveEmail: vi.fn(async () => undefined),
  moveEmails: vi.fn(),
  archiveEmails: vi.fn(),
  restoreEmailMailboxes: vi.fn(),
  destroyEmails: vi.fn(),
  deleteEmail: vi.fn(),
  deleteEmails: vi.fn(),
  searchEmails: vi.fn(),
  markAsSpam: vi.fn(),
  undoSpam: vi.fn(),
  unprefixMailboxId: (id: string) => id,
}));

vi.mock('../locale-store', () => ({
  t: (_key: string, fallback?: string) => fallback ?? _key,
  useLocaleStore: { getState: () => ({ locale: 'en', t: (_k: string, f?: string) => f ?? _k }) },
}));

vi.mock('../outbox-store', () => {
  const applyOrQueueBatch = async (_ops: unknown[], onlineRun?: () => Promise<void>) => {
    if (onlineRun) await onlineRun();
    return { queued: false };
  };
  return {
    applyOrQueueBatch,
    applyOrQueue: async (op: unknown, onlineRun?: () => Promise<void>) => applyOrQueueBatch([op], onlineRun),
    useOutboxStore: { getState: () => ({ setAccount: vi.fn(async () => undefined), flush: vi.fn(async () => undefined) }) },
  };
});

vi.mock('../settings-store', () => {
  const settings: Record<string, unknown> = { archiveMode: 'single', emailsPerPage: 25, mailSortAscending: false };
  return { useSettingsStore: { getState: () => settings } };
});

vi.mock('../offline-cache-store', () => ({
  useOfflineCacheStore: {
    getState: () => ({
      hydrated: true,
      setAccount: vi.fn(async () => undefined),
      totalCount: () => 0,
      has: () => false,
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
    getSharedMailAccounts: () => [{ id: 'grp-1', name: 'Support' }],
    request: vi.fn(async () => ({ methodResponses: [['error', { type: 'unsupportedSort' }, 'asc']] })),
  },
}));

import { generateAccountId } from '../../lib/account-utils';
import * as emailApi from '../../api/email';
import { beginOwnWrite, recordOwnEmailWrites, resetOwnWrites } from '../../api/own-writes';
import type { JMAPMethodCall } from '../../api/types';
import { useEmailStore } from '../email-store';

const SERVER = 'https://mail.example.com';
const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const row = (id: string, keywords: Record<string, boolean> = {}) =>
  ({ id, threadId: `t-${id}`, keywords, mailboxIds: { 'mb-1': true } } as any);
const inboxFolder = (totalEmails: number) => ({ id: 'mb-1', name: 'Inbox', role: 'inbox', totalEmails, unreadEmails: 0 } as any);

function openInbox(emails: any[], extra: Record<string, unknown> = {}) {
  useEmailStore.setState({
    activeAccountId: generateAccountId('test@example.com', SERVER),
    mailboxes: [inboxFolder(emails.length)],
    mailboxState: 'mbs-1',
    currentMailboxId: 'mb-1',
    emails,
    totalEmails: emails.length,
    queryState: 'q-1',
    emailStates: { 'mb-1': 'em-1' },
    mailboxSnapshots: { 'mb-1': { emails, total: emails.length, queryState: 'q-1' } },
    ...extra,
  });
}

// What jmapClient.request logs for an Email/set that went through.
function ownSet(args: Record<string, unknown>, result: Record<string, unknown>, oldState: string, newState: string) {
  const calls: JMAPMethodCall[] = [['Email/set', { accountId: 'acc-1', ...args }, '0']];
  recordOwnEmailWrites(SERVER, calls, [['Email/set', { accountId: 'acc-1', oldState, newState, ...result }, '0']]);
}

// The folder counts the echo's Mailbox change brings.
function folderCountsBecome(totalEmails: number) {
  mock(emailApi.getMailboxChanges).mockResolvedValue({
    oldState: 'mbs-1', newState: 'mbs-2', hasMoreChanges: false, created: [], updated: ['mb-1'], destroyed: [],
  });
  mock(emailApi.getMailboxesByIds).mockResolvedValue({ list: [inboxFolder(totalEmails)], state: 'mbs-2' });
}

function listWasReRead(): boolean {
  return [emailApi.getEmailQueryChanges, emailApi.getEmailChanges, emailApi.queryEmailPage, emailApi.getEmailsWithState]
    .some((fn) => mock(fn).mock.calls.length > 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOwnWrites();
  useEmailStore.getState().reset();
});

describe('echo of our own writes', () => {
  it('takes in a mark-read without re-reading the list', async () => {
    openInbox([row('e1'), row('e2')]);
    await useEmailStore.getState().markRead('e1');
    ownSet({ update: { e1: { 'keywords/$seen': true } } }, { updated: { e1: null } }, 'em-1', 'em-2');
    folderCountsBecome(2);

    await useEmailStore.getState().handleStateChange({
      '@type': 'StateChange', changed: { 'acc-1': { Email: 'em-2', Mailbox: 'mbs-2', Thread: 'th-2' } },
    });

    expect(listWasReRead()).toBe(false);
    // Unread counts did change: the folder list is diffed, but no shared
    // account is re-read for a change to the user's own folders.
    expect(emailApi.getMailboxChanges).toHaveBeenCalledTimes(1);
    expect(emailApi.getSharedMailboxes).not.toHaveBeenCalled();
    const state = useEmailStore.getState();
    expect(state.emailStates['mb-1']).toBe('em-2');
    expect(state.emails[0].keywords).toEqual({ $seen: true });
    expect(state.mailboxSnapshots['mb-1'].emails[0].keywords).toEqual({ $seen: true });
  });

  it('takes in a move out of the folder and keeps the total right for load-more', async () => {
    openInbox([row('e1'), row('e2'), row('e3')]);
    await useEmailStore.getState().moveToMailbox('e2', 'mb-1', 'mb-9');
    ownSet({ update: { e2: { 'mailboxIds/mb-1': null, 'mailboxIds/mb-9': true } } }, { updated: { e2: null } }, 'em-1', 'em-2');
    folderCountsBecome(2);

    await useEmailStore.getState().handleStateChange({
      '@type': 'StateChange', changed: { 'acc-1': { Email: 'em-2', Mailbox: 'mbs-2' } },
    });

    expect(listWasReRead()).toBe(false);
    const state = useEmailStore.getState();
    expect(state.emails.map((e) => e.id)).toEqual(['e1', 'e3']);
    expect(state.totalEmails).toBe(2);
    expect(state.mailboxSnapshots['mb-1']).toEqual({ emails: state.emails, total: 2, queryState: 'q-1' });
  });

  it('takes in a sent message and a reply flag on a row (one send)', async () => {
    openInbox([row('e1'), row('e2')]);
    recordOwnEmailWrites(SERVER, [
      ['Email/set', { accountId: 'acc-1', create: { draft: { mailboxIds: { drafts: true } } } }, '0'],
      ['EmailSubmission/set', {
        accountId: 'acc-1',
        onSuccessUpdateEmail: { '#sub-1': { mailboxIds: { sent: true }, 'keywords/$draft': null } },
      }, '1'],
    ], [
      ['Email/set', { accountId: 'acc-1', oldState: 'em-1', newState: 'em-2', created: { draft: { id: 'n1' } } }, '0'],
      ['EmailSubmission/set', { accountId: 'acc-1', created: { 'sub-1': { id: 's1' } } }, '1'],
      ['Email/set', { accountId: 'acc-1', oldState: 'em-2', newState: 'em-3', updated: { n1: null } }, '1'],
    ]);
    ownSet({ destroy: ['old-draft'] }, { destroyed: ['old-draft'] }, 'em-3', 'em-4');
    ownSet({ update: { e2: { 'keywords/$answered': true } } }, { updated: { e2: null } }, 'em-4', 'em-5');

    await useEmailStore.getState().handleStateChange({
      '@type': 'StateChange', changed: { 'acc-1': { Email: 'em-5', EmailSubmission: 'sub-2' } },
    });

    expect(listWasReRead()).toBe(false);
    expect(emailApi.getMailboxChanges).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails[1].keywords).toEqual({ $answered: true });
    expect(useEmailStore.getState().emailStates['mb-1']).toBe('em-5');
  });

  it('refreshes as before when anything else changed as well', async () => {
    openInbox([row('e1'), row('e2')]);
    ownSet({ update: { e1: { 'keywords/$flagged': true } } }, { updated: { e1: null } }, 'em-1', 'em-2');

    await useEmailStore.getState().handleStateChange({
      '@type': 'StateChange', changed: { 'acc-1': { Email: 'em-3' } },
    });

    expect(emailApi.getEmailQueryChanges).toHaveBeenCalledTimes(1);
  });

  it('refreshes when new mail was delivered', async () => {
    openInbox([row('e1')]);
    ownSet({ update: { e1: { 'keywords/$flagged': true } } }, { updated: { e1: null } }, 'em-1', 'em-2');

    await useEmailStore.getState().handleStateChange({
      '@type': 'StateChange', changed: { 'acc-1': { Email: 'em-2', EmailDelivery: 'd-1' } },
    });

    expect(emailApi.getEmailQueryChanges).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the folder count shows a message we do not hold left it', async () => {
    openInbox([row('e1'), row('e2')], { totalEmails: 40, mailboxes: [inboxFolder(40)] });
    ownSet({ destroy: ['e30'] }, { destroyed: ['e30'] }, 'em-1', 'em-2');
    folderCountsBecome(39);

    await useEmailStore.getState().handleStateChange({
      '@type': 'StateChange', changed: { 'acc-1': { Email: 'em-2', Mailbox: 'mbs-2' } },
    });

    expect(emailApi.getEmailQueryChanges).toHaveBeenCalledTimes(1);
  });

  it('refreshes when a pinned row moves', async () => {
    openInbox([row('e1'), row('e2')]);
    ownSet({ update: { e2: { 'keywords/$pinned': true } } }, { updated: { e2: null } }, 'em-1', 'em-2');

    await useEmailStore.getState().handleStateChange({
      '@type': 'StateChange', changed: { 'acc-1': { Email: 'em-2' } },
    });

    expect(emailApi.getEmailQueryChanges).toHaveBeenCalledTimes(1);
  });

  it('waits for a write whose push overtook its response', async () => {
    openInbox([row('e1')]);
    const calls: JMAPMethodCall[] = [['Email/set', { accountId: 'acc-1', update: { e1: { 'keywords/$flagged': true } } }, '0']];
    const settled = beginOwnWrite(calls);

    const handled = useEmailStore.getState().handleStateChange({
      '@type': 'StateChange', changed: { 'acc-1': { Email: 'em-2' } },
    });
    await new Promise((r) => setTimeout(r, 5));
    recordOwnEmailWrites(SERVER, calls, [['Email/set', { accountId: 'acc-1', oldState: 'em-1', newState: 'em-2', updated: { e1: null } }, '0']]);
    settled();
    await handled;

    expect(listWasReRead()).toBe(false);
    expect(useEmailStore.getState().emails[0].keywords).toEqual({ $flagged: true });
  });
});

describe('folder pushes', () => {
  it('re-reads only the shared accounts when only a shared folder changed', async () => {
    openInbox([row('e1')]);

    await useEmailStore.getState().handleStateChange({
      '@type': 'StateChange', changed: { 'grp-1': { Mailbox: 'g-2' } },
    });

    expect(emailApi.getSharedMailboxes).toHaveBeenCalledTimes(1);
    expect(emailApi.getMailboxChanges).not.toHaveBeenCalled();
  });

  it('does nothing for a folder state it already holds', async () => {
    openInbox([row('e1')]);

    await useEmailStore.getState().handleStateChange({
      '@type': 'StateChange', changed: { 'acc-1': { Mailbox: 'mbs-1' } },
    });

    expect(emailApi.getMailboxChanges).not.toHaveBeenCalled();
    expect(emailApi.getSharedMailboxes).not.toHaveBeenCalled();
  });

  it('still reads both parts on an explicit fetch', async () => {
    useEmailStore.setState({ activeAccountId: generateAccountId('test@example.com', SERVER) });
    await useEmailStore.getState().fetchMailboxes();
    expect(emailApi.getMailboxesWithState).toHaveBeenCalledTimes(1);
    expect(emailApi.getSharedMailboxes).toHaveBeenCalledTimes(1);
  });
});
