import React from 'react';
import {
  View, Text, StyleSheet, FlatList, ActivityIndicator, Pressable, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Clock, X } from 'lucide-react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import {
  listScheduledEmails,
  cancelScheduledSend,
  type ScheduledEmail,
} from '../api/email';
import { spacing, typography, componentSizes, radius, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

type Props = NativeStackScreenProps<RootStackParamList, 'Scheduled'>;

function recipientLabel(item: ScheduledEmail): string {
  const first = item.to?.[0];
  if (!first) return '(no recipient)';
  const name = first.name || first.email;
  const extra = (item.to?.length ?? 0) - 1;
  return extra > 0 ? `${name} +${extra}` : name;
}

export default function ScheduledScreen({ navigation }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [items, setItems] = React.useState<ScheduledEmail[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [cancelling, setCancelling] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listScheduledEmails());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load scheduled messages');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const onCancel = (item: ScheduledEmail) => {
    Alert.alert(
      'Cancel scheduled send?',
      'The message will not be delivered. A copy stays in your Sent folder.',
      [
        { text: 'Keep scheduled', style: 'cancel' },
        {
          text: 'Cancel send',
          style: 'destructive',
          onPress: () => {
            setCancelling(item.emailSubmissionId);
            void (async () => {
              try {
                await cancelScheduledSend(item.emailSubmissionId);
                setItems((prev) =>
                  prev.filter((i) => i.emailSubmissionId !== item.emailSubmissionId),
                );
              } catch (e) {
                Alert.alert('Cancel failed', e instanceof Error ? e.message : String(e));
              } finally {
                setCancelling(null);
              }
            })();
          },
        },
      ],
    );
  };

  const renderItem = ({ item }: { item: ScheduledEmail }) => (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <View style={styles.sendAtRow}>
          <Clock size={13} color={c.primary} />
          <Text style={styles.sendAt}>{new Date(item.sendAt).toLocaleString()}</Text>
        </View>
        <Text style={styles.subject} numberOfLines={1}>
          {item.subject || '(no subject)'}
        </Text>
        <Text style={styles.recipient} numberOfLines={1}>
          To: {recipientLabel(item)}
        </Text>
        {item.preview ? (
          <Text style={styles.preview} numberOfLines={1}>{item.preview}</Text>
        ) : null}
      </View>
      <Pressable
        onPress={() => onCancel(item)}
        style={styles.cancelBtn}
        hitSlop={8}
        disabled={cancelling === item.emailSubmissionId}
      >
        {cancelling === item.emailSubmissionId ? (
          <ActivityIndicator size="small" color={c.error} />
        ) : (
          <X size={18} color={c.error} />
        )}
      </Pressable>
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} style={styles.headerBtn} hitSlop={8}>
          <ArrowLeft size={22} color={c.text} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>Scheduled</Text>
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
            <Text style={styles.retry}>Retry</Text>
          </Pressable>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Clock size={40} color={c.textMuted} style={{ opacity: 0.4 }} />
          <Text style={styles.emptyText}>No scheduled messages</Text>
          <Text style={styles.emptyHint}>
            Use the clock icon in the composer to send a message later.
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
    cancelBtn: {
      width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm,
    },
  });
}
