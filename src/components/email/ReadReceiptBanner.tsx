import React from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Alert } from 'react-native';
import { MailCheck } from 'lucide-react-native';
import type { Email } from '../../api/types';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useEmailStore } from '../../stores/email-store';
import { toast } from '../../stores/toast-store';
import { sendReadReceipt, patchKeywordsForEmails } from '../../api/email';
import { jmapClient } from '../../api/jmap-client';
import { findReceivingIdentity } from '../../lib/email-headers';
import { mailboxesOfAccount } from '../../lib/mailbox-tree';

interface Props {
  email: Email;
  /** Bare address from Disposition-Notification-To. */
  requestedBy: string;
  jmapAccountId?: string;
  /** Role of the folder the message was opened from (receipts only in received folders). */
  currentMailboxRole?: string | null;
  /** The message is on screen, not in a neighbour page the pager pre-renders. */
  active: boolean;
  /** Reflect `$mdnsent` in the caller's cache. */
  onHandled: (email: Email) => void;
}

// Messages "always" mode has already tried to answer this session, keyed by
// account and id. One attempt each: a failed send is not retried, and a page
// the pager unmounts and mounts again does not send a second time.
const autoAttempted = new Set<string>();

/**
 * Read-receipt (MDN, RFC 8098) request banner: Send / Ignore, or auto-send
 * in "always" mode. Either answer flags the message `$mdnsent` (RFC 3503) so
 * the request is suppressed in every client, not just here. Never offered
 * for the user's own copies, trash or spam.
 */
export function ReadReceiptBanner({ email, requestedBy, jmapAccountId, currentMailboxRole, active, onHandled }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const identities = useSettingsStore((s) => s.identities);
  const fetchIdentities = useSettingsStore((s) => s.fetchIdentities);
  const readReceiptResponse = useSettingsStore((s) => s.readReceiptResponse);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const [busy, setBusy] = React.useState(false);
  const [handledLocally, setHandledLocally] = React.useState(false);

  React.useEffect(() => { setHandledLocally(false); }, [email.id]);
  React.useEffect(() => { if (identities.length === 0) void fetchIdentities(); }, [identities.length, fetchIdentities]);

  const eligibleFolder = !['sent', 'drafts', 'trash', 'junk', 'spam'].includes(currentMailboxRole || '');
  const identity = React.useMemo(() => findReceivingIdentity(identities, email), [identities, email]);
  const shouldOffer =
    !!requestedBy
    && !email.keywords?.$mdnsent
    && !email.keywords?.$draft
    && !handledLocally
    && readReceiptResponse !== 'never'
    && eligibleFolder
    && !!identity;

  const flagSent = React.useCallback(async () => {
    try {
      await patchKeywordsForEmails([email.id], { $mdnsent: true }, jmapAccountId);
    } catch { /* best effort - the local flag still hides the banner */ }
    onHandled({ ...email, keywords: { ...email.keywords, $mdnsent: true } });
  }, [email, jmapAccountId, onHandled]);

  const send = React.useCallback(async (automatic: boolean) => {
    if (!identity) return;
    // Sent of the account the receipt is submitted from: the message's.
    const scoped = mailboxesOfAccount(mailboxes, jmapAccountId);
    const sent = scoped.find((m) => m.role === 'sent');
    if (!sent) throw new Error(t('email_composer.no_sent_folder', 'No Sent folder found'));
    await sendReadReceipt({
      to: requestedBy,
      fromEmail: identity.email,
      fromName: identity.name,
      identityId: identity.id,
      sentMailboxId: sent.originalId ?? sent.id,
      accountId: jmapAccountId,
      originalMessageId: email.messageId,
      originalSubject: email.subject,
      originalRecipient: identity.email,
      automatic,
      subject: t('email_viewer.read_receipt.mdn_subject', 'Read: {subject}', { subject: email.subject || '' }),
      humanText: t(
        'email_viewer.read_receipt.mdn_body',
        "This is a return receipt for the message you sent to {recipient}.\n\nNote: This receipt only acknowledges that the message was displayed on the recipient's device. There is no guarantee that the recipient has read or understood the message contents.",
        { recipient: identity.email },
      ),
    });
    await flagSent();
  }, [identity, mailboxes, requestedBy, jmapAccountId, email.messageId, email.subject, t, flagSent]);

  // "always" mode: auto-send once when the message is actually displayed.
  React.useEffect(() => {
    if (readReceiptResponse !== 'always' || !shouldOffer || !active) return;
    const key = `${jmapAccountId ?? jmapClient.accountId}:${email.id}`;
    if (autoAttempted.has(key)) return;
    autoAttempted.add(key);
    setHandledLocally(true);
    send(true).catch((err) => {
      console.warn('[mdn] auto-send failed', err);
      // Not retried, so say so rather than fail silently (webmail parity).
      toast.error(
        t('email_viewer.read_receipt.send_failed', 'Read receipt could not be sent'),
        err instanceof Error ? err.message : String(err),
      );
    });
  }, [readReceiptResponse, shouldOffer, active, jmapAccountId, email.id, send, t]);

  if (!shouldOffer || readReceiptResponse === 'always') return null;

  const onSend = async () => {
    setBusy(true);
    try {
      await send(false);
      setHandledLocally(true);
    } catch (err) {
      Alert.alert(
        t('email_viewer.read_receipt.send_failed', 'Read receipt could not be sent'),
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const onIgnore = async () => {
    setHandledLocally(true);
    await flagSent();
  };

  return (
    <View style={styles.banner}>
      <MailCheck size={16} color={c.textSecondary} />
      <Text style={styles.text}>{t('email_viewer.read_receipt.prompt', 'The sender asked to be notified when you open this message.')}</Text>
      {busy ? (
        <ActivityIndicator size="small" color={c.primary} />
      ) : (
        <View style={styles.actions}>
          <Pressable onPress={onSend} hitSlop={8}>
            <Text style={styles.primary}>{t('email_viewer.read_receipt.send', 'Send receipt')}</Text>
          </Pressable>
          <Pressable onPress={onIgnore} hitSlop={8}>
            <Text style={styles.secondary}>{t('email_viewer.read_receipt.ignore', 'Ignore')}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    banner: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: c.surfaceHover,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    text: { ...typography.caption, color: c.textSecondary, flex: 1, minWidth: 160 },
    actions: { flexDirection: 'row', gap: spacing.md },
    primary: { ...typography.caption, color: c.primary, fontWeight: '600' },
    secondary: { ...typography.caption, color: c.textMuted, fontWeight: '600' },
  });
}
