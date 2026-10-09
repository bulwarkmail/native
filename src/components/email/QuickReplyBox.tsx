import React from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator, Alert, Keyboard } from 'react-native';
import { Send, Maximize2 } from 'lucide-react-native';
import type { Email } from '../../api/types';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore } from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';
import { useEmailStore } from '../../stores/email-store';
import { toast } from '../../stores/toast-store';
import { useSendUndoStore } from '../../stores/send-undo-store';
import { opScope } from '../../api/op-scope';
import { sendEmail, patchKeywordsForEmails } from '../../api/email';
import { useNetworkStore } from '../../stores/network-store';
import { useAuthStore } from '../../stores/auth-store';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { useAccountStore } from '../../stores/account-store';
import { useSendQueueStore, SendTooLargeToQueueError, AlreadyQueuedError } from '../../stores/send-queue-store';
import {
  buildQueuedSend, hasQueueAccounts, shouldQueueSend, attachmentsUploaded, findAlreadyQueued, quickReplyOwnerActive, OutboxCheckError,
} from '../../lib/queue-send';
import { generateUUID } from '../../lib/uuid';
import { generateMessageId } from '../../lib/email-threading';
import type { OutgoingEmail } from '../../api/email';
import { jmapClient } from '../../api/jmap-client';
import { queueJmapAccountId } from '../../lib/composer-account';
import { clientServesAccount, recordedJmapAccountId } from '../../lib/active-client-account';
import { buildReplyRecipients } from '../../lib/reply-recipients';
import { buildReplySubject } from '../../lib/subject-prefix';
import { computeReplyThreadingHeaders } from '../../lib/email-threading';
import { resolveReplyIdentity } from '../../lib/reply-identity';
import { signatureIdentityFor, signPlainTextReply } from '../../lib/signature-utils';
import { pickEmailBody, plainTextBody } from '../../lib/email-body';
import { htmlToPlainText } from '../../lib/compose-html';
import { useDateRegion } from '../../lib/use-date-region';
import { mailboxesOfAccount } from '../../lib/mailbox-tree';
import { emailDisplayDate } from '../../lib/email-date';
import { sendErrorAlert } from '../../lib/send-errors';
import { formatRejectedRecipients } from '../../api/jmap-result';
import { buildQuoteHeader, quoteHeaderLabels } from '../../lib/quote-header';
import { untrustedReplyAddresses } from '../../lib/sender-check';
import { authservHostFor } from '../../lib/authserv-host';

interface Props {
  email: Email;
  jmapAccountId?: string;
  /**
   * The app account the viewer was opened in, which owns `email`. The box can
   * remount after an account switch (the message cache is per account), and
   * must still belong to the message it replies to, not the account now shown.
   */
  ownerAppAccountId?: string;
  /** Open the full composer with the draft text carried over. */
  onMoreOptions: (draft: string) => void;
  /** Reflect `$answered` in the caller's cache. */
  onSent?: (email: Email) => void;
}

/**
 * Inline reply box under the message (webmail quick reply): plain-text reply
 * to the sender with the original quoted, sent through the identity that
 * received the message. "More options" hands the text to the full composer.
 */
export function QuickReplyBox({ email, jmapAccountId, ownerAppAccountId, onMoreOptions, onSent }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const dateRegion = useDateRegion();
  const identities = useSettingsStore((s) => s.identities);
  const sendDelaySeconds = useSettingsStore((s) => s.sendDelaySeconds);
  const signaturePosition = useSettingsStore((s) => s.signaturePosition);
  const signatureSeparatorEnabled = useSettingsStore((s) => s.signatureSeparatorEnabled);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const [text, setText] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const sendingRef = React.useRef(false);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  // The app account that owns the message: the viewer's when given, else the
  // one active as the box opened. A reply is sent (or queued) only while that
  // account is both the active one and the one the app shows: the message and
  // its ids belong to it.
  const ownerRef = React.useRef(ownerAppAccountId ?? useAuthStore.getState().activeAccountId);
  // The Message-ID of the reply being written, kept across a failed attempt
  // and dropped once it was sent or queued.
  const messageIdRef = React.useRef<string | null>(null);

  React.useEffect(() => { setText(''); messageIdRef.current = null; }, [email.id]);

  const ownerActiveNow = () => quickReplyOwnerActive(
    ownerRef.current, useAuthStore.getState().activeAccountId, useEmailStore.getState().activeAccountId,
  );
  const ownerLabel = () => {
    const entry = ownerRef.current ? useAccountStore.getState().getAccountById(ownerRef.current) : undefined;
    return entry?.email || entry?.username || ownerRef.current || '';
  };
  const alertOwnerChanged = () => {
    const account = ownerLabel();
    Alert.alert(
      t('email_composer.account_switched_title', 'Account changed'),
      t('email_composer.account_switched_body', 'This message was started in {account}. Switch back to it to send, save or attach files.', { account }),
    );
  };
  const toastAlreadyQueued = () => {
    toast.warning(t('outbox.already_queued', 'This message is already in the Outbox'), {
      action: { label: t('outbox.open', 'Open Outbox'), onPress: () => navigation.navigate('Outbox') },
    });
  };

  const from = email.from?.[0];
  if (!from?.email || email.keywords?.$draft) return null;

  const send = async () => {
    const body = text.trim();
    if (!body || sending || sendingRef.current) return;
    sendingRef.current = true;
    try {
      await sendInner(body);
    } finally {
      sendingRef.current = false;
    }
  };

  const sendInner = async (body: string) => {
    if (!ownerActiveNow()) {
      alertOwnerChanged();
      return;
    }
    let alreadyQueued: Awaited<ReturnType<typeof findAlreadyQueued>>;
    try {
      alreadyQueued = await findAlreadyQueued(ownerRef.current, { messageId: messageIdRef.current });
    } catch (err) {
      if (!(err instanceof OutboxCheckError)) throw err;
      toast.error(t('outbox.check_failed_send', "Couldn't check the Outbox. Try sending again."));
      return;
    }
    if (alreadyQueued) {
      toastAlreadyQueued();
      return;
    }
    const ownEmails = identities.map((i) => i.email).filter(Boolean);
    // The own identity the message was delivered to (or, for our own message,
    // the one that sent it). Never the catch-all From rewrite: this box has no
    // From row to show or correct it.
    const resolved = resolveReplyIdentity(identities, {
      from, to: email.to ?? undefined, cc: email.cc ?? undefined, bcc: email.bcc ?? undefined,
    }, { ownEmails, catchAll: false });
    const identity = identities.find((i) => i.id === resolved?.identityId) ?? identities[0];
    if (!identity) {
      Alert.alert(t('common.error', 'Error'), t('email_viewer.unsubscribe_banner.no_identity', 'No sending identity available'));
      return;
    }
    // Sent/Drafts of the account the reply is submitted from: the message's.
    const scoped = mailboxesOfAccount(mailboxes, jmapAccountId);
    const sent = scoped.find((m) => m.role === 'sent');
    const drafts = scoped.find((m) => m.role === 'drafts');
    if (!sent) {
      Alert.alert(t('common.error', 'Error'), t('email_composer.no_sent_folder', 'No Sent folder found'));
      return;
    }
    setSending(true);
    try {
      const recipients = buildReplyRecipients(
        { from: email.from, replyToAddresses: email.replyTo, to: email.to, cc: email.cc },
        'reply',
        ownEmails,
      );
      const picked = pickEmailBody(email);
      const original = picked.text ?? (picked.html ? htmlToPlainText(picked.html) : plainTextBody(email));
      const quoted = original.split('\n').map((l) => `> ${l}`).join('\n');
      // The header the composer puts above a quoted reply ("On …, X wrote:").
      const header = buildQuoteHeader({
        mode: 'reply',
        email: { from, subject: email.subject, receivedAt: emailDisplayDate(email) },
        timeFormat,
        locale,
        region: dateRegion,
        unknownLabel: t('common.unknown', 'Unknown'),
        labels: quoteHeaderLabels(t),
      });
      const threading = computeReplyThreadingHeaders(email);
      const outgoing: OutgoingEmail = {
        from: [{ name: identity.name, email: identity.email }],
        to: recipients.to.filter((r) => !!r.email).map((r) => ({ email: r.email!, name: r.name })),
        cc: recipients.cc.filter((r) => !!r.email).map((r) => ({ email: r.email!, name: r.name })),
        subject: buildReplySubject(email.subject, t('email_composer.prefix.reply', 'Re:')),
        // Signed as the composer signs a plain-text reply; an alias without a
        // signature of its own carries the primary identity's.
        textBody: signPlainTextReply(body, `${header.text}${quoted}`, signatureIdentityFor(identity, identities), {
          position: signaturePosition,
          separator: signatureSeparatorEnabled,
        }),
        inReplyTo: threading?.inReplyTo,
        references: threading?.references,
      };
      // Re-checked after the awaits above, right before any request or queueing.
      if (!ownerActiveNow()) {
        alertOwnerChanged();
        return;
      }
      // Offline at the moment of sending, before any request: queue it.
      const ownerAppAccountId = ownerRef.current;
      // The message's own account, or else the owner's login account, read
      // now: the box may have mounted before the connection came up.
      const queueAccountId = jmapAccountId || (ownerAppAccountId
        ? queueJmapAccountId({ appAccountId: ownerAppAccountId, jmapAccountId: '' }, {
            liveJmapAccountId: jmapClient.connectedAccountId,
            clientServesOwner: clientServesAccount(ownerAppAccountId),
            recorded: recordedJmapAccountId,
          })
        : '');
      if (!useNetworkStore.getState().online) {
        if (
          !hasQueueAccounts(ownerAppAccountId, queueAccountId)
          || !shouldQueueSend({ online: false, uploadsDone: attachmentsUploaded(outgoing) })
        ) {
          const { title, message } = sendErrorAlert(new Error('offline'), t);
          Alert.alert(title, message);
          return;
        }
        try {
          if (!messageIdRef.current) messageIdRef.current = generateMessageId(identity.email);
          outgoing.messageId = messageIdRef.current;
          await useSendQueueStore.getState().enqueue(buildQueuedSend({
            id: generateUUID(),
            appAccountId: ownerAppAccountId!,
            jmapAccountId: queueAccountId,
            identityId: identity.id,
            outgoing,
            // The replay trusts the recipients; never a sender the owning
            // server's checks flag.
            replyTo: {
              emailIds: [email.id], keyword: '$answered', jmapAccountId,
              untrusted: untrustedReplyAddresses(email, authservHostFor(ownerAppAccountId ?? undefined)),
            },
          }));
          messageIdRef.current = null;
          setText('');
          Keyboard.dismiss();
          toast.info(t('outbox.queued', "Will send when you're back online"));
        } catch (err) {
          if (err instanceof SendTooLargeToQueueError) {
            Alert.alert(t('common.error', 'Error'), t('outbox.too_large', 'This message is too large to send offline'));
          } else if (err instanceof AlreadyQueuedError) {
            toastAlreadyQueued();
          } else {
            const { title, message } = sendErrorAlert(err, t, { account: ownerLabel() });
            Alert.alert(title, message);
          }
        }
        return;
      }
      const holdFor = jmapClient.undoSendHold(sendDelaySeconds, jmapAccountId);
      // The send and the `$answered` flag after it on one connection: the
      // owner's, checked active just above. Flagged after a switch, the
      // replied-to id would name the other account's message.
      const at = opScope(jmapAccountId);
      const result = await sendEmail(
        outgoing,
        identity.id,
        sent.originalId ?? sent.id,
        holdFor,
        { draftsMailboxId: drafts ? (drafts.originalId ?? drafts.id) : undefined, accountId: at },
      );
      // Held for the undo-send delay: the undo bar offers Undo / Send now.
      // Recorded before the flag below so its round trip doesn't eat the window.
      useSendUndoStore.getState().recordHeldSend(result, holdFor, {
        identityId: identity.id,
        appAccountId: ownerAppAccountId ?? undefined,
        accountId: jmapAccountId,
        from: [{ name: identity.name, email: identity.email }],
      });
      try {
        await patchKeywordsForEmails([email.id], { $answered: true }, at);
      } catch { /* the reply is out; the flag is cosmetic */ }
      onSent?.({ ...email, keywords: { ...email.keywords, $answered: true } });
      setText('');
      if (result.rejectedRecipients?.length) {
        toast.warning(
          t('email_composer.send_some_recipients_rejected', 'Sent, but not to these recipients - the server rejected them.'),
          { message: formatRejectedRecipients(result.rejectedRecipients), duration: 10_000 },
        );
      }
      if (result.filingWarning) {
        console.warn('[quick-reply] post-send filing warning:', result.filingWarning);
        toast.warning(t('email_composer.send_filing_warning', 'Sent - but the post-send cleanup failed, a stale draft may remain.'));
      }
      // The keyboard would cover the undo bar or the toast.
      Keyboard.dismiss();
      // A reply held for the undo-send delay has not gone out yet (webmail b03a0c1d).
      if (!result.scheduled) toast.success(t('notifications.email_sent', 'Email sent successfully'));
    } catch (err) {
      const { title, message } = sendErrorAlert(err, t, { account: ownerLabel() });
      Alert.alert(title, message);
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={styles.box}>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={t('email_viewer.quick_reply_placeholder', 'Write a quick reply...')}
        placeholderTextColor={c.textMuted}
        style={styles.input}
        multiline
        editable={!sending}
      />
      <View style={styles.actions}>
        <Pressable style={styles.more} onPress={() => onMoreOptions(text)} hitSlop={6}>
          <Maximize2 size={14} color={c.textSecondary} />
          <Text style={styles.moreText}>{t('email_viewer.more_options', 'More options')}</Text>
        </Pressable>
        <Pressable
          style={[styles.send, (!text.trim() || sending) && styles.sendDisabled]}
          onPress={send}
          disabled={!text.trim() || sending}
        >
          {sending ? <ActivityIndicator size="small" color={c.primaryForeground} /> : <Send size={14} color={c.primaryForeground} />}
          <Text style={styles.sendText}>{sending ? t('email_viewer.sending', 'Sending...') : t('email_viewer.send', 'Send')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    box: {
      marginHorizontal: spacing.lg,
      marginVertical: spacing.md,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      backgroundColor: c.surface,
      padding: spacing.sm,
      gap: spacing.sm,
    },
    input: {
      ...typography.body,
      color: c.text,
      minHeight: 44,
      maxHeight: 160,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      textAlignVertical: 'top',
    },
    actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    more: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
    moreText: { ...typography.caption, color: c.textSecondary },
    send: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      backgroundColor: c.primary,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radius.full,
    },
    sendDisabled: { opacity: 0.5 },
    sendText: { ...typography.caption, color: c.primaryForeground, fontWeight: '600' },
  });
}
