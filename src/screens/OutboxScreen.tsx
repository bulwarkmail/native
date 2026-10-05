import React from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Send } from 'lucide-react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useSendQueueStore, type QueuedSend } from '../stores/send-queue-store';
import { useAccountStore } from '../stores/account-store';
import { useNetworkStore } from '../stores/network-store';
import { useLocaleStore } from '../stores/locale-store';
import { outboxRows, allQueuedSends, type OutboxAction, type OutboxLabel, type OutboxRow } from '../lib/outbox-rows';
import { requeueAndFlush, saveEntryAsDraft } from '../lib/outbox-actions';
import { spacing, typography, componentSizes, radius, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

type Props = NativeStackScreenProps<RootStackParamList, 'Outbox'>;

export default function OutboxScreen({ navigation }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const entries = useSendQueueStore((s) => s.entries);
  const accounts = useAccountStore((s) => s.accounts);
  const activeAppAccountId = useAccountStore((s) => s.activeAccountId);
  const online = useNetworkStore((s) => s.online);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  // Mutators need a hydrated account; load every account's rows.
  React.useEffect(() => {
    for (const a of useAccountStore.getState().accounts) {
      void useSendQueueStore.getState().hydrateAccount(a.id).catch(() => undefined);
    }
  }, [accounts]);

  const rows = React.useMemo(() => {
    const accountLabels: Record<string, string> = {};
    for (const a of accounts) accountLabels[a.id] = a.email || a.username;
    return outboxRows(allQueuedSends(entries), { now: Date.now(), activeAppAccountId, accountLabels, online });
  }, [entries, accounts, activeAppAccountId, online]);

  const label = (l: OutboxLabel) => t(l.key, l.fallback, l.params);

  const run = async (row: OutboxRow, action: () => Promise<void>) => {
    setBusyId(row.id);
    try {
      await action();
    } catch (e) {
      Alert.alert(t('outbox.action_failed', 'That did not work'), e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const confirm = (title: string, message: string, confirmText: string, onConfirm: () => void, destructive = false) => {
    Alert.alert(title, message, [
      { text: t('common.cancel', 'Cancel'), style: 'cancel' },
      { text: confirmText, style: destructive ? 'destructive' : 'default', onPress: onConfirm },
    ]);
  };

  const onAction = (row: OutboxRow, action: OutboxAction) => {
    const entry: QueuedSend = row.entry;
    const uncertain = row.state === 'uncertain';
    switch (action) {
      case 'retry':
        void run(row, () => requeueAndFlush(entry));
        break;
      case 'send_again':
        confirm(
          t('outbox.send_again', 'Send again'),
          t('outbox.confirm_resend', 'This message may already have been sent. Check your Sent folder before sending it again. Send again?'),
          t('outbox.send_again', 'Send again'),
          () => { void run(row, () => requeueAndFlush(entry)); },
        );
        break;
      case 'save_draft': {
        const save = () => {
          void run(row, async () => {
            await saveEntryAsDraft(entry);
            Alert.alert(t('outbox.draft_saved', 'Saved to Drafts'));
          });
        };
        if (uncertain) {
          confirm(
            t('outbox.save_draft', 'Save as draft'),
            t('outbox.confirm_draft_uncertain', 'This message may already have been sent. Check your Sent folder before saving it as a draft. Save as draft?'),
            t('outbox.save_draft', 'Save as draft'),
            save,
          );
        } else {
          save();
        }
        break;
      }
      case 'discard':
        confirm(
          t('outbox.discard', 'Discard'),
          uncertain
            ? t('outbox.confirm_discard_uncertain', 'This message may already have been sent. Discard it from the Outbox?')
            : t('outbox.confirm_discard', 'Discard this message? It will not be sent.'),
          t('outbox.discard', 'Discard'),
          () => { void run(row, () => useSendQueueStore.getState().discard(entry.id)); },
          true,
        );
        break;
    }
  };

  const actionLabel = (a: OutboxAction): string => {
    switch (a) {
      case 'retry': return t('outbox.retry', 'Retry');
      case 'send_again': return t('outbox.send_again', 'Send again');
      case 'save_draft': return t('outbox.save_draft', 'Save as draft');
      case 'discard': return t('outbox.discard', 'Discard');
    }
  };

  const renderItem = ({ item }: { item: OutboxRow }) => {
    const busy = busyId === item.id;
    return (
      <View style={styles.row}>
        <Text style={styles.subject} numberOfLines={1}>
          {item.subject || t('email_composer.no_subject', '(No Subject)')}
        </Text>
        <Text style={styles.recipient} numberOfLines={1}>
          {t('email_composer.to', 'To')}: {item.recipients.length ? item.recipients.join(', ') : t('email_composer.no_recipient', '(no recipient)')}
        </Text>
        <Text style={[styles.state, item.state === 'failed' && { color: c.error }]} numberOfLines={2}>
          {label(item.stateLabel)}
        </Text>
        {item.accountNote ? <Text style={styles.note} numberOfLines={2}>{label(item.accountNote)}</Text> : null}
        {item.actions.length > 0 ? (
          <View style={styles.actions}>
            {item.actions.map((a) => (
              <Pressable
                key={a}
                disabled={busy}
                onPress={() => onAction(item, a)}
                accessibilityRole="button"
                style={[styles.actionBtn, busy && { opacity: 0.5 }]}
              >
                <Text style={[styles.actionText, a === 'discard' && { color: c.error }]}>{actionLabel(a)}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    );
  };

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
        <Text style={styles.headerTitle} numberOfLines={1}>{t('outbox.title', 'Outbox')}</Text>
        <View style={styles.headerBtn} />
      </View>
      {rows.length === 0 ? (
        <View style={styles.center}>
          <Send size={40} color={c.textMuted} style={{ opacity: 0.4 }} />
          <Text style={styles.emptyText}>{t('outbox.empty', 'Nothing waiting to be sent')}</Text>
          <Text style={styles.emptyHint}>
            {t('outbox.empty_hint', 'Messages you send while offline wait here until you are back online.')}
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={styles.listContent}
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
    headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
    headerTitle: { ...typography.h3, color: c.text, flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.lg },
    emptyText: { ...typography.body, color: c.textSecondary },
    emptyHint: { ...typography.caption, color: c.textMuted, textAlign: 'center', maxWidth: 280 },
    listContent: { paddingVertical: spacing.sm },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: c.border },
    row: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: 2 },
    subject: { ...typography.bodyMedium, color: c.text },
    recipient: { ...typography.caption, color: c.textSecondary },
    state: { ...typography.caption, color: c.primary, fontWeight: '600' },
    note: { ...typography.caption, color: c.textMuted },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.xs },
    actionBtn: { minHeight: 36, justifyContent: 'center', paddingVertical: spacing.xs },
    actionText: { ...typography.bodyMedium, color: c.primary },
  });
}
