// A message sent with the undo-send delay: the submission is held by the
// server (HOLDFOR) and can still be cancelled or released early. The composer
// and the viewer's quick reply record it here after a delayed send; the
// UndoSnackbar, which every screen hosts, offers "Undo" / "Send now" for the
// length of the window (webmail `pendingUndoSend`, changelog 1.7.0).

import { create } from 'zustand';
import {
  cancelScheduledSend, getFullEmail, rescheduleScheduledSend, restoreEmailToDraft,
  type SendEmailResult,
} from '../api/email';
import { jmapClient } from '../api/jmap-client';
import { NoLongerScheduledError } from '../api/jmap-result';
import { pruneEmailSubmissions } from '../api/submissions';
import type { EmailAddress, Mailbox } from '../api/types';
import { draftContextFromEmail } from '../lib/draft-context';
import { composerLoginMoved, servedLoginOf } from '../lib/draft-login';
import { mailboxesOfAccount } from '../lib/mailbox-tree';
import { useAccountStore } from './account-store';
import { rescheduleErrorNotice, rescheduleLostMessage, restoredSubmission } from '../lib/compose-reschedule';
import { partlyRefusedWarning } from '../lib/send-failure-message';
import type { ComposeDraftContext } from '../navigation/types';
import { t } from './locale-store';
import { toast } from './toast-store';

export interface PendingUndoSend {
  emailSubmissionId: string;
  emailId: string;
  identityId: string;
  /**
   * JMAP account holding the submission: a shared account for a send from
   * its identity, else the login's own. Recorded either way: submission ids
   * repeat across accounts and servers.
   */
  accountId?: string;
  /**
   * The login (registry id, lib/draft-login) the message was sent through.
   * Undo and Send now act through that login only: after a switch the same
   * submission id names another message on the other server (webmail
   * GHSA-8x23).
   */
  login?: string | null;
  from?: EmailAddress[];
  to?: EmailAddress[];
  /** ISO time the server will release the message. */
  sendAt?: string;
  /** Milliseconds the message is held (drives the snackbar timer). */
  delaySeconds: number;
  createdAt: number;
}

/** What the sender knows about a held send beyond the server's answer. */
export type HeldSendDetails = Pick<PendingUndoSend, 'identityId' | 'accountId' | 'from' | 'to' | 'login'>;

/** The login the JMAP client works for now, or the registry's active one while it connects. */
export function currentSendLogin(): string | null {
  return servedLoginOf(jmapClient) ?? useAccountStore.getState().activeAccountId;
}

/** Whether Undo or Send now of `entry` would now go through another login. */
export function pendingSendLoginMoved(entry: Pick<PendingUndoSend, 'login'>): boolean {
  return composerLoginMoved(entry.login, {
    activeAccountId: useAccountStore.getState().activeAccountId,
    servedLogin: servedLoginOf(jmapClient),
  });
}

function refuseOtherLogin(entry: PendingUndoSend): void {
  const owner = entry.login ? useAccountStore.getState().getAccountById(entry.login) : undefined;
  toast.error(
    t('email_composer.undo_send_other_login', 'This message was sent from another account'),
    t(
      'email_composer.undo_send_other_login_body',
      'Switch back to {account} to undo it or send it now. It goes out when the delay ends.',
      { account: owner?.email || owner?.displayName || '' },
    ),
  );
}

/**
 * Whole seconds until a held send goes out, counted on this device's clock
 * from when the delay started: the bar counts down "Sending in 10s…",
 * "Sending in 9s…" and so on. Never below 1, since the bar closes a second
 * before the release.
 */
export function undoSendSecondsLeft(entry: Pick<PendingUndoSend, 'createdAt' | 'delaySeconds'>, now: number): number {
  const left = Math.ceil((entry.createdAt + entry.delaySeconds * 1000 - now) / 1000);
  return Math.max(1, Math.min(entry.delaySeconds, left));
}

/** The undo bar's text for a held send at `now`. */
export function undoSendLabel(entry: Pick<PendingUndoSend, 'createdAt' | 'delaySeconds'>, now: number): string {
  return t('email_composer.undo_send_label', 'Sending in {seconds}s…', { seconds: undoSendSecondsLeft(entry, now) });
}

interface SendUndoState {
  pending: PendingUndoSend | null;
  busy: boolean;
  /** Set after an undo so the composer can be reopened with the draft. */
  restoredEmailId: string | null;
  setPending: (entry: PendingUndoSend) => void;
  /**
   * Offer undo for a send held by the undo-send delay. Records nothing, and
   * returns false, when the message went out at once or the server named no
   * submission to cancel.
   */
  recordHeldSend: (
    result: SendEmailResult,
    holdForSeconds: number | undefined,
    details: HeldSendDetails,
  ) => boolean;
  clear: () => void;
  /** Cancel delivery. The message stays in Sent; the caller may re-open it. */
  undo: () => Promise<boolean>;
  /** Release the held message immediately. */
  sendNow: () => Promise<boolean>;
}

export const useSendUndoStore = create<SendUndoState>((set, get) => ({
  pending: null,
  busy: false,
  restoredEmailId: null,

  setPending: (entry) => set({ pending: entry, restoredEmailId: null }),
  recordHeldSend: (result, holdForSeconds, details) => {
    if (!holdForSeconds || !result.scheduled || !result.emailSubmissionId || !result.emailId) return false;
    get().setPending({
      ...details,
      accountId: details.accountId ?? jmapClient.connectedAccountId ?? undefined,
      // The sender reads the login before it sends; a switch may land while
      // the request is out.
      login: details.login !== undefined ? details.login : currentSendLogin(),
      emailSubmissionId: result.emailSubmissionId,
      emailId: result.emailId,
      sendAt: result.sendAt,
      delaySeconds: holdForSeconds,
      createdAt: Date.now(),
    });
    return true;
  },
  clear: () => set({ pending: null, busy: false }),

  undo: async () => {
    const entry = get().pending;
    if (!entry || get().busy) return false;
    if (pendingSendLoginMoved(entry)) {
      refuseOtherLogin(entry);
      return false;
    }
    set({ busy: true });
    try {
      await cancelScheduledSend(entry.emailSubmissionId, entry.accountId);
      set({ pending: null, busy: false, restoredEmailId: entry.emailId });
      void pruneEmailSubmissions();
      return true;
    } catch (err) {
      console.warn('[send-undo] cancel failed', err);
      // Silence here reads as "undone" while the mail may be on its way.
      toast.error(
        t('email_viewer.undo_send_failed', 'Undo send failed'),
        err instanceof Error ? err.message : undefined,
      );
      set({ busy: false });
      return false;
    }
  },

  sendNow: async () => {
    const entry = get().pending;
    if (!entry || get().busy) return false;
    if (pendingSendLoginMoved(entry)) {
      refuseOtherLogin(entry);
      return false;
    }
    set({ busy: true });
    try {
      const result = await rescheduleScheduledSend(
        {
          emailSubmissionId: entry.emailSubmissionId,
          emailId: entry.emailId,
          identityId: entry.identityId,
          from: entry.from,
          to: entry.to,
          accountId: entry.accountId,
        },
        0,
      );
      set({ pending: null, busy: false });
      void pruneEmailSubmissions();
      // The recipients are checked again for the release; the ones the
      // server refused this time never get the message.
      if (result.refusedRecipients?.length) {
        const { title, message } = partlyRefusedWarning(result.refusedRecipients, t);
        toast.warning(title, { message, duration: 10_000 });
      }
      return true;
    } catch (err) {
      console.warn('[send-undo] send now failed', err);
      // The message stays held and goes out when the delay ends; say why it
      // did not go now: a full submission quota, say, or recipients refused
      // for the release that the held send had been taken for.
      const { title, message } = rescheduleErrorNotice(err, t, t('scheduled.send_now_failed', 'Could not send now'));
      toast.error(title, message);
      // The original was cancelled first and put back under a new id: Undo
      // cancels that one now.
      const restored = restoredSubmission(err);
      if (restored) {
        set({
          pending: { ...entry, emailSubmissionId: restored.emailSubmissionId, sendAt: restored.sendAt ?? entry.sendAt },
          busy: false,
        });
        return false;
      }
      // It went out, was cancelled on another device, or is no longer
      // scheduled at all: nothing is left to undo.
      const gone = err instanceof NoLongerScheduledError || rescheduleLostMessage(err);
      set(gone ? { pending: null, busy: false } : { busy: false });
      return false;
    }
  },
}));

/**
 * After an undo: move the held message back into Drafts and load it for the
 * composer, in the account it was sent from (a quick reply to shared mail
 * goes out of the shared account). Webmail `cancelUndoSend`.
 */
export async function restoreUndoneSend(
  entry: PendingUndoSend,
  mailboxes: Mailbox[],
): Promise<ComposeDraftContext> {
  // The ids name other messages in another login (see pendingSendLoginMoved).
  if (pendingSendLoginMoved(entry)) throw new Error('The account was switched');
  const shared = !!entry.accountId && entry.accountId !== jmapClient.accountId;
  const accountId = shared ? entry.accountId : undefined;
  const scope = mailboxesOfAccount(mailboxes, accountId);
  const drafts = scope.find((m) => m.role === 'drafts');
  const sent = scope.find((m) => m.role === 'sent');
  if (drafts) {
    await restoreEmailToDraft(
      entry.emailId,
      drafts.originalId ?? drafts.id,
      sent ? (sent.originalId ?? sent.id) : undefined,
      accountId,
    );
  }
  return draftContextFromEmail(await getFullEmail(entry.emailId, accountId), accountId);
}

// A switch to another login takes the undo bar away, since its actions
// would reach the other server. The held message still goes out when the
// delay ends; back in its account, Scheduled lists it until then.
useAccountStore.subscribe((state, prev) => {
  if (state.activeAccountId === prev.activeAccountId) return;
  const { pending } = useSendUndoStore.getState();
  if (pending?.login && pending.login !== state.activeAccountId) useSendUndoStore.setState({ pending: null });
});
