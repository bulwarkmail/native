import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The error classes are the real ones: the store tells them apart.
vi.mock('../../api/email', async (importOriginal) => {
  const { RescheduleLostError, RescheduleRestoredError } = await importOriginal<typeof import('../../api/email')>();
  return {
    RescheduleLostError,
    RescheduleRestoredError,
    cancelScheduledSend: vi.fn(async () => undefined),
    rescheduleScheduledSend: vi.fn(async () => ({ emailSubmissionId: 'sub-2' })),
    restoreEmailToDraft: vi.fn(async () => undefined),
    getFullEmail: vi.fn(),
  };
});

// The login the client serves: me@example.com on mail.example.com, whose
// own JMAP account is 'primary'. Tests switch it to another server.
const { client } = vi.hoisted(() => ({
  client: {
    accountId: 'primary',
    connectedAccountId: 'primary' as string | null,
    isConnected: true,
    username: 'me@example.com' as string | null,
    serverUrl: 'https://mail.example.com' as string | null,
  },
}));
vi.mock('../../api/jmap-client', () => ({
  jmapClient: client,
  RequestTimeoutError: class RequestTimeoutError extends Error {},
}));

const LOGIN = 'me@example.com@mail.example.com';
const OTHER_LOGIN = 'me@example.com@other.example.org';

/** Switch the app to the same user on another server, whose own account is also 'primary'. */
function switchToOtherServer() {
  useAccountStore.setState({ activeAccountId: OTHER_LOGIN });
  client.serverUrl = 'https://other.example.org';
}

// Background work nobody waits for: it never settles here.
vi.mock('../../api/submissions', () => ({
  pruneEmailSubmissions: vi.fn(() => new Promise<number>(() => undefined)),
}));

import * as emailApi from '../../api/email';
import { RescheduleLostError, RescheduleRestoredError } from '../../api/email';
import * as submissions from '../../api/submissions';
import { NoLongerScheduledError, RecipientsRefusedError, SubmissionQuotaError } from '../../api/jmap-result';
import type { Email, Mailbox } from '../../api/types';
import { useSendUndoStore, restoreUndoneSend, type PendingUndoSend } from '../send-undo-store';
import { useToastStore } from '../toast-store';
import { useAccountStore } from '../account-store';

const api = vi.mocked(emailApi);
const prune = vi.mocked(submissions.pruneEmailSubmissions);

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
  useToastStore.getState().clearToasts();
  api.getFullEmail.mockResolvedValue({ id: 'mail-1', subject: 'Re: hi' } as Email);
  client.serverUrl = 'https://mail.example.com';
  useAccountStore.setState({ activeAccountId: LOGIN });
});

afterEach(() => {
  vi.restoreAllMocks();
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
        login: LOGIN,
      });
    });

    it('names the own account and the login of an own-account send', () => {
      useSendUndoStore.getState().recordHeldSend(HELD, 10, { identityId: 'id-1', from: [SENDER] });
      expect(useSendUndoStore.getState().pending).toMatchObject({ accountId: 'primary', login: LOGIN });
    });

    it('keeps the login the sender sent through when a switch landed during the send', () => {
      client.serverUrl = 'https://other.example.org';
      useSendUndoStore.getState().recordHeldSend(HELD, 10, { identityId: 'id-1', login: LOGIN, accountId: 'primary' });
      expect(useSendUndoStore.getState().pending?.login).toBe(LOGIN);
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
      useSendUndoStore.getState().recordHeldSend(HELD, 10, { identityId: 'id-1', from: [SENDER] });
      await useSendUndoStore.getState().undo();
      expect(api.cancelScheduledSend).toHaveBeenCalledWith('sub-1', 'primary');
    });

    // GHSA-8x23: the same user on another server has an account 'primary'
    // too, with its own submission 'sub-1'.
    it('cancels nothing in another login, and says where the message was sent from', async () => {
      useAccountStore.setState({
        accounts: [{ id: LOGIN, email: 'me@example.com', displayName: 'Me' } as never],
      });
      useSendUndoStore.getState().recordHeldSend(HELD, 10, { identityId: 'id-1', from: [SENDER] });
      const pending = useSendUndoStore.getState().pending;
      // The switch is still under way: the bar is up and the client serves the other server.
      client.serverUrl = 'https://other.example.org';

      await expect(useSendUndoStore.getState().undo()).resolves.toBe(false);
      await expect(useSendUndoStore.getState().sendNow()).resolves.toBe(false);

      expect(api.cancelScheduledSend).not.toHaveBeenCalled();
      expect(api.rescheduleScheduledSend).not.toHaveBeenCalled();
      expect(useToastStore.getState().toasts[0]).toMatchObject({
        type: 'error',
        message: expect.stringContaining('me@example.com'),
      });
      expect(useSendUndoStore.getState().pending).toBe(pending);
      await expect(restoreUndoneSend(pending!, MAILBOXES)).rejects.toThrow();
      expect(api.restoreEmailToDraft).not.toHaveBeenCalled();
      useAccountStore.setState({ accounts: [] });
    });

    it('takes the undo bar away once another login is active', () => {
      useSendUndoStore.getState().recordHeldSend(HELD, 10, { identityId: 'id-1', from: [SENDER] });
      switchToOtherServer();
      expect(useSendUndoStore.getState().pending).toBeNull();
    });

    it('keeps the undo bar while the same login stays active', () => {
      useSendUndoStore.getState().recordHeldSend(HELD, 10, { identityId: 'id-1', from: [SENDER] });
      useAccountStore.setState({ defaultAccountId: LOGIN });
      expect(useSendUndoStore.getState().pending).not.toBeNull();
    });

    it('keeps the entry when the cancel fails, and says so', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      api.cancelScheduledSend.mockRejectedValueOnce(new Error('gone'));
      const pending = entry();
      useSendUndoStore.getState().setPending(pending);
      await expect(useSendUndoStore.getState().undo()).resolves.toBe(false);
      expect(useSendUndoStore.getState()).toMatchObject({ pending, busy: false });
      // Silence would read as "undone" while the mail may be on its way.
      expect(useToastStore.getState().toasts).toMatchObject([{ type: 'error', title: 'Undo send failed', message: 'gone' }]);
      expect(prune).not.toHaveBeenCalled();
    });

    it('starts a prune of submission records after an undo and after send now, without waiting for it', async () => {
      useSendUndoStore.getState().setPending(entry());
      await expect(useSendUndoStore.getState().undo()).resolves.toBe(true);
      expect(prune).toHaveBeenCalledTimes(1);

      useSendUndoStore.getState().setPending(entry());
      await expect(useSendUndoStore.getState().sendNow()).resolves.toBe(true);
      expect(prune).toHaveBeenCalledTimes(2);
    });

    // The original is cancelled before the release is made (#1308): when the
    // release is refused, the original is put back under a new id, which
    // Undo cancels from then on.
    it('explains a send now refused for a full submission quota (Stalwart 1.0), and follows the put-back original', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      api.rescheduleScheduledSend.mockRejectedValueOnce(new RescheduleRestoredError(new SubmissionQuotaError(
        'There are too many email submissions, please delete some before adding a new one.',
        true,
      ), 'sub-9', '2026-09-24T10:00:10Z'));
      useSendUndoStore.getState().setPending(entry());

      await expect(useSendUndoStore.getState().sendNow()).resolves.toBe(false);

      expect(useToastStore.getState().toasts).toMatchObject([{
        type: 'error',
        title: 'Could not send now',
        message: expect.stringContaining('ask your administrator to raise the email submission limit'),
      }]);
      // Still held: it goes out when the delay ends, and Undo cancels the put-back one.
      expect(useSendUndoStore.getState().pending).toMatchObject({ emailSubmissionId: 'sub-9', emailId: 'mail-1' });
      await useSendUndoStore.getState().undo();
      expect(api.cancelScheduledSend).toHaveBeenCalledWith('sub-9', undefined);
    });

    it('drops the entry when the message went out before send now could cancel it', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      api.rescheduleScheduledSend.mockRejectedValueOnce(new NoLongerScheduledError(true));
      useSendUndoStore.getState().setPending(entry());

      await expect(useSendUndoStore.getState().sendNow()).resolves.toBe(false);

      expect(useToastStore.getState().toasts).toMatchObject([{
        type: 'error',
        title: 'Could not send now',
        message: 'This message was already sent.',
      }]);
      // Nothing is left to undo.
      expect(useSendUndoStore.getState()).toMatchObject({ pending: null, busy: false });
    });

    // A throttle used up since the send was taken (Stalwart 0.16 and 1.0 check
    // the recipients again for the release): the original was put back, and a
    // "not sent" would invite sending it a second time.
    it('says the held message is still scheduled when the server refused a recipient of the release', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      api.rescheduleScheduledSend.mockRejectedValueOnce(new RescheduleRestoredError(new RecipientsRefusedError([
        { email: 'you@example.com', smtpReply: '452 4.4.5 Rate limit exceeded, try again later.' },
      ]), 'sub-9'));
      useSendUndoStore.getState().setPending(entry());

      await expect(useSendUndoStore.getState().sendNow()).resolves.toBe(false);

      expect(useToastStore.getState().toasts).toMatchObject([{
        type: 'error',
        title: 'The message is still scheduled.',
        message: 'Nothing was changed: the server refused you@example.com (452 4.4.5 Rate limit exceeded, try again later.).',
      }]);
      // It still goes out when the delay ends, and can still be undone.
      expect(useSendUndoStore.getState()).toMatchObject({ pending: { emailSubmissionId: 'sub-9' }, busy: false });
    });

    it('drops the entry and points to Drafts when neither the release nor the original could be made', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      api.rescheduleScheduledSend.mockRejectedValueOnce(new RescheduleLostError(new Error('Quota exceeded'), true));
      useSendUndoStore.getState().setPending(entry());

      await expect(useSendUndoStore.getState().sendNow()).resolves.toBe(false);

      expect(useToastStore.getState().toasts).toMatchObject([{
        type: 'error',
        title: 'Could not send now',
        message: expect.stringContaining('back in Drafts'),
      }]);
      expect(useSendUndoStore.getState()).toMatchObject({ pending: null, busy: false });
    });

    it('names the recipients the server refused for the release while the others get it', async () => {
      api.rescheduleScheduledSend.mockResolvedValueOnce({
        emailSubmissionId: 'sub-2',
        refusedRecipients: [{ email: 'nobody@example.net', smtpReply: '550 5.1.2 Relay not allowed.' }],
      });
      useSendUndoStore.getState().setPending(entry());

      await expect(useSendUndoStore.getState().sendNow()).resolves.toBe(true);

      expect(useToastStore.getState().toasts).toMatchObject([{
        type: 'warning',
        title: 'Not sent to everyone',
        message: 'The server refused nobody@example.net (550 5.1.2 Relay not allowed.). The other recipients get the message.',
      }]);
      expect(useSendUndoStore.getState().pending).toBeNull();
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
