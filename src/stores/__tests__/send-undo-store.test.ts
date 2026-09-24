import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/email', () => ({
  cancelScheduledSend: vi.fn(async () => undefined),
  rescheduleScheduledSend: vi.fn(async () => ({ emailSubmissionId: 'sub-2' })),
  restoreEmailToDraft: vi.fn(async () => undefined),
  getFullEmail: vi.fn(),
}));

vi.mock('../../api/jmap-client', () => ({ jmapClient: { accountId: 'primary' } }));

import * as emailApi from '../../api/email';
import type { Email, Mailbox } from '../../api/types';
import { useSendUndoStore, restoreUndoneSend, type PendingUndoSend } from '../send-undo-store';

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

function entry(overrides: Partial<PendingUndoSend> = {}): PendingUndoSend {
  return {
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
  useSendUndoStore.setState({ pending: null, busy: false, restoredEmailId: null });
  api.getFullEmail.mockResolvedValue({ id: 'mail-1', subject: 'Re: hi' } as Email);
});

describe('send-undo-store', () => {
  describe('recordHeldSend', () => {
    it('offers undo for a send held by the delay', () => {
      const ok = useSendUndoStore.getState().recordHeldSend(HELD, 10, {
        identityId: 'id-1',
        accountId: 'team',
        from: [SENDER],
      });
      expect(ok).toBe(true);
      expect(useSendUndoStore.getState().pending).toMatchObject({
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
      expect(api.cancelScheduledSend).toHaveBeenCalledWith('sub-1', 'team');
      expect(useSendUndoStore.getState()).toMatchObject({ pending: null, busy: false, restoredEmailId: 'mail-1' });
    });

    it('cancels an own-account send in the primary account', async () => {
      useSendUndoStore.getState().setPending(entry());
      await useSendUndoStore.getState().undo();
      expect(api.cancelScheduledSend).toHaveBeenCalledWith('sub-1', undefined);
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
        expect.objectContaining({ emailSubmissionId: 'sub-1', emailId: 'mail-1', identityId: 'id-1', accountId: 'team' }),
        0,
      );
      expect(useSendUndoStore.getState().pending).toBeNull();
    });
  });

  describe('restoreUndoneSend', () => {
    it('moves an own-account message back into the own Drafts', async () => {
      const draft = await restoreUndoneSend(entry(), MAILBOXES);
      expect(api.restoreEmailToDraft).toHaveBeenCalledWith('mail-1', 'own-drafts', 'own-sent', undefined);
      expect(api.getFullEmail).toHaveBeenCalledWith('mail-1', undefined);
      expect(draft).toMatchObject({ id: 'mail-1', jmapAccountId: undefined });
    });

    it('moves a shared-account reply back into that account\'s Drafts', async () => {
      const draft = await restoreUndoneSend(entry({ accountId: 'team' }), MAILBOXES);
      expect(api.restoreEmailToDraft).toHaveBeenCalledWith('mail-1', 'team-drafts', 'team-sent', 'team');
      expect(api.getFullEmail).toHaveBeenCalledWith('mail-1', 'team');
      expect(draft).toMatchObject({ id: 'mail-1', jmapAccountId: 'team' });
    });

    it('treats the primary account named explicitly as the own account', async () => {
      const draft = await restoreUndoneSend(entry({ accountId: 'primary' }), MAILBOXES);
      expect(api.restoreEmailToDraft).toHaveBeenCalledWith('mail-1', 'own-drafts', 'own-sent', undefined);
      expect(draft.jmapAccountId).toBeUndefined();
    });

    it('still opens the message when the account has no Drafts folder', async () => {
      const draft = await restoreUndoneSend(entry({ accountId: 'team' }), MAILBOXES.slice(0, 2));
      expect(api.restoreEmailToDraft).not.toHaveBeenCalled();
      expect(draft.id).toBe('mail-1');
    });
  });
});
