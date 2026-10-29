import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { ArrowLeft, Clock, Send, Pencil, XCircle } from '../icons';
import type { Email } from '../../api/types';
import type { ScheduledEmail } from '../../api/email';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { useSettingsStore } from '../../stores/settings-store';
import { MessageContent } from '../email/MessageContent';

interface Props {
  item: ScheduledEmail;
  /** The full message; null while it loads. */
  email: Email | null;
  error: string | null;
  /** The account to read the message's blobs from: undefined for the own one. */
  jmapAccountId?: string;
  busy: boolean;
  formatWhen: (iso: string) => string;
  onBack: () => void;
  onRetry: () => void;
  onSendNow: () => void;
  onReschedule: () => void;
  onEdit: () => void;
  onCancelSend: () => void;
}

/**
 * A scheduled message, read-only, with the banner the webmail shows above
 * it: when it goes out, and Send now / Reschedule / Edit / Cancel send
 * (webmail email-viewer.tsx, native #84).
 */
export function ScheduledMessageView({
  item, email, error, jmapAccountId, busy, formatWhen,
  onBack, onRetry, onSendNow, onReschedule, onEdit, onCancelSend,
}: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const identities = useSettingsStore((s) => s.identities);

  const actions = [
    { key: 'send', label: t('email_viewer.send_now', 'Send now'), icon: Send, onPress: onSendNow },
    { key: 'reschedule', label: t('email_viewer.reschedule_send', 'Reschedule'), icon: Clock, onPress: onReschedule },
    { key: 'edit', label: t('email_viewer.cancel_and_edit', 'Cancel and edit'), icon: Pencil, onPress: onEdit },
    { key: 'cancel', label: t('email_viewer.cancel_scheduled_send', 'Cancel send'), icon: XCircle, onPress: onCancelSend, destructive: true },
  ];

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable
          onPress={onBack}
          style={styles.headerBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('common.back', 'Back')}
        >
          <ArrowLeft size={22} color={c.text} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {item.subject || t('email_composer.no_subject', '(No Subject)')}
        </Text>
      </View>

      <View style={styles.banner} accessibilityRole="summary">
        <View style={styles.bannerRow}>
          <Clock size={16} color={c.primary} />
          <Text style={styles.bannerText}>
            {t('email_viewer.scheduled_banner', 'Scheduled to send at {date}', { date: formatWhen(item.sendAt) })}
          </Text>
          {busy && <ActivityIndicator size="small" color={c.primary} />}
        </View>
        <View style={styles.bannerActions}>
          {actions.map(({ key, label, icon: Icon, onPress, destructive }) => (
            <Pressable
              key={key}
              onPress={onPress}
              disabled={busy}
              accessibilityRole="button"
              accessibilityState={{ disabled: busy }}
              style={({ pressed }) => [styles.bannerBtn, pressed && styles.bannerBtnPressed, busy && styles.bannerBtnDisabled]}
            >
              <Icon size={14} color={destructive ? c.error : c.text} />
              <Text style={[styles.bannerBtnText, destructive && { color: c.error }]} numberOfLines={1}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Pressable onPress={onRetry}>
            <Text style={styles.retry}>{t('common.retry', 'Retry')}</Text>
          </Pressable>
        </View>
      ) : !email ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.primary} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <MessageContent
            email={email}
            jmapAccountId={jmapAccountId}
            identities={identities}
            // As in Sent: no read receipt banner for the user's own message.
            currentMailboxRole="sent"
            active={false}
            onAddressPress={() => undefined}
            onEmailPatched={() => undefined}
          />
        </ScrollView>
      )}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      height: componentSizes.headerHeight,
      paddingHorizontal: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      gap: spacing.sm,
    },
    headerBtn: {
      width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md,
    },
    headerTitle: { ...typography.h3, color: c.text, flex: 1 },
    banner: {
      margin: spacing.md,
      padding: spacing.md,
      gap: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    bannerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    bannerText: { ...typography.bodyMedium, color: c.text, flex: 1 },
    bannerActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    bannerBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      minHeight: 36,
      paddingHorizontal: spacing.md,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
    },
    bannerBtnPressed: { opacity: 0.7 },
    bannerBtnDisabled: { opacity: 0.5 },
    bannerBtnText: { ...typography.caption, color: c.text, fontWeight: '600' },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.lg },
    error: { ...typography.body, color: c.error, textAlign: 'center' },
    retry: { ...typography.bodyMedium, color: c.primary, marginTop: spacing.sm },
    content: { paddingBottom: spacing.xl },
  });
}
