import React from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useColors } from '../../theme/colors';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useLocaleStore } from '../../stores/locale-store';
import { useNetworkStore } from '../../stores/network-store';
import { useOutboxStore } from '../../stores/outbox-store';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';
import { useSheetBottomInset } from '../../lib/sheet-bottom-inset';
import { canCancel, queuedSendStatus, type QueuedSend } from '../../lib/send-queue';

function recipientsOf(send: QueuedSend): string {
  const { to, cc, bcc } = send.payload.outgoing;
  return [...to, ...(cc ?? []), ...(bcc ?? [])].map((r) => r.name || r.email).join(', ');
}

/**
 * The Outbox: messages sent while offline that haven't gone out yet. Each
 * can be moved to Drafts (online) or discarded, and a failed one tried
 * again; none of that while it is on its way.
 */
export function OutboxSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const online = useNetworkStore((s) => s.online);
  const sends = useOutboxStore((s) => s.sends);
  const bottomInset = useSheetBottomInset(visible);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (visible && sends.length === 0) onClose();
  }, [visible, sends.length, onClose]);

  const moveToDrafts = async (send: QueuedSend) => {
    setBusyId(send.id);
    const ok = await useOutboxStore.getState().cancelSend(send.id, { keepAsDraft: true });
    setBusyId(null);
    if (!ok) {
      Alert.alert(
        t('outbox.move_failed_title', 'Could not move to Drafts'),
        t('outbox.move_failed_body', 'The message stays in the Outbox. Try again when the connection is back.'),
      );
    }
  };

  const discard = (send: QueuedSend) => {
    Alert.alert(
      t('outbox.discard_title', 'Discard this message?'),
      t('outbox.discard_body', 'It will not be sent, and its text is lost.'),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: t('outbox.discard', 'Discard'),
          style: 'destructive',
          onPress: () => { void useOutboxStore.getState().cancelSend(send.id); },
        },
      ],
    );
  };

  return (
    <Modal supportedOrientations={MODAL_ORIENTATIONS} visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable accessible={false} style={[styles.backdrop, { paddingBottom: spacing.lg + bottomInset }]} onPress={onClose}>
        <Pressable accessible={false} style={styles.card} onPress={() => {}}>
          <Text style={styles.title} accessibilityRole="header">{t('outbox.title', 'Outbox')}</Text>
          <ScrollView style={styles.list}>
            {sends.map((send) => {
              const busy = busyId === send.id || send.status === 'sending';
              const cancellable = canCancel(send) && busyId !== send.id;
              return (
                <View key={send.id} style={styles.row}>
                  <Text style={styles.subject} numberOfLines={1}>
                    {send.payload.outgoing.subject || t('email_viewer.no_subject', '(No subject)')}
                  </Text>
                  <Text style={styles.recipients} numberOfLines={1}>{recipientsOf(send)}</Text>
                  <View style={styles.statusRow}>
                    {busy && <ActivityIndicator size="small" color={c.textSecondary} />}
                    <Text
                      style={[styles.status, send.status === 'failed' && styles.statusFailed]}
                      numberOfLines={2}
                    >
                      {queuedSendStatus(send, online, t)}
                    </Text>
                  </View>
                  <View style={styles.actions}>
                    {send.status === 'failed' && (
                      <Pressable
                        style={styles.action}
                        onPress={() => { void useOutboxStore.getState().retrySend(send.id); }}
                        accessibilityRole="button"
                      >
                        <Text style={styles.actionPrimary}>{t('outbox.retry', 'Try again')}</Text>
                      </Pressable>
                    )}
                    {online && (
                      <Pressable
                        style={styles.action}
                        disabled={!cancellable}
                        onPress={() => { void moveToDrafts(send); }}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: !cancellable }}
                      >
                        <Text style={[styles.actionText, !cancellable && styles.actionDisabled]}>
                          {t('outbox.move_to_drafts', 'Move to Drafts')}
                        </Text>
                      </Pressable>
                    )}
                    <Pressable
                      style={styles.action}
                      disabled={!cancellable}
                      onPress={() => discard(send)}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: !cancellable }}
                    >
                      <Text style={[styles.actionDestructive, !cancellable && styles.actionDisabled]}>
                        {t('outbox.discard', 'Discard')}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </ScrollView>
          <Pressable style={styles.close} onPress={onClose} accessibilityRole="button">
            <Text style={styles.closeText}>{t('common.close', 'Close')}</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: spacing.lg,
    },
    card: {
      width: '100%',
      maxWidth: 480,
      maxHeight: '90%',
      backgroundColor: c.background,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      padding: spacing.lg,
      gap: spacing.sm,
    },
    title: { ...typography.h3, color: c.text },
    list: { flexGrow: 0 },
    row: {
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderLight,
      gap: 2,
    },
    subject: { ...typography.bodyMedium, color: c.text },
    recipients: { ...typography.caption, color: c.textSecondary },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    status: { ...typography.caption, color: c.textMuted, flex: 1 },
    statusFailed: { color: c.error },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.xs },
    action: { minHeight: 40, justifyContent: 'center' },
    actionText: { ...typography.bodyMedium, color: c.textSecondary },
    actionPrimary: { ...typography.bodyMedium, color: c.primary },
    actionDestructive: { ...typography.bodyMedium, color: c.error },
    actionDisabled: { opacity: 0.4 },
    close: { alignItems: 'center', paddingVertical: spacing.sm },
    closeText: { ...typography.bodyMedium, color: c.textSecondary },
  });
}
