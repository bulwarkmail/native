import React from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator, Alert, Keyboard } from 'react-native';
import { Send, Maximize2 } from '../icons';
import type { Email } from '../../api/types';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore } from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';
import { useEmailStore } from '../../stores/email-store';
import { toast } from '../../stores/toast-store';
import { currentSendLogin, useSendUndoStore } from '../../stores/send-undo-store';
import { useAccountStore } from '../../stores/account-store';
import { loginMovedFrom } from '../../lib/compose-login';
import { sendEmail, patchKeywordsForEmails, SendUnconfirmedError } from '../../api/email';
import { jmapClient } from '../../api/jmap-client';
import { pruneEmailSubmissions } from '../../api/submissions';
import { buildReplyRecipients } from '../../lib/reply-recipients';
import { composerSendFailureMessage, partlyRefusedWarning } from '../../lib/send-failure-message';
import { buildReplySubject } from '../../lib/subject-prefix';
import { computeReplyThreadingHeaders } from '../../lib/email-threading';
import { resolveReplyIdentity } from '../../lib/reply-identity';
import { signatureIdentityFor, signPlainTextReply } from '../../lib/signature-utils';
import { pickEmailBody, plainTextBody } from '../../lib/email-body';
import { htmlToPlainText } from '../../lib/compose-html';
import { sendTargetFor } from '../../lib/compose-send-account';
import { emailDisplayDate } from '../../lib/email-date';
import { buildQuoteHeader, quoteHeaderLabels } from '../../lib/quote-header';
import { passesQuickReplyChecks, type SendQuestion } from '../../lib/compose-send-checks';
import { placeholderWordsFor } from '../../lib/placeholder-check';

interface Props {
  email: Email;
  jmapAccountId?: string;
  /** Open the full composer with the draft text carried over. */
  onMoreOptions: (draft: string) => void;
  /** Reflect `$answered` in the caller's cache. */
  onSent?: (email: Email) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

/**
 * Inline reply box under the message (webmail quick reply): plain-text reply
 * to the sender with the original quoted, sent through the identity that
 * received the message. "More options" hands the text to the full composer.
 */
export function QuickReplyBox({ email, jmapAccountId, onMoreOptions, onSent, onFocus, onBlur }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const identities = useSettingsStore((s) => s.identities);
  const sendDelaySeconds = useSettingsStore((s) => s.sendDelaySeconds);
  const signaturePosition = useSettingsStore((s) => s.signaturePosition);
  const signatureSeparatorEnabled = useSettingsStore((s) => s.signatureSeparatorEnabled);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const [text, setText] = React.useState('');
  const [sending, setSending] = React.useState(false);

  React.useEffect(() => { setText(''); }, [email.id]);
  // The login the message on screen belongs to: the one active when it was
  // shown. A switch while it stays on screen must not send the reply, or
  // flag the original, through the other login (lib/compose-login).
  const ownerLoginRef = React.useRef(useAccountStore.getState().activeAccountId);
  React.useEffect(() => { ownerLoginRef.current = useAccountStore.getState().activeAccountId; }, [email.id]);

  // Taps while a send question is open do nothing.
  const checkingRef = React.useRef(false);

  const from = email.from?.[0];
  if (!from?.email || email.keywords?.$draft) return null;

  const refuseAfterSwitch = () => {
    if (!loginMovedFrom(ownerLoginRef.current)) return false;
    Alert.alert(
      t('email_composer.login_switched_title', 'Account switched'),
      t('email_viewer.quick_reply_login_switched', 'This message is in another account. Switch back to it to reply.'),
    );
    return true;
  };

  // Asked as the composer asks, with "Back to editing" to stop the send.
  const askBeforeSend = (question: SendQuestion) => new Promise<boolean>((resolve) => {
    const back = { text: t('email_composer.placeholder_warning.back', 'Back to editing'), style: 'cancel' as const, onPress: () => resolve(false) };
    const opts = { cancelable: true, onDismiss: () => resolve(false) };
    switch (question.kind) {
      case 'placeholders':
        Alert.alert(
          t('email_composer.placeholder_warning.title', 'Check placeholders?'),
          `${t(
            'email_composer.placeholder_warning.message',
            'Your message has placeholder text that recipients will see. Do you want to edit it before sending?',
          )}\n\n${t('email_composer.placeholder_warning.found', 'Placeholders found')}: ${question.found.join(', ')}`,
          [back, { text: t('email_composer.placeholder_warning.send_anyway', 'Send anyway'), onPress: () => resolve(true) }],
          opts,
        );
        return;
      case 'attachment':
        Alert.alert(
          t('email_composer.attachment_reminder_title', 'Forgot an attachment?'),
          t(
            'email_composer.attachment_reminder_body',
            'Your message mentions "{keyword}" but no file is attached. Send anyway?',
            { keyword: question.keyword },
          ),
          [back, { text: t('email_composer.send', 'Send'), onPress: () => resolve(true) }],
          opts,
        );
        return;
      case 'send':
        Alert.alert(
          t('email_composer.send_confirm.title', 'Send this message?'),
          t('email_composer.send_confirm.message', 'It goes to {count, plural, one {# recipient} other {# recipients}}.', { count: question.count }),
          [
            { text: t('email_composer.cancel', 'Cancel'), style: 'cancel', onPress: () => resolve(false) },
            { text: t('email_composer.send', 'Send'), onPress: () => resolve(true) },
          ],
          opts,
        );
    }
  });

  const send = async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      await sendInner();
    } finally {
      checkingRef.current = false;
    }
  };

  const sendInner = async () => {
    const body = text.trim();
    if (!body || sending) return;
    if (refuseAfterSwitch()) return;
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
    const recipients = buildReplyRecipients(
      { from: email.from, replyToAddresses: email.replyTo, to: email.to, cc: email.cc },
      'reply',
      ownEmails,
    );
    // The composer's placeholder warning, attachment reminder and "Confirm
    // before sending" (webmail 534049952): a quick reply is no way around them.
    const settings = useSettingsStore.getState();
    const passed = await passesQuickReplyChecks({
      body,
      placeholderWords: settings.placeholderWarningEnabled ? placeholderWordsFor(locale) : null,
      attachmentKeywords: settings.attachmentReminderEnabled ? settings.attachmentReminderKeywords : null,
      confirmSend: settings.sendConfirmation,
      recipientCount: [...recipients.to, ...recipients.cc].filter((r) => !!r.email).length,
      ask: askBeforeSend,
    });
    if (!passed) return;
    // The questions wait for the user, long enough for a switch of logins.
    if (refuseAfterSwitch()) return;
    setSending(true);
    try {
      // The account, identity and folders the reply goes out through, as the
      // composer picks them (#1090): a group address sends from the group's
      // account with that account's identity id. The message's own account
      // with the login's identity id named nothing there, or another
      // identity.
      const target = await sendTargetFor(identity, identity.email, mailboxes);
      if (!target.sentMailboxId) {
        Alert.alert(t('common.error', 'Error'), t('email_composer.no_sent_folder', 'No Sent folder found'));
        return;
      }
      // The lookup may have outlasted a switch of logins.
      if (refuseAfterSwitch()) return;
      const picked = pickEmailBody(email);
      const original = picked.text ?? (picked.html ? htmlToPlainText(picked.html) : plainTextBody(email));
      const quoted = original.split('\n').map((l) => `> ${l}`).join('\n');
      // The header the composer puts above a quoted reply ("On …, X wrote:").
      const header = buildQuoteHeader({
        mode: 'reply',
        email: { from, subject: email.subject, receivedAt: emailDisplayDate(email) },
        timeFormat,
        locale,
        unknownLabel: t('common.unknown', 'Unknown'),
        labels: quoteHeaderLabels(t),
      });
      const threading = computeReplyThreadingHeaders(email);
      const holdFor = jmapClient.undoSendHold(sendDelaySeconds, target.accountId);
      // Where the reply goes, read before it goes: Undo must reach that login
      // and account whatever the app switches to meanwhile.
      const sentThrough = { login: currentSendLogin(), accountId: target.accountId ?? jmapClient.connectedAccountId ?? undefined };
      const result = await sendEmail(
        {
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
        },
        target.identityId,
        target.sentMailboxId,
        holdFor,
        { draftsMailboxId: target.draftsMailboxId, accountId: target.accountId },
      );
      // Held for the undo-send delay: the undo bar offers Undo / Send now.
      // Recorded before the flag below so its round trip doesn't eat the window.
      useSendUndoStore.getState().recordHeldSend(result, holdFor, {
        identityId: target.identityId,
        ...sentThrough,
        from: [{ name: identity.name, email: identity.email }],
      });
      void pruneEmailSubmissions();
      try {
        // After a switch during the send the id names another message.
        if (!loginMovedFrom(ownerLoginRef.current)) {
          await patchKeywordsForEmails([email.id], { $answered: true }, jmapAccountId);
        }
      } catch { /* the reply is out; the flag is cosmetic */ }
      onSent?.({ ...email, keywords: { ...email.keywords, $answered: true } });
      setText('');
      // The keyboard would cover the undo bar or the toast.
      Keyboard.dismiss();
      if (result.refusedRecipients?.length) {
        // As in the composer: nothing else would say who never gets it.
        const { title, message } = partlyRefusedWarning(result.refusedRecipients, t);
        toast.warning(title, { message, duration: 10_000 });
      } else if (!result.scheduled) {
        // A reply held for the undo-send delay has not gone out yet (webmail b03a0c1d).
        toast.success(t('notifications.email_sent', 'Email sent successfully'));
      }
    } catch (err) {
      if (err instanceof SendUnconfirmedError) {
        // It may have gone out: the text stays, and Sent tells (#1019).
        Alert.alert(
          t('email_composer.send_unconfirmed_title', 'Send not confirmed'),
          t(
            'email_viewer.quick_reply_unconfirmed',
            'The server did not confirm the send. Check your Sent folder before sending again.',
          ),
        );
        return;
      }
      Alert.alert(t('email_composer.send_failed', 'Failed to send'), composerSendFailureMessage(err, t));
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={styles.box}>
      <TextInput
        // No full-screen keyboard in landscape: it would hide the suggestions
        // and the text around the field.
        disableFullscreenUI
        value={text}
        onChangeText={setText}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder={t('email_viewer.quick_reply_placeholder', 'Write a quick reply...')}
        placeholderTextColor={c.mutedForeground}
        style={styles.input}
        multiline
        editable={!sending}
      />
      <View style={styles.actions}>
        <Pressable style={styles.more} onPress={() => onMoreOptions(text)} hitSlop={10} accessibilityRole="button">
          <Maximize2 size={14} color={c.textSecondary} />
          <Text style={styles.moreText}>{t('email_viewer.more_options', 'More options')}</Text>
        </Pressable>
        <Pressable
          style={[styles.send, (!text.trim() || sending) && styles.sendDisabled]}
          onPress={send}
          disabled={!text.trim() || sending}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityState={{ disabled: !text.trim() || sending, busy: sending }}
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
      backgroundColor: c.background,
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
      minHeight: 36,
      borderRadius: radius.sm,
    },
    sendDisabled: { opacity: 0.5 },
    sendText: { ...typography.bodyMedium, color: c.primaryForeground },
  });
}
