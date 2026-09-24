import React from 'react';
import {
  View, Text, StyleSheet, FlatList, ActivityIndicator, Pressable, Alert, Modal, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Clock, MoreHorizontal } from 'lucide-react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import {
  listScheduledEmails,
  cancelScheduledSend,
  rescheduleScheduledSend,
  restoreEmailToDraft,
  getFullEmail,
  type ScheduledEmail,
} from '../api/email';
import { jmapClient, ScheduleTooLateError } from '../api/jmap-client';
import { useEmailStore } from '../stores/email-store';
import { useLocaleStore } from '../stores/locale-store';
import { useSettingsStore } from '../stores/settings-store';
import { useSendUndoStore } from '../stores/send-undo-store';
import { ownMailboxes } from '../lib/mailbox-tree';
import { draftContextFromEmail } from '../lib/draft-context';
import { formatQuoteDate } from '../lib/quote-header';
import { spacing, typography, componentSizes, radius, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

type Props = NativeStackScreenProps<RootStackParamList, 'Scheduled'>;

export default function ScheduledScreen({ navigation }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const [items, setItems] = React.useState<ScheduledEmail[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [actionsFor, setActionsFor] = React.useState<ScheduledEmail | null>(null);
  const [rescheduleFor, setRescheduleFor] = React.useState<ScheduledEmail | null>(null);
  const [customStage, setCustomStage] = React.useState<'datetime' | 'date' | 'time' | null>(null);
  const customDraftRef = React.useRef<Date>(new Date());

  const formatWhen = React.useCallback(
    (iso: string) => formatQuoteDate(iso, timeFormat, locale),
    [timeFormat, locale],
  );

  const recipientLabel = (item: ScheduledEmail): string => {
    const first = item.to?.[0];
    if (!first) return t('email_composer.no_recipient', '(no recipient)');
    const name = first.name || first.email;
    const extra = (item.to?.length ?? 0) - 1;
    return extra > 0 ? `${name} +${extra}` : name;
  };

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listScheduledEmails());
    } catch (e) {
      setError(e instanceof Error ? e.message : t('email_list.error', 'Error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const runAction = async (item: ScheduledEmail, action: () => Promise<void>, failTitle: string) => {
    setBusyId(item.emailSubmissionId);
    try {
      await action();
    } catch (e) {
      if (e instanceof ScheduleTooLateError) {
        Alert.alert(
          t('email_composer.schedule_too_late_title', 'Too far ahead'),
          t('email_composer.schedule_too_late_body', 'That is later than this server allows. Pick an earlier time.'),
        );
        return;
      }
      Alert.alert(failTitle, e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const removeItem = (id: string) => setItems((prev) => prev.filter((i) => i.emailSubmissionId !== id));

  const onCancel = (item: ScheduledEmail) => {
    Alert.alert(
      t('email_list.cancel_scheduled_send', 'Cancel send'),
      t('scheduled.cancel_body', 'The message will not be delivered. A copy stays in your Sent folder.'),
      [
        { text: t('scheduled.keep_scheduled', 'Keep scheduled'), style: 'cancel' },
        {
          text: t('email_list.cancel_scheduled_send', 'Cancel send'),
          style: 'destructive',
          onPress: () => {
            void runAction(item, async () => {
              await cancelScheduledSend(item.emailSubmissionId, item.accountId);
              if (useSendUndoStore.getState().pending?.emailSubmissionId === item.emailSubmissionId) {
                useSendUndoStore.getState().clear();
              }
              removeItem(item.emailSubmissionId);
            }, t('scheduled.cancel_failed', 'Cancel failed'));
          },
        },
      ],
    );
  };

  const onSendNow = (item: ScheduledEmail) => {
    void runAction(item, async () => {
      await rescheduleScheduledSend(item, 0);
      if (useSendUndoStore.getState().pending?.emailSubmissionId === item.emailSubmissionId) {
        useSendUndoStore.getState().clear();
      }
      removeItem(item.emailSubmissionId);
    }, t('scheduled.send_now_failed', 'Could not send now'));
  };

  const onReschedule = (item: ScheduledEmail, date: Date) => {
    const seconds = Math.ceil((date.getTime() - Date.now()) / 1000);
    if (seconds <= 0) {
      Alert.alert(
        t('email_composer.schedule_past_title', 'Pick a future time'),
        t('email_composer.schedule_past_body', 'The scheduled time must be in the future.'),
      );
      return;
    }
    const max = jmapClient.getMaxDelayedSend(item.accountId);
    if (max > 0 && seconds > max) {
      Alert.alert(
        t('email_composer.schedule_too_late_title', 'Too far ahead'),
        t('email_composer.schedule_too_late_body', 'That is later than this server allows. Pick an earlier time.'),
      );
      return;
    }
    void runAction(item, async () => {
      const result = await rescheduleScheduledSend(item, seconds);
      const pending = useSendUndoStore.getState().pending;
      if (pending?.emailSubmissionId === item.emailSubmissionId) useSendUndoStore.getState().clear();
      setItems((prev) => prev
        .map((i) => (i.emailSubmissionId === item.emailSubmissionId
          ? { ...i, emailSubmissionId: result.emailSubmissionId ?? i.emailSubmissionId, sendAt: result.sendAt ?? date.toISOString() }
          : i))
        .sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime()));
    }, t('scheduled.reschedule_failed', 'Reschedule failed'));
  };

  // Cancel the submission, move the message back into Drafts and open it in
  // the composer (webmail cancelScheduledEmailForEdit).
  const onEdit = (item: ScheduledEmail) => {
    void runAction(item, async () => {
      await cancelScheduledSend(item.emailSubmissionId, item.accountId);
      if (useSendUndoStore.getState().pending?.emailSubmissionId === item.emailSubmissionId) {
        useSendUndoStore.getState().clear();
      }
      // A message held in a shared account goes back to that account's Drafts.
      const shared = item.accountId !== jmapClient.accountId;
      const scope = shared
        ? mailboxes.filter((m) => m.isShared && m.accountId === item.accountId)
        : ownMailboxes(mailboxes);
      const drafts = scope.find((m) => m.role === 'drafts');
      const sent = scope.find((m) => m.role === 'sent');
      if (drafts) {
        await restoreEmailToDraft(
          item.emailId,
          drafts.originalId ?? drafts.id,
          sent ? (sent.originalId ?? sent.id) : undefined,
          item.accountId,
        );
      }
      const email = await getFullEmail(item.emailId, item.accountId);
      removeItem(item.emailSubmissionId);
      navigation.replace('Compose', { draft: draftContextFromEmail(email, shared ? item.accountId : undefined) });
    }, t('scheduled.edit_failed', 'Could not open the message for editing'));
  };

  const reschedulePresets = React.useMemo(() => {
    const now = new Date();
    const inHours = (h: number) => new Date(now.getTime() + h * 3600 * 1000);
    const tomorrowMorning = new Date(now);
    tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
    tomorrowMorning.setHours(8, 0, 0, 0);
    // Only offer times within the server's hold limit.
    const maxMs = jmapClient.getMaxDelayedSend(rescheduleFor?.accountId) * 1000;
    return [
      { label: t('email_composer.schedule_in_1h', 'In 1 hour'), date: inHours(1) },
      { label: t('email_composer.schedule_in_3h', 'In 3 hours'), date: inHours(3) },
      { label: t('email_composer.schedule_tomorrow_morning', 'Tomorrow morning'), date: tomorrowMorning },
    ].filter((preset) => preset.date.getTime() - now.getTime() <= maxMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, rescheduleFor]);

  const startCustomPicker = () => {
    // An hour ahead, or the latest time the server can hold it if sooner.
    const latest = jmapClient.latestHoldDate(rescheduleFor?.accountId)?.getTime() ?? Infinity;
    customDraftRef.current = new Date(Math.min(Date.now() + 3600 * 1000, latest));
    setCustomStage(Platform.OS === 'ios' ? 'datetime' : 'date');
  };

  const confirmCustom = (date: Date) => {
    const item = rescheduleFor;
    setRescheduleFor(null);
    setCustomStage(null);
    if (item) onReschedule(item, date);
  };

  const onCustomPickerChange = (event: DateTimePickerEvent, selected?: Date) => {
    if (event.type === 'dismissed' || !selected) {
      setCustomStage(null);
      return;
    }
    if (Platform.OS === 'ios') {
      customDraftRef.current = selected;
      return;
    }
    if (customStage === 'date') {
      const d = new Date(customDraftRef.current);
      d.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
      customDraftRef.current = d;
      setCustomStage('time');
      return;
    }
    if (customStage === 'time') {
      const d = new Date(customDraftRef.current);
      d.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
      confirmCustom(d);
    }
  };

  const renderItem = ({ item }: { item: ScheduledEmail }) => {
    const busy = busyId === item.emailSubmissionId;
    return (
      <Pressable style={styles.row} onPress={() => setActionsFor(item)} disabled={busy}>
        <View style={styles.rowMain}>
          <View style={styles.sendAtRow}>
            <Clock size={13} color={c.primary} />
            <Text style={styles.sendAt}>{formatWhen(item.sendAt)}</Text>
          </View>
          <Text style={styles.subject} numberOfLines={1}>
            {item.subject || t('email_composer.no_subject', '(No Subject)')}
          </Text>
          <Text style={styles.recipient} numberOfLines={1}>
            {t('email_composer.to', 'To')}: {recipientLabel(item)}
          </Text>
          {item.preview ? (
            <Text style={styles.preview} numberOfLines={1}>{item.preview}</Text>
          ) : null}
        </View>
        <View style={styles.actionBtn}>
          {busy ? (
            <ActivityIndicator size="small" color={c.primary} />
          ) : (
            <MoreHorizontal size={18} color={c.textSecondary} />
          )}
        </View>
      </Pressable>
    );
  };

  const actionRows = actionsFor ? [
    { label: t('email_viewer.send_now', 'Send now'), onPress: () => onSendNow(actionsFor) },
    { label: t('email_list.reschedule_send', 'Reschedule'), onPress: () => setRescheduleFor(actionsFor) },
    { label: t('common.edit', 'Edit'), onPress: () => onEdit(actionsFor) },
    { label: t('email_list.cancel_scheduled_send', 'Cancel send'), destructive: true, onPress: () => onCancel(actionsFor) },
  ] : [];

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => navigation.goBack()}
          style={styles.headerBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('common.back', 'Back')}
        >
          <ArrowLeft size={22} color={c.text} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{t('sidebar.scheduled', 'Scheduled')}</Text>
        <View style={styles.headerBtn} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.primary} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Pressable onPress={() => { void load(); }}>
            <Text style={styles.retry}>{t('common.retry', 'Retry')}</Text>
          </Pressable>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Clock size={40} color={c.textMuted} style={{ opacity: 0.4 }} />
          <Text style={styles.emptyText}>{t('email_list.no_scheduled_emails', 'No scheduled emails')}</Text>
          <Text style={styles.emptyHint}>
            {t('email_list.no_scheduled_emails_description', 'Messages scheduled for later will appear here.')}
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.emailSubmissionId}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={styles.listContent}
          refreshing={loading}
          onRefresh={() => { void load(); }}
        />
      )}

      {/* Per-message actions */}
      <Modal visible={!!actionsFor} transparent animationType="fade" onRequestClose={() => setActionsFor(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setActionsFor(null)}>
          <Pressable style={styles.card} onPress={() => {}}>
            <Text style={styles.cardTitle} numberOfLines={2}>
              {actionsFor?.subject || t('email_composer.no_subject', '(No Subject)')}
            </Text>
            {actionRows.map((row) => (
              <Pressable
                key={row.label}
                style={styles.cardRow}
                onPress={() => { setActionsFor(null); row.onPress(); }}
              >
                <Text style={[styles.cardRowLabel, row.destructive && { color: c.error }]}>{row.label}</Text>
              </Pressable>
            ))}
            <Pressable style={styles.cardCancel} onPress={() => setActionsFor(null)}>
              <Text style={styles.cardCancelText}>{t('common.cancel', 'Cancel')}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Reschedule presets */}
      <Modal visible={!!rescheduleFor && customStage === null} transparent animationType="fade" onRequestClose={() => setRescheduleFor(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setRescheduleFor(null)}>
          <Pressable style={styles.card} onPress={() => {}}>
            <Text style={styles.cardTitle}>{t('email_list.reschedule_send', 'Reschedule')}</Text>
            {reschedulePresets.map((preset) => (
              <Pressable
                key={preset.label}
                style={styles.cardRow}
                onPress={() => {
                  const item = rescheduleFor;
                  setRescheduleFor(null);
                  if (item) onReschedule(item, preset.date);
                }}
              >
                <Clock size={16} color={c.textSecondary} />
                <Text style={styles.cardRowLabel}>{preset.label}</Text>
                <Text style={styles.cardRowTime}>{formatWhen(preset.date.toISOString())}</Text>
              </Pressable>
            ))}
            <Pressable style={styles.cardRow} onPress={startCustomPicker}>
              <Text style={styles.cardRowLabel}>{t('email_composer.schedule_custom', 'Pick date & time…')}</Text>
            </Pressable>
            <Pressable style={styles.cardCancel} onPress={() => setRescheduleFor(null)}>
              <Text style={styles.cardCancelText}>{t('common.cancel', 'Cancel')}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {customStage !== null && Platform.OS === 'ios' && (
        <Modal transparent animationType="fade" onRequestClose={() => setCustomStage(null)}>
          <Pressable style={styles.modalBackdrop} onPress={() => setCustomStage(null)}>
            <Pressable style={styles.card} onPress={() => {}}>
              <DateTimePicker
                value={customDraftRef.current}
                mode="datetime"
                display="spinner"
                minimumDate={new Date()}
                maximumDate={jmapClient.latestHoldDate(rescheduleFor?.accountId)}
                onChange={onCustomPickerChange}
              />
              <View style={styles.cardActions}>
                <Pressable style={styles.cardCancel} onPress={() => setCustomStage(null)}>
                  <Text style={styles.cardCancelText}>{t('common.cancel', 'Cancel')}</Text>
                </Pressable>
                <Pressable style={styles.cardConfirm} onPress={() => confirmCustom(customDraftRef.current)}>
                  <Text style={styles.cardConfirmText}>{t('email_list.reschedule_send', 'Reschedule')}</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      )}

      {customStage !== null && Platform.OS !== 'ios' && (
        <DateTimePicker
          value={customDraftRef.current}
          mode={customStage === 'time' ? 'time' : 'date'}
          display="default"
          minimumDate={customStage === 'date' ? new Date() : undefined}
          maximumDate={customStage === 'date' ? jmapClient.latestHoldDate(rescheduleFor?.accountId) : undefined}
          onChange={onCustomPickerChange}
        />
      )}
    </SafeAreaView>
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
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.lg },
    error: { ...typography.body, color: c.error, textAlign: 'center' },
    retry: { ...typography.bodyMedium, color: c.primary, marginTop: spacing.sm },
    emptyText: { ...typography.body, color: c.textSecondary },
    emptyHint: { ...typography.caption, color: c.textMuted, textAlign: 'center', maxWidth: 280 },
    listContent: { paddingVertical: spacing.sm },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: c.border },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    rowMain: { flex: 1, minWidth: 0, gap: 2 },
    sendAtRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    sendAt: { ...typography.caption, color: c.primary, fontWeight: '600' },
    subject: { ...typography.bodyMedium, color: c.text },
    recipient: { ...typography.caption, color: c.textSecondary },
    preview: { ...typography.caption, color: c.textMuted },
    actionBtn: {
      width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm,
    },
    modalBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: spacing.lg,
    },
    card: {
      width: '100%',
      maxWidth: 420,
      backgroundColor: c.background,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      padding: spacing.lg,
      gap: spacing.xs,
    },
    cardTitle: { ...typography.h3, color: c.text, marginBottom: spacing.xs },
    cardRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.sm + 2,
      minHeight: 44,
    },
    cardRowLabel: { ...typography.body, color: c.text, flex: 1 },
    cardRowTime: { ...typography.caption, color: c.textMuted },
    cardActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
    cardCancel: { alignItems: 'center', paddingVertical: spacing.sm, marginTop: spacing.xs, paddingHorizontal: spacing.md },
    cardCancelText: { ...typography.bodyMedium, color: c.textSecondary },
    cardConfirm: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.sm,
      backgroundColor: c.primary,
      marginTop: spacing.xs,
    },
    cardConfirmText: { ...typography.bodyMedium, color: c.primaryForeground },
  });
}
