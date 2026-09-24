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
import type { EmailAddress, Mailbox } from '../api/types';
import { draftContextFromEmail } from '../lib/draft-context';
import { mailboxesOfAccount } from '../lib/mailbox-tree';
import type { ComposeDraftContext } from '../navigation/types';

export interface PendingUndoSend {
  emailSubmissionId: string;
  emailId: string;
  identityId: string;
  /** Account holding the submission: a shared account for a send from its identity. */
  accountId?: string;
  from?: EmailAddress[];
  to?: EmailAddress[];
  /** ISO time the server will release the message. */
  sendAt?: string;
  /** Milliseconds the message is held (drives the snackbar timer). */
  delaySeconds: number;
  createdAt: number;
}

/** What the sender knows about a held send beyond the server's answer. */
export type HeldSendDetails = Pick<PendingUndoSend, 'identityId' | 'accountId' | 'from' | 'to'>;

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
    set({ busy: true });
    try {
      await cancelScheduledSend(entry.emailSubmissionId, entry.accountId);
      set({ pending: null, busy: false, restoredEmailId: entry.emailId });
      return true;
    } catch (err) {
      console.warn('[send-undo] cancel failed', err);
      set({ busy: false });
      return false;
    }
  },

  sendNow: async () => {
    const entry = get().pending;
    if (!entry || get().busy) return false;
    set({ busy: true });
    try {
      await rescheduleScheduledSend(
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
      return true;
    } catch (err) {
      console.warn('[send-undo] send now failed', err);
      set({ busy: false });
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
