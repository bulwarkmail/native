import React from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator, Alert } from 'react-native';
import { Send, Maximize2 } from 'lucide-react-native';
import type { Email } from '../../api/types';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore } from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';
import { useEmailStore } from '../../stores/email-store';
import { toast } from '../../stores/toast-store';
import { sendEmail, patchKeywordsForEmails } from '../../api/email';
import { jmapClient } from '../../api/jmap-client';
import { buildReplyRecipients } from '../../lib/reply-recipients';
import { buildReplySubject } from '../../lib/subject-prefix';
import { computeReplyThreadingHeaders } from '../../lib/email-threading';
import { resolveReplyIdentity } from '../../lib/reply-identity';
import { signatureIdentityFor, signPlainTextReply } from '../../lib/signature-utils';
import { pickEmailBody, plainTextBody } from '../../lib/email-body';
import { htmlToPlainText } from '../../lib/compose-html';
import { mailboxesOfAccount } from '../../lib/mailbox-tree';
import { emailDisplayDate, formatFullDateTime } from '../../lib/email-date';

interface Props {
  email: Email;
  jmapAccountId?: string;
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
export function QuickReplyBox({ email, jmapAccountId, onMoreOptions, onSent }: Props) {
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

  const from = email.from?.[0];
  if (!from?.email || email.keywords?.$draft) return null;

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
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
      const header = `${formatFullDateTime(emailDisplayDate(email), timeFormat, locale)}, ${from.name ? `${from.name} <${from.email}>` : from.email}:`;
      const threading = computeReplyThreadingHeaders(email);
      const result = await sendEmail(
        {
          from: [{ name: identity.name, email: identity.email }],
          to: recipients.to.filter((r) => !!r.email).map((r) => ({ email: r.email!, name: r.name })),
          cc: recipients.cc.filter((r) => !!r.email).map((r) => ({ email: r.email!, name: r.name })),
          subject: buildReplySubject(email.subject, t('email_composer.prefix.reply', 'Re:')),
          // Signed as the composer signs a plain-text reply; an alias without a
          // signature of its own carries the primary identity's.
          textBody: signPlainTextReply(body, `${header}\n${quoted}`, signatureIdentityFor(identity, identities), {
            position: signaturePosition,
            separator: signatureSeparatorEnabled,
          }),
          inReplyTo: threading?.inReplyTo,
          references: threading?.references,
        },
        identity.id,
        sent.originalId ?? sent.id,
        jmapClient.undoSendHold(sendDelaySeconds, jmapAccountId),
        { draftsMailboxId: drafts ? (drafts.originalId ?? drafts.id) : undefined, accountId: jmapAccountId },
      );
      try {
        await patchKeywordsForEmails([email.id], { $answered: true }, jmapAccountId);
      } catch { /* the reply is out; the flag is cosmetic */ }
      onSent?.({ ...email, keywords: { ...email.keywords, $answered: true } });
      setText('');
      // A reply held for the undo-send delay has not gone out yet (webmail b03a0c1d).
      if (!result.scheduled) toast.success(t('notifications.email_sent', 'Email sent successfully'));
    } catch (err) {
      Alert.alert(t('email_composer.send_failed', 'Failed to send'), err instanceof Error ? err.message : String(err));
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
