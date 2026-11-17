import React from 'react';
import { ActivityIndicator, AppState, FlatList, NativeModules, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import type { RootStackParamList } from '../navigation/types';
import { fetchUnifiedInbox, type UnifiedEmail } from '../api/unified-inbox';
import { useAuthStore } from '../stores/auth-store';
import { useEmailStore } from '../stores/email-store';
import { useSettingsStore } from '../stores/settings-store';
import { useLocaleStore } from '../stores/locale-store';
import { formatListDate } from '../lib/date-format';
import { singleLine } from '../lib/single-line';
import { listAddressLabel } from '../lib/list-sender';
import { useOwnDomainAddress } from '../lib/use-own-domain-address';
import { cleanPreview } from '../lib/preview-text';
import { prefetchMessage, rememberRows } from '../lib/email-detail-cache';
import { onStateChangeType } from '../lib/state-change-bus';
import { spacing, radius, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

/** As many rows as a desk glance takes in; the phone is picked up for more. */
const ROWS = 20;
/** A quiet refresh now and then, should the event stream miss a change. */
const REFRESH_MS = 60_000;

type Native = { setAwakeWhileCharging(enabled: boolean): void };

/**
 * The inbox for an iPhone Duo standing on a desk as a tent (`useTent`), in
 * place of the tabs: the active account's inbox in large rows, readable from
 * a chair away, kept current as mail arrives. A row opens the message on the
 * stack; back returns here. It covers the tabs, not the banners above them
 * (an update, offline mail). The screen stays on while the phone charges
 * (BulwarkScreenAwake); on battery it locks as usual.
 */
export default function DeskInbox({ navigation }: { navigation: NativeStackNavigationProp<RootStackParamList, 'MainTabs'> }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const formatAddress = useOwnDomainAddress();
  const accountId = useAuthStore((s) => s.activeAccountId);
  const username = useAuthStore((s) => s.username);
  // The inbox's own count, as on the Mail tab's badge, not the rows on show.
  const unread = useEmailStore((s) => s.mailboxes.find((m) => m.role === 'inbox')?.unreadEmails ?? 0);
  const [rows, setRows] = React.useState<UnifiedEmail[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const loadSeq = React.useRef(0);

  const load = React.useCallback(async () => {
    // A newer load (or none, signed out) wins over one still on its way.
    const seq = ++loadSeq.current;
    if (!accountId) return;
    try {
      const result = await fetchUnifiedInbox([accountId], ROWS);
      if (seq !== loadSeq.current) return;
      // An account that could not be fetched comes back as an empty list
      // with its error, not as a rejection.
      if (accountId in result.errors) {
        setFailed(true);
        return;
      }
      setRows(result.emails);
      setFailed(false);
    } catch {
      if (seq === loadSeq.current) setFailed(true);
    }
    // After a failure the rows on show stay; the next change or refresh
    // tries again.
  }, [accountId]);

  React.useEffect(() => {
    setRows(null);
    setFailed(false);
    void load();
    const offEmail = onStateChangeType('Email', () => { void load(); });
    const appState = AppState.addEventListener('change', (next) => { if (next === 'active') void load(); });
    // Back from a message: it was read, maybe moved.
    const offFocus = navigation.addListener('focus', () => { void load(); });
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => {
      offEmail();
      appState.remove();
      offFocus();
      clearInterval(timer);
    };
  }, [load, navigation]);

  React.useEffect(() => {
    const awake = NativeModules.BulwarkScreenAwake as Native | undefined;
    awake?.setAwakeWhileCharging(true);
    return () => awake?.setAwakeWhileCharging(false);
  }, []);

  const open = React.useCallback((email: UnifiedEmail) => {
    const pages = rows ?? [email];
    rememberRows(pages, undefined);
    prefetchMessage(email, undefined);
    navigation.navigate('EmailThread', {
      emailId: email.id,
      threadId: email.threadId,
      subject: email.subject,
      emailIds: pages.map((e) => e.id),
    });
  }, [navigation, rows]);

  const inbox = t('sidebar.mailboxes.inbox', 'Inbox');

  return (
    <View
      style={[styles.root, {
        paddingTop: insets.top + spacing.md,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left + spacing.xl,
        paddingRight: insets.right + spacing.xl,
      }]}
      testID="desk-inbox"
      // Over the tabs: VoiceOver stays in the desk inbox, as the eye does.
      accessibilityViewIsModal
    >
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>{inbox}</Text>
        {username ? <Text style={styles.account} numberOfLines={1}>{username}</Text> : null}
        <View style={styles.spacer} />
        {unread > 0 && (
          <Text style={styles.count}>{`${unread} ${t('email_list.unread', 'unread')}`}</Text>
        )}
      </View>
      {rows === null && failed ? (
        <View style={styles.center}>
          <Text style={styles.empty}>{t('notifications.error_loading', 'Failed to load emails')}</Text>
        </View>
      ) : rows === null ? (
        <View style={styles.center}><ActivityIndicator color={c.primary} /></View>
      ) : rows.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>{t('email_list.no_emails_in', `No emails in ${inbox}`, { folder: inbox })}</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(e) => `${e.jmapAccountId}:${e.id}`}
          renderItem={({ item }) => {
            const isUnread = !item.keywords?.$seen;
            const preview = item.preview ? singleLine(cleanPreview(item.preview)) : '';
            return (
              <Pressable
                onPress={() => open(item)}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                accessibilityRole="button"
              >
                <View style={[styles.dot, isUnread && styles.dotUnread]} />
                <View style={styles.rowText}>
                  <View style={styles.rowTop}>
                    <Text style={[styles.sender, isUnread && styles.bold]} numberOfLines={1}>
                      {listAddressLabel(item.from?.[0], formatAddress, t('email_viewer.unknown_sender', 'Unknown'))}
                    </Text>
                    <Text style={styles.time}>{formatListDate(item.receivedAt, { dateFormat, timeFormat, locale, t })}</Text>
                  </View>
                  <Text style={[styles.subject, isUnread && styles.bold]} numberOfLines={1}>
                    {singleLine(item.subject) || t('email_viewer.no_subject', '(No Subject)')}
                  </Text>
                  {preview ? <Text style={styles.preview} numberOfLines={1}>{preview}</Text> : null}
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    root: { ...StyleSheet.absoluteFillObject, backgroundColor: c.background, zIndex: 10 },
    header: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.md, paddingBottom: spacing.sm },
    title: { fontSize: 26, fontWeight: '700', color: c.text },
    account: { fontSize: 15, color: c.textSecondary, flexShrink: 1 },
    spacer: { flex: 1 },
    count: { fontSize: 17, fontWeight: '600', color: c.primary, fontVariant: ['tabular-nums'] },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    empty: { fontSize: 18, color: c.textSecondary },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: spacing.md,
      paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, borderRadius: radius.md,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border,
    },
    rowPressed: { backgroundColor: c.secondary },
    dot: { width: 10, height: 10, borderRadius: 5 },
    dotUnread: { backgroundColor: c.primary },
    rowText: { flex: 1, minWidth: 0 },
    rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.md },
    sender: { flex: 1, fontSize: 20, color: c.text },
    time: { fontSize: 15, color: c.textSecondary, fontVariant: ['tabular-nums'] },
    subject: { fontSize: 18, color: c.text },
    preview: { fontSize: 15, color: c.textSecondary },
    bold: { fontWeight: '700' },
  });
}
