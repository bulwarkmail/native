import React from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as WebBrowser from 'expo-web-browser';
import { MailMinus, CheckCircle2, AlertCircle, X } from 'lucide-react-native';
import type { Email } from '../../api/types';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useEmailStore } from '../../stores/email-store';
import { sendEmail } from '../../api/email';
import { isValidUnsubscribeUrl, parseMailtoUrl, isOneClickUnsubscribe } from '../../lib/unsubscribe';
import type { ListHeaders } from '../../lib/email-headers';
import { findReceivingIdentity } from '../../lib/email-headers';
import { mailboxesOfAccount } from '../../lib/mailbox-tree';

const DISMISSED_KEY = 'webmail:unsubscribe-dismissed:v1';
const dismissed = new Set<string>();
let dismissedLoaded: Promise<void> | null = null;

function loadDismissed(): Promise<void> {
  if (!dismissedLoaded) {
    dismissedLoaded = AsyncStorage.getItem(DISMISSED_KEY)
      .then((raw) => {
        if (!raw) return;
        for (const id of JSON.parse(raw) as string[]) dismissed.add(id);
      })
      .catch(() => undefined);
  }
  return dismissedLoaded;
}

function persistDismissed(): void {
  // Keep the list bounded - the newest few hundred Message-IDs are plenty.
  const list = Array.from(dismissed).slice(-500);
  void AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify(list)).catch(() => undefined);
}

interface Props {
  email: Email;
  list: ListHeaders;
  /** Dedupe key for dismissals (bare Message-ID, else the JMAP id). */
  messageKey: string;
  jmapAccountId?: string;
}

/**
 * List-Unsubscribe (RFC 2369 / RFC 8058) banner. An https one-click URL is
 * POSTed directly; a plain http(s) URL opens in the in-app browser; a
 * mailto: URL is sent through the account itself (handing it to the OS mail
 * app goes nowhere for most users). Dismissals are remembered per Message-ID.
 */
export function UnsubscribeBanner({ email, list, messageKey, jmapAccountId }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const identities = useSettingsStore((s) => s.identities);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const [hidden, setHidden] = React.useState(true);
  const [state, setState] = React.useState<'idle' | 'busy' | 'done' | 'error'>('idle');

  const unsub = list.listUnsubscribe;
  const method = unsub?.preferred;
  const url = method === 'http' ? unsub?.http : unsub?.mailto;

  React.useEffect(() => {
    let cancelled = false;
    setState('idle');
    void loadDismissed().then(() => {
      if (!cancelled) setHidden(dismissed.has(messageKey));
    });
    return () => { cancelled = true; };
  }, [messageKey]);

  if (hidden || !url || !method) return null;

  const dismiss = () => {
    dismissed.add(messageKey);
    persistDismissed();
    setHidden(true);
  };

  const perform = async () => {
    if (!isValidUnsubscribeUrl(url)) { setState('error'); return; }
    setState('busy');
    try {
      if (method === 'http') {
        if (isOneClickUnsubscribe(list.listUnsubscribePost, url)) {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'List-Unsubscribe=One-Click',
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } else {
          await WebBrowser.openBrowserAsync(url);
        }
      } else {
        const fields = parseMailtoUrl(url);
        if (!fields) throw new Error('invalid mailto');
        const identity = findReceivingIdentity(identities, email) ?? identities[0];
        if (!identity) throw new Error(t('email_viewer.unsubscribe_banner.no_identity', 'No sending identity available'));
        // Sent/Drafts of the account the mail is submitted from: the message's.
        const scoped = mailboxesOfAccount(mailboxes, jmapAccountId);
        const sent = scoped.find((m) => m.role === 'sent');
        const drafts = scoped.find((m) => m.role === 'drafts');
        if (!sent) throw new Error(t('email_composer.no_sent_folder', 'No Sent folder found'));
        await sendEmail(
          {
            from: [{ name: identity.name, email: identity.email }],
            to: fields.to.map((address) => ({ email: address })),
            cc: fields.cc?.map((address) => ({ email: address })),
            subject: fields.subject ?? '',
            textBody: fields.body ?? '',
          },
          identity.id,
          sent.originalId ?? sent.id,
          undefined,
          { draftsMailboxId: drafts ? (drafts.originalId ?? drafts.id) : undefined, accountId: jmapAccountId },
        );
      }
      setState('done');
      setTimeout(dismiss, 3000);
    } catch (err) {
      console.warn('[unsubscribe] failed', err);
      setState('error');
    }
  };

  const confirm = () => {
    Alert.alert(
      t('email_viewer.unsubscribe_banner.confirm_title', 'Unsubscribe from this sender?'),
      method === 'http'
        ? t('email_viewer.unsubscribe_banner.confirm_message_http', 'The unsubscribe page will open in a new tab.')
        : t('email_viewer.unsubscribe_banner.confirm_message_mailto', 'An unsubscribe email will be sent to the sender.'),
      [
        { text: t('email_viewer.unsubscribe_banner.cancel', 'Cancel'), style: 'cancel' },
        { text: t('email_viewer.unsubscribe_banner.confirm_button', 'Confirm'), onPress: () => { void perform(); } },
      ],
    );
  };

  return (
    <View style={styles.banner}>
      <MailMinus size={14} color={c.textSecondary} />
      <Text style={styles.label}>{t('email_viewer.unsubscribe_banner.label', 'Newsletter')}</Text>
      {state === 'busy' ? (
        <ActivityIndicator size="small" color={c.primary} />
      ) : state === 'done' ? (
        <View style={styles.status}>
          <CheckCircle2 size={14} color={c.success} />
          <Text style={[styles.statusText, { color: c.success }]}>
            {t(method === 'http' ? 'email_viewer.unsubscribe_banner.success_http' : 'email_viewer.unsubscribe_banner.success_mailto',
              method === 'http' ? 'Unsubscribe page opened' : 'Unsubscribe email sent')}
          </Text>
        </View>
      ) : state === 'error' ? (
        <View style={styles.status}>
          <AlertCircle size={14} color={c.error} />
          <Text style={[styles.statusText, { color: c.error }]}>{t('email_viewer.unsubscribe_banner.error', 'Unable to unsubscribe')}</Text>
        </View>
      ) : (
        <Pressable onPress={confirm} hitSlop={8}>
          <Text style={styles.action}>{t('email_viewer.unsubscribe_banner.button', 'Unsubscribe')}</Text>
        </Pressable>
      )}
      <View style={styles.spacer} />
      <Pressable onPress={dismiss} hitSlop={8} accessibilityLabel={t('email_viewer.unsubscribe_banner.dismiss', 'Dismiss')}>
        <X size={16} color={c.textMuted} />
      </Pressable>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: c.surfaceHover,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      borderRadius: radius.xs,
    },
    label: { ...typography.caption, color: c.textSecondary },
    action: { ...typography.caption, color: c.primary, fontWeight: '600' },
    status: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    statusText: { ...typography.caption },
    spacer: { flex: 1 },
  });
}
