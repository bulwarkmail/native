import React from 'react';
import {
  View, Text, StyleSheet, FlatList, ActivityIndicator, Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Star, Paperclip, AlertTriangle } from 'lucide-react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import SenderAvatar from '../components/SenderAvatar';
import { fetchUnifiedInbox, type UnifiedEmail } from '../api/unified-inbox';
import { useAccountStore } from '../stores/account-store';
import { useAuthStore } from '../stores/auth-store';
import { useSettingsStore } from '../stores/settings-store';
import { useLocaleStore } from '../stores/locale-store';
import { formatListDate } from '../lib/date-format';
import { spacing, typography, componentSizes, radius, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

type Props = NativeStackScreenProps<RootStackParamList, 'UnifiedInbox'>;

function senderName(email: UnifiedEmail): string {
  return email.from?.[0]?.name || email.from?.[0]?.email || 'Unknown';
}

export default function UnifiedInboxScreen({ navigation }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const accounts = useAccountStore((s) => s.accounts);
  const switchAccount = useAuthStore((s) => s.switchAccount);
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const includeGroup = useSettingsStore((s) => s.includeGroupInUnified);
  const locale = useLocaleStore((s) => s.locale);

  const [emails, setEmails] = React.useState<UnifiedEmail[]>([]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [loading, setLoading] = React.useState(true);
  const [opening, setOpening] = React.useState(false);

  const accountById = React.useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts],
  );
  const accountIds = React.useMemo(() => accounts.map((a) => a.id), [accounts]);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchUnifiedInbox(accountIds, 25, { includeGroup });
      setEmails(result.emails);
      setErrors(result.errors);
    } finally {
      setLoading(false);
    }
  }, [accountIds, includeGroup]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const onOpen = React.useCallback(
    (email: UnifiedEmail) => {
      if (opening) return;
      setOpening(true);
      void (async () => {
        try {
          const auth = useAuthStore.getState();
          if (auth.activeAccountId !== email.sourceAccountId) {
            await switchAccount(email.sourceAccountId);
            if (useAuthStore.getState().activeAccountId !== email.sourceAccountId) return;
          }
          navigation.navigate('EmailThread', {
            emailId: email.id,
            threadId: email.threadId,
            subject: email.subject,
            // Group/shared messages live under another JMAP account in the
            // same session; pass it so the thread opens against the right one.
            jmapAccountId: email.isShared ? email.jmapAccountId : undefined,
          });
        } finally {
          setOpening(false);
        }
      })();
    },
    [opening, switchAccount, navigation],
  );

  const errorCount = Object.keys(errors).length;

  const renderItem = ({ item }: { item: UnifiedEmail }) => {
    const acc = accountById.get(item.sourceAccountId);
    const unread = !item.keywords?.$seen;
    const starred = !!item.keywords?.$flagged;
    return (
      <Pressable
        onPress={() => onOpen(item)}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        <View style={styles.avatarWrap}>
          <SenderAvatar
            name={senderName(item)}
            email={item.from?.[0]?.email}
            size={componentSizes.avatarMd}
          />
          {acc && <View style={[styles.accountDot, { backgroundColor: acc.avatarColor }]} />}
        </View>
        <View style={styles.content}>
          <View style={styles.line}>
            <Text style={[styles.sender, unread && styles.bold]} numberOfLines={1}>
              {senderName(item)}
            </Text>
            {starred && <Star size={12} color={c.starred} fill={c.starred} />}
            {item.hasAttachment && <Paperclip size={12} color={c.textMuted} />}
            <Text style={styles.time}>{formatListDate(item.receivedAt, { dateFormat, timeFormat, locale })}</Text>
          </View>
          <Text style={[styles.subject, unread && styles.bold]} numberOfLines={1}>
            {item.subject || '(no subject)'}
          </Text>
          <View style={styles.line}>
            {acc && (
              <Text style={styles.account} numberOfLines={1}>
                {acc.email || acc.username}
              </Text>
            )}
            {item.isShared && (
              <View style={styles.sharedBadge}>
                <Text style={styles.sharedBadgeText} numberOfLines={1}>
                  {item.sharedLabel || 'Shared'}
                </Text>
              </View>
            )}
          </View>
          {item.preview ? (
            <Text style={styles.preview} numberOfLines={1}>{item.preview}</Text>
          ) : null}
        </View>
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} style={styles.headerBtn} hitSlop={8}>
          <ArrowLeft size={22} color={c.text} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>All inboxes</Text>
        <View style={styles.headerBtn}>
          {opening ? <ActivityIndicator size="small" color={c.primary} /> : null}
        </View>
      </View>

      {errorCount > 0 && (
        <View style={styles.errorBanner}>
          <AlertTriangle size={14} color={c.error} />
          <Text style={styles.errorBannerText} numberOfLines={1}>
            {errorCount === 1
              ? '1 account could not be loaded'
              : `${errorCount} accounts could not be loaded`}
          </Text>
        </View>
      )}

      {loading && emails.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.primary} />
          <Text style={styles.loadingText}>Loading all inboxes…</Text>
        </View>
      ) : emails.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.loadingText}>No mail across your accounts</Text>
        </View>
      ) : (
        <FlatList
          data={emails}
          keyExtractor={(item) => `${item.sourceAccountId}:${item.id}`}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
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
    errorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: c.errorBg,
    },
    errorBannerText: { ...typography.caption, color: c.error, flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
    loadingText: { ...typography.body, color: c.textSecondary },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: c.border },
    row: {
      flexDirection: 'row',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    rowPressed: { backgroundColor: c.surfaceHover },
    avatarWrap: { position: 'relative' },
    accountDot: {
      position: 'absolute',
      right: -2, bottom: -2,
      width: 12, height: 12,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: c.background,
    },
    content: { flex: 1, minWidth: 0, gap: 1 },
    line: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    sender: { ...typography.bodyMedium, color: c.text, flex: 1 },
    bold: { fontWeight: '700' },
    time: { ...typography.caption, color: c.textMuted },
    subject: { ...typography.body, color: c.text },
    account: { ...typography.caption, color: c.textMuted },
    sharedBadge: {
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: radius.full,
      backgroundColor: c.muted,
      maxWidth: 120,
    },
    sharedBadgeText: { fontSize: 10, fontWeight: '500', color: c.mutedForeground },
    preview: { ...typography.caption, color: c.textMuted },
  });
}
