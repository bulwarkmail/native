import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/email', () => ({
  cancelScheduledSend: vi.fn(async () => undefined),
  rescheduleScheduledSend: vi.fn(async () => ({ emailSubmissionId: 'sub-2' })),
  restoreEmailToDraft: vi.fn(async () => undefined),
  getFullEmail: vi.fn(),
}));

const client = vi.hoisted(() => ({
  accountId: 'primary',
  isConnected: true,
  connectionGen: 3,
  username: 'me@example.com',
  serverUrl: 'https://mail.example.com',
}));
vi.mock('../../api/jmap-client', () => ({ jmapClient: client }));

import * as emailApi from '../../api/email';
import type { Email, Mailbox } from '../../api/types';
import { useSendUndoStore, restoreUndoneSend, type PendingUndoSend } from '../send-undo-store';
import { registerServedAccount } from './helpers/served-account';

const api = vi.mocked(emailApi);

const HELD = { scheduled: true, emailSubmissionId: 'sub-1', emailId: 'mail-1', sendAt: '2026-09-24T10:00:10Z' };
const SENDER = { name: 'Me', email: 'me@example.com' };

function mailbox(role: string, id: string, shared?: { accountId: string }): Mailbox {
  return {
    id: shared ? `${shared.accountId}:${id}` : id,
    originalId: shared ? id : undefined,
    name: role,
    role,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {} as Mailbox['myRights'],
    accountId: shared?.accountId,
    isShared: !!shared,
  };
}

const MAILBOXES = [
  mailbox('drafts', 'own-drafts'),
  mailbox('sent', 'own-sent'),
  mailbox('drafts', 'team-drafts', { accountId: 'team' }),
  mailbox('sent', 'team-sent', { accountId: 'team' }),
];

// The app account the client serves; held sends record it as their sender.
let APP: string;
/** JMAP account `accountId` on the client's connection (gen 3). */
const scope = (accountId: string) => ({ gen: 3, accountId });

function entry(overrides: Partial<PendingUndoSend> = {}): PendingUndoSend {
  return {
    appAccountId: APP,
    emailSubmissionId: 'sub-1',
    emailId: 'mail-1',
    identityId: 'id-1',
    from: [SENDER],
    delaySeconds: 10,
    createdAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  client.username = 'me@example.com';
  APP = registerServedAccount('me@example.com', 'https://mail.example.com');
  useSendUndoStore.setState({ pending: null, busy: false, restoredEmailId: null });
  api.getFullEmail.mockResolvedValue({ id: 'mail-1', subject: 'Re: hi' } as Email);
});

describe('send-undo-store', () => {
  describe('recordHeldSend', () => {
    it('offers undo for a send held by the delay', () => {
      const ok = useSendUndoStore.getState().recordHeldSend(HELD, 10, {
        identityId: 'id-1',
        accountId: 'team',
        appAccountId: APP,
        from: [SENDER],
      });
      expect(ok).toBe(true);
      expect(useSendUndoStore.getState().pending).toMatchObject({
        appAccountId: APP,
        emailSubmissionId: 'sub-1',
        emailId: 'mail-1',
        identityId: 'id-1',
        accountId: 'team',
        from: [SENDER],
        sendAt: HELD.sendAt,
        delaySeconds: 10,
      });
    });

    it('records nothing for a send that went out at once', () => {
      const store = useSendUndoStore.getState();
      expect(store.recordHeldSend({ scheduled: false, emailSubmissionId: 'sub-1', emailId: 'mail-1' }, undefined, { identityId: 'id-1' })).toBe(false);
      expect(store.recordHeldSend(HELD, undefined, { identityId: 'id-1' })).toBe(false);
      expect(store.recordHeldSend(HELD, 0, { identityId: 'id-1' })).toBe(false);
      expect(useSendUndoStore.getState().pending).toBeNull();
    });

    it('records nothing when the server named no submission or message', () => {
      const store = useSendUndoStore.getState();
      expect(store.recordHeldSend({ ...HELD, emailSubmissionId: undefined }, 10, { identityId: 'id-1' })).toBe(false);
      expect(store.recordHeldSend({ ...HELD, emailId: undefined }, 10, { identityId: 'id-1' })).toBe(false);
      expect(useSendUndoStore.getState().pending).toBeNull();
    });
  });

  describe('undo and send now', () => {
    it('cancels the submission in the account holding it', async () => {
      useSendUndoStore.getState().setPending(entry({ accountId: 'team' }));
      await expect(useSendUndoStore.getState().undo()).resolves.toBe(true);
      expect(api.cancelScheduledSend).toHaveBeenCalledWith('sub-1', scope('team'));
      expect(useSendUndoStore.getState()).toMatchObject({ pending: null, busy: false, restoredEmailId: 'mail-1' });
    });

    it('cancels an own-account send in the primary account', async () => {
      useSendUndoStore.getState().setPending(entry());
      await useSendUndoStore.getState().undo();
      expect(api.cancelScheduledSend).toHaveBeenCalledWith('sub-1', scope('primary'));
    });

    it('keeps the entry when the cancel fails', async () => {
      api.cancelScheduledSend.mockRejectedValueOnce(new Error('gone'));
      const pending = entry();
      useSendUndoStore.getState().setPending(pending);
      await expect(useSendUndoStore.getState().undo()).resolves.toBe(false);
      expect(useSendUndoStore.getState()).toMatchObject({ pending, busy: false });
    });

    it('releases the held message from the account holding it', async () => {
      useSendUndoStore.getState().setPending(entry({ accountId: 'team' }));
      await expect(useSendUndoStore.getState().sendNow()).resolves.toBe(true);
      expect(api.rescheduleScheduledSend).toHaveBeenCalledWith(
        expect.objectContaining({ emailSubmissionId: 'sub-1', emailId: 'mail-1', identityId: 'id-1', accountId: scope('team') }),
        0,
      );
      expect(useSendUndoStore.getState().pending).toBeNull();
    });
  });

  // R16: Undo and Send now name the held send's submission and message ids,
  // which repeat in other accounts. After a switch they act on nothing.
  describe('after an account switch', () => {
    it('Undo and Send now send nothing while the client serves another account, and withdraw the bar', async () => {
      useSendUndoStore.getState().setPending(entry());
      // The client now serves B.
      client.username = 'bob@example.com';
      await expect(useSendUndoStore.getState().undo()).resolves.toBe(false);
      expect(useSendUndoStore.getState().pending).toBeNull();
      useSendUndoStore.getState().setPending(entry());
      await expect(useSendUndoStore.getState().sendNow()).resolves.toBe(false);
      expect(useSendUndoStore.getState().pending).toBeNull();
      expect(api.cancelScheduledSend).not.toHaveBeenCalled();
      expect(api.rescheduleScheduledSend).not.toHaveBeenCalled();
    });

    it('acts on nothing for a held send that does not name its account', async () => {
      useSendUndoStore.getState().setPending(entry({ appAccountId: undefined }));
      await expect(useSendUndoStore.getState().undo()).resolves.toBe(false);
      expect(api.cancelScheduledSend).not.toHaveBeenCalled();
    });

    it('does not restore the message into the folders of another account', async () => {
      await expect(restoreUndoneSend(entry(), MAILBOXES, 'bob@b.example.com')).rejects.toThrow(/not active/);
      client.username = 'bob@example.com';
      await expect(restoreUndoneSend(entry(), MAILBOXES, APP)).rejects.toThrow(/not active/);
      expect(api.restoreEmailToDraft).not.toHaveBeenCalled();
      expect(api.getFullEmail).not.toHaveBeenCalled();
    });
  });

  describe('restoreUndoneSend', () => {
    it('moves an own-account message back into the own Drafts', async () => {
      const draft = await restoreUndoneSend(entry(), MAILBOXES, APP);
      expect(api.restoreEmailToDraft).toHaveBeenCalledWith('mail-1', 'own-drafts', 'own-sent', scope('primary'));
      expect(api.getFullEmail).toHaveBeenCalledWith('mail-1', scope('primary'));
      expect(draft).toMatchObject({ id: 'mail-1', jmapAccountId: undefined });
    });

    it('moves a shared-account reply back into that account\'s Drafts', async () => {
      const draft = await restoreUndoneSend(entry({ accountId: 'team' }), MAILBOXES, APP);
      expect(api.restoreEmailToDraft).toHaveBeenCalledWith('mail-1', 'team-drafts', 'team-sent', scope('team'));
      expect(api.getFullEmail).toHaveBeenCalledWith('mail-1', scope('team'));
      expect(draft).toMatchObject({ id: 'mail-1', jmapAccountId: 'team' });
    });

    it('treats the primary account named explicitly as the own account', async () => {
      const draft = await restoreUndoneSend(entry({ accountId: 'primary' }), MAILBOXES, APP);
      expect(api.restoreEmailToDraft).toHaveBeenCalledWith('mail-1', 'own-drafts', 'own-sent', scope('primary'));
      expect(draft.jmapAccountId).toBeUndefined();
    });

    // An undo to fix a typo must not quietly drop the security option.
    it('reopens with the delivery options the message was sent with', async () => {
      const draft = await restoreUndoneSend(entry({ requireTls: true, requestDsn: true }), MAILBOXES, APP);
      expect(draft).toMatchObject({ requireTls: true, requestDsn: true });
      const plain = await restoreUndoneSend(entry(), MAILBOXES, APP);
      expect(plain).not.toHaveProperty('requireTls');
      expect(plain).not.toHaveProperty('requestDsn');
    });

    it('records the delivery options with the held send', () => {
      useSendUndoStore.getState().recordHeldSend(HELD, 10, { identityId: 'id-1', appAccountId: APP, requireTls: true });
      expect(useSendUndoStore.getState().pending).toMatchObject({ requireTls: true });
    });

    it('still opens the message when the account has no Drafts folder', async () => {
      const draft = await restoreUndoneSend(entry({ accountId: 'team' }), MAILBOXES.slice(0, 2), APP);
      expect(api.restoreEmailToDraft).not.toHaveBeenCalled();
      expect(draft.id).toBe('mail-1');
    });
  });
});
