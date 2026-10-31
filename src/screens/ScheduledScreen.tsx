import React from 'react';
import {
  View, Text, StyleSheet, FlatList, ActivityIndicator, Pressable, Alert, Modal, Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Clock, MoreHorizontal } from '../components/icons';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import {
  listScheduledEmails,
  rescheduleScheduledSend,
  getFullEmail,
  type ScheduledEmail,
} from '../api/email';
import { jmapClient, ScheduleTooLateError, SubmissionQuotaError } from '../api/jmap-client';
import { NoLongerScheduledError, RecipientsRefusedError, type RefusedRecipient } from '../api/jmap-result';
import { partlyRefusedWarning, rescheduleFailureNotice, sendFailureMessage } from '../lib/send-failure-message';
import { useEmailStore } from '../stores/email-store';
import { useLocaleStore } from '../stores/locale-store';
import { useSettingsStore } from '../stores/settings-store';
import { useSendUndoStore } from '../stores/send-undo-store';
import { toast } from '../stores/toast-store';
import { draftContextFromEmail } from '../lib/draft-context';
import { formatScheduledSendAt, schedulePresetLabel, schedulePresets } from '../lib/compose-schedule';
import { spacing, typography, componentSizes, radius, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { MODAL_ORIENTATIONS } from '../lib/modal-orientations';
import { isPendingSend, sameScheduledSend, scheduledSendKey } from '../lib/scheduled-send-key';
import { rescheduleErrorNotice, rescheduleLostMessage, restoredSubmission } from '../lib/compose-reschedule';
import { cancelScheduledToDrafts, scheduledAccountOverride } from '../lib/compose-scheduled';
import { useBackWhileFocused } from '../lib/use-back-while-focused';
import { loginMovedFrom } from '../lib/compose-login';
import { servedLoginOf } from '../lib/draft-login';
import { useAuthStore } from '../stores/auth-store';
import { ScheduledMessageView } from '../components/compose/ScheduledMessageView';
import type { Email } from '../api/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Scheduled'>;

export default function ScheduledScreen({ navigation }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const insets = useSafeAreaInsets();
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
  // The scheduled message open in the read-only view (native #84).
  const [viewing, setViewing] = React.useState<ScheduledEmail | null>(null);
  const [viewEmail, setViewEmail] = React.useState<Email | null>(null);
  const [viewError, setViewError] = React.useState<string | null>(null);
  const viewSeq = React.useRef(0);
  // The login the rows were read for. Submission and email ids repeat across
  // logins: after a switch (a notification or link for another account) the
  // rows on screen are the old login's, and acting on them would cancel or
  // send whatever the new one has under the same ids.
  const ownerRef = React.useRef<string | null>(null);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const session = useAuthStore((s) => s.session);
  const refuseOtherLogin = React.useCallback(() => {
    if (!loginMovedFrom(ownerRef.current)) return false;
    Alert.alert(
      t('email_composer.login_switched_title', 'Account switched'),
      t('scheduled.login_switched', 'These scheduled messages belong to another account. Switch back to it to change them.'),
    );
    return true;
  }, [t]);
  const openView = React.useCallback((item: ScheduledEmail) => {
    if (refuseOtherLogin()) return;
    const seq = ++viewSeq.current;
    setViewing(item);
    setViewEmail(null);
    setViewError(null);
    getFullEmail(item.emailId, scheduledAccountOverride(item, jmapClient.accountId)).then(
      (email) => { if (viewSeq.current === seq) setViewEmail(email); },
      (e: unknown) => { if (viewSeq.current === seq) setViewError(e instanceof Error ? e.message : String(e)); },
    );
  }, [refuseOtherLogin]);
  const closeView = React.useCallback(() => {
    viewSeq.current += 1;
    setViewing(null);
    setViewEmail(null);
    setViewError(null);
  }, []);
  useBackWhileFocused(!!viewing, closeView);

  // Rounded to the minute (the server can land a second early: 08:00 read
  // 07:59), with the date when it is not today (webmail scheduled-send-label).
  const formatWhen = React.useCallback(
    (iso: string) => formatScheduledSendAt(iso, timeFormat, locale),
    [timeFormat, locale],
  );

  const recipientLabel = (item: ScheduledEmail): string => {
    const first = item.to?.[0];
    if (!first) return t('email_composer.no_recipient', '(no recipient)');
    const name = first.name || first.email;
    const extra = (item.to?.length ?? 0) - 1;
    return extra > 0 ? `${name} +${extra}` : name;
  };

  // Only the latest read is shown: one started before a switch of logins may
  // finish after the next one.
  const loadSeq = React.useRef(0);
  const load = React.useCallback(async () => {
    const seq = ++loadSeq.current;
    const owner = servedLoginOf(jmapClient);
    setLoading(true);
    setError(null);
    try {
      const list = await listScheduledEmails();
      if (seq !== loadSeq.current) return;
      // Switched during the read: the next session reads again.
      if (loginMovedFrom(owner)) return;
      ownerRef.current = owner;
      setItems(list);
    } catch (e) {
      if (seq === loadSeq.current) setError(e instanceof Error ? e.message : t('email_list.error', 'Error'));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [t]);

  // Read on mount and again for every session; rows, the open view and the
  // menus of another login go at once.
  React.useEffect(() => {
    if (ownerRef.current !== null && loginMovedFrom(ownerRef.current)) {
      ownerRef.current = null;
      setItems([]);
      setActionsFor(null);
      setRescheduleFor(null);
      setCustomStage(null);
    }
    void load();
  }, [activeAccountId, session, load]);

  // A message that is gone from the list (sent, cancelled, read again after
  // a switch) closes its view.
  React.useEffect(() => {
    if (viewing && !items.some((i) => sameScheduledSend(i, viewing))) closeView();
  }, [items, viewing, closeView]);

  const runAction = async (item: ScheduledEmail, action: () => Promise<void>, failTitle: string) => {
    if (refuseOtherLogin()) return;
    setBusyId(scheduledSendKey(item));
    try {
      await action();
    } catch (e) {
      // A failed reschedule or "Send now" put the original back under a new
      // id, or could not, and the message is back in Drafts (#1308).
      const restored = restoredSubmission(e);
      if (restored || rescheduleLostMessage(e)) {
        if (restored) {
          updateItem(item, { emailSubmissionId: restored.emailSubmissionId, sendAt: restored.sendAt ?? item.sendAt });
          const pending = useSendUndoStore.getState().pending;
          if (isPendingSend(pending, item, jmapClient.accountId)) {
            useSendUndoStore.getState().setPending({ ...pending!, emailSubmissionId: restored.emailSubmissionId });
          }
        } else {
          clearUndoFor(item);
          removeItem(item);
        }
        const { title, message } = rescheduleErrorNotice(e, t, failTitle, formatWhen, item.sendAt);
        Alert.alert(title, message);
        return;
      }
      if (e instanceof ScheduleTooLateError) {
        Alert.alert(
          t('email_composer.schedule_too_late_title', 'Too far ahead'),
          t('email_composer.schedule_too_late_body', 'That is later than this server allows. Pick an earlier time.'),
        );
        return;
      }
      // "Send now" and a reschedule create a submission, which a full quota
      // refuses; the message stays scheduled as it was.
      if (e instanceof SubmissionQuotaError) {
        Alert.alert(failTitle, sendFailureMessage(e, t));
        return;
      }
      // Making room for the replacement took a while, and the message went
      // out, or was cancelled elsewhere, meanwhile: nothing was changed.
      if (e instanceof NoLongerScheduledError) {
        Alert.alert(failTitle, sendFailureMessage(e, t));
        void load();
        return;
      }
      // The server refused recipients of the replacement that the message had
      // been taken for (a throttle used up since it was scheduled): it goes
      // at its old time, as it was.
      if (e instanceof RecipientsRefusedError) {
        const { title, message } = rescheduleFailureNotice(e, t, failTitle, formatWhen(item.sendAt));
        Alert.alert(title, message);
        return;
      }
      Alert.alert(failTitle, e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  /** Recipients the server refused for a replacement it took for the others. */
  const warnRefused = (refused: RefusedRecipient[] | undefined) => {
    if (!refused?.length) return;
    const { title, message } = partlyRefusedWarning(refused, t);
    toast.warning(title, { message, duration: 10_000 });
  };

  // Submission ids repeat across accounts: a row is its account and id.
  const removeItem = (item: ScheduledEmail) => {
    setItems((prev) => prev.filter((i) => !sameScheduledSend(i, item)));
    // It is gone from Scheduled: the view of it closes too.
    setViewing((v) => (v && sameScheduledSend(v, item) ? null : v));
  };
  const updateItem = (item: ScheduledEmail, patch: Pick<ScheduledEmail, 'emailSubmissionId' | 'sendAt'>) => {
    setItems((prev) => prev
      .map((i) => (sameScheduledSend(i, item) ? { ...i, ...patch } : i))
      .sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime()));
    setViewing((v) => (v && sameScheduledSend(v, item) ? { ...v, ...patch } : v));
  };
  const clearUndoFor = (item: ScheduledEmail) => {
    if (isPendingSend(useSendUndoStore.getState().pending, item, jmapClient.accountId)) useSendUndoStore.getState().clear();
  };

  const onCancel = (item: ScheduledEmail) => {
    Alert.alert(
      t('email_list.cancel_scheduled_send', 'Cancel send'),
      t('scheduled.cancel_to_drafts_body', 'The message will not be sent. It goes back to your Drafts.'),
      [
        { text: t('scheduled.keep_scheduled', 'Keep scheduled'), style: 'cancel' },
        {
          text: t('email_list.cancel_scheduled_send', 'Cancel send'),
          style: 'destructive',
          onPress: () => {
            void runAction(item, async () => {
              const { inDrafts, moveError } = await cancelScheduledToDrafts(item, mailboxes, jmapClient.accountId);
              clearUndoFor(item);
              removeItem(item);
              if (moveError) {
                // Not scheduled any more either way: it just stayed in Sent.
                toast.warning(
                  t('scheduled.cancelled_not_moved', 'Send cancelled, but not moved to Drafts'),
                  { message: t('scheduled.cancelled_not_moved_body', 'The message will not be sent. It is still in Sent.') },
                );
                return;
              }
              toast.success(
                t('scheduled.send_cancelled', 'Send cancelled'),
                inDrafts
                  ? { message: t('notifications.moved_to_mailbox', 'Moved to {mailbox}', { mailbox: t('sidebar.mailboxes.drafts', 'Drafts') }) }
                  : undefined,
              );
            }, t('scheduled.cancel_failed', 'Cancel failed'));
          },
        },
      ],
    );
  };

  const onSendNow = (item: ScheduledEmail) => {
    void runAction(item, async () => {
      const result = await rescheduleScheduledSend(item, 0);
      clearUndoFor(item);
      removeItem(item);
      warnRefused(result.refusedRecipients);
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
      clearUndoFor(item);
      updateItem(item, {
        emailSubmissionId: result.emailSubmissionId ?? item.emailSubmissionId,
        sendAt: result.sendAt ?? date.toISOString(),
      });
      warnRefused(result.refusedRecipients);
    }, t('scheduled.reschedule_failed', 'Reschedule failed'));
  };

  // Cancel the submission, move the message back into Drafts and open it in
  // the composer (webmail cancelScheduledEmailForEdit).
  const onEdit = (item: ScheduledEmail) => {
    void runAction(item, async () => {
      // A message held in a shared account goes back to that account's Drafts.
      const { moveError } = await cancelScheduledToDrafts(item, mailboxes, jmapClient.accountId);
      clearUndoFor(item);
      if (moveError) {
        // Opening it in the composer would edit the copy in Sent.
        removeItem(item);
        toast.warning(
          t('scheduled.cancelled_not_moved', 'Send cancelled, but not moved to Drafts'),
          { message: t('scheduled.cancelled_not_moved_body', 'The message will not be sent. It is still in Sent.') },
        );
        return;
      }
      const email = await getFullEmail(item.emailId, item.accountId);
      removeItem(item);
      navigation.replace('Compose', { draft: draftContextFromEmail(email, scheduledAccountOverride(item, jmapClient.accountId)) });
    }, t('scheduled.edit_failed', 'Could not open the message for editing'));
  };

  const reschedulePresets = React.useMemo(() => {
    const now = new Date();
    const inHours = (h: number) => new Date(now.getTime() + h * 3600 * 1000);
    // Only offer times within the server's hold limit.
    const maxMs = jmapClient.getMaxDelayedSend(rescheduleFor?.accountId) * 1000;
    return [
      { label: t('email_composer.schedule_in_1h', 'In 1 hour'), date: inHours(1) },
      { label: t('email_composer.schedule_in_3h', 'In 3 hours'), date: inHours(3) },
      // The composer's presets, the webmail's (lib/compose-schedule).
      ...schedulePresets(now).map((preset) => ({ label: schedulePresetLabel(preset.key, t), date: preset.date })),
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
    const busy = busyId === scheduledSendKey(item);
    return (
      <Pressable style={styles.row} onPress={() => openView(item)} disabled={busy}>
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
        <Pressable
          style={styles.actionBtn}
          onPress={() => setActionsFor(item)}
          disabled={busy}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('scheduled.actions', 'Actions')}
        >
          {busy ? (
            <ActivityIndicator size="small" color={c.primary} />
          ) : (
            <MoreHorizontal size={18} color={c.textSecondary} />
          )}
        </Pressable>
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
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      {viewing ? (
        <ScheduledMessageView
          item={viewing}
          email={viewEmail}
          error={viewError}
          jmapAccountId={scheduledAccountOverride(viewing, jmapClient.accountId)}
          busy={busyId === scheduledSendKey(viewing)}
          formatWhen={formatWhen}
          onBack={closeView}
          onRetry={() => openView(viewing)}
          onSendNow={() => onSendNow(viewing)}
          onReschedule={() => setRescheduleFor(viewing)}
          onEdit={() => onEdit(viewing)}
          onCancelSend={() => onCancel(viewing)}
        />
      ) : (
      <>
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
          keyExtractor={scheduledSendKey}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          // A stack screen has no tab bar: the list ends clear of the gesture bar.
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + spacing.sm }]}
          refreshing={loading}
          onRefresh={() => { void load(); }}
        />
      )}
      </>
      )}

      {/* Per-message actions */}
      <Modal supportedOrientations={MODAL_ORIENTATIONS} visible={!!actionsFor} transparent animationType="fade" onRequestClose={() => setActionsFor(null)}>
        <Pressable accessible={false} style={styles.modalBackdrop} onPress={() => setActionsFor(null)}>
          <Pressable accessible={false} style={styles.card} onPress={() => {}}>
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
      <Modal supportedOrientations={MODAL_ORIENTATIONS} visible={!!rescheduleFor && customStage === null} transparent animationType="fade" onRequestClose={() => setRescheduleFor(null)}>
        <Pressable accessible={false} style={styles.modalBackdrop} onPress={() => setRescheduleFor(null)}>
          <Pressable accessible={false} style={styles.card} onPress={() => {}}>
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
        <Modal supportedOrientations={MODAL_ORIENTATIONS} transparent animationType="fade" onRequestClose={() => setCustomStage(null)}>
          <Pressable accessible={false} style={styles.modalBackdrop} onPress={() => setCustomStage(null)}>
            <Pressable accessible={false} style={styles.card} onPress={() => {}}>
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
