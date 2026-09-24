import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Modal, Animated, Easing, TextInput, ActivityIndicator,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Plus, RefreshCw, Trash2, Rss, AlertTriangle } from 'lucide-react-native';
import { formatDistanceToNow } from 'date-fns';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { CALENDAR_COLOR_PALETTE, calendarColorName } from '../../lib/calendar-utils';
import { useCalendarLocale } from '../../lib/calendar-locale';
import {
  DEFAULT_REFRESH_INTERVAL_MINUTES,
  selectAccountSubscriptions,
  useCalendarSubscriptionsStore,
  type CalendarSubscription,
} from '../../stores/calendar-subscriptions-store';
import { jmapClient } from '../../api/jmap-client';

// The webmail's refresh intervals and their labels.
const INTERVAL_OPTIONS: { minutes: number; key: string; fallback: string }[] = [
  { minutes: 15, key: 'calendar.subscription.interval_15', fallback: 'Every 15 minutes' },
  { minutes: 60, key: 'calendar.subscription.interval_60', fallback: 'Every hour' },
  { minutes: 360, key: 'calendar.subscription.interval_360', fallback: 'Every 6 hours' },
  { minutes: 1440, key: 'calendar.subscription.interval_1440', fallback: 'Every day' },
];

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function ICalSubscriptionSheet({ visible, onClose }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const { locale, t } = useCalendarLocale();
  const allSubscriptions = useCalendarSubscriptionsStore((s) => s.subscriptions);
  // Only the signed-in account's feeds: a sub created under another account
  // mirrors into a calendar id that doesn't exist (or collides) here.
  const subscriptions = React.useMemo(
    () => selectAccountSubscriptions(allSubscriptions, jmapClient.isConnected ? jmapClient.accountId : null),
    [allSubscriptions],
  );
  const syncing = useCalendarSubscriptionsStore((s) => s.syncing);
  const addSubscription = useCalendarSubscriptionsStore((s) => s.addSubscription);
  const updateSubscription = useCalendarSubscriptionsStore((s) => s.updateSubscription);
  const removeSubscription = useCalendarSubscriptionsStore((s) => s.removeSubscription);
  const syncSubscription = useCalendarSubscriptionsStore((s) => s.syncSubscription);

  const [name, setName] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [color, setColor] = React.useState<string>(CALENDAR_COLOR_PALETTE[0]);
  const [interval, setInterval] = React.useState<number>(DEFAULT_REFRESH_INTERVAL_MINUTES);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  const startEdit = (sub: CalendarSubscription) => {
    setEditingId(sub.id);
    setName(sub.name);
    setUrl(sub.url);
    setColor(sub.color || CALENDAR_COLOR_PALETTE[0]);
    setInterval(sub.refreshIntervalMinutes ?? DEFAULT_REFRESH_INTERVAL_MINUTES);
    setFormError(null);
  };
  const resetForm = () => {
    setEditingId(null);
    setName('');
    setUrl('');
    setColor(CALENDAR_COLOR_PALETTE[0]);
    setInterval(DEFAULT_REFRESH_INTERVAL_MINUTES);
    setFormError(null);
  };

  const slideY = React.useRef(new Animated.Value(900)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (visible) {
      setEditingId(null);
      setName('');
      setUrl('');
      setColor(CALENDAR_COLOR_PALETTE[0]);
      setInterval(DEFAULT_REFRESH_INTERVAL_MINUTES);
      setFormError(null);
      Animated.parallel([
        Animated.timing(slideY, { toValue: 0, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 1, duration: 240, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 900, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, slideY, overlayOpacity]);

  const handleSubmit = async () => {
    const n = name.trim();
    const u = url.trim();
    if (!n || !u) {
      setFormError(t('calendar.subscription.name_and_url_required', 'Enter a name and a feed URL.'));
      return;
    }
    if (!/^(https?|webcals?):\/\//i.test(u)) {
      setFormError(t('calendar.subscription.url_scheme_invalid', 'URL must start with https://, http://, webcal:// or webcals://'));
      return;
    }
    setFormError(null);
    setAdding(true);
    try {
      if (editingId) {
        await updateSubscription(editingId, { name: n, url: u, color, refreshIntervalMinutes: interval });
      } else {
        await addSubscription({ name: n, url: u, color, refreshIntervalMinutes: interval });
      }
      resetForm();
    } catch (e) {
      setFormError(
        e instanceof Error && e.message
          ? e.message
          : editingId
            ? t('calendar.subscription.update_error', 'Failed to update subscription')
            : t('calendar.subscription.error', 'Failed to add subscription'),
      );
    } finally {
      setAdding(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>
      <Animated.View style={[styles.sheet, { transform: [{ translateY: slideY }] }]}>
        <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
          <View style={styles.header}>
            <Rss size={20} color={c.text} />
            <Text style={styles.title}>{t('calendar.subscription.section_title', 'iCal Subscriptions')}</Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={styles.close}
              accessibilityRole="button"
              accessibilityLabel={t('common.close', 'Close')}
            >
              <X size={20} color={c.text} />
            </Pressable>
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll}>
            <Text style={styles.sectionLabel}>
              {editingId
                ? t('calendar.subscription.edit_title', 'Edit Subscription')
                : t('calendar.subscription.add_feed', 'Add a feed')}
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={t('calendar.subscription.name_placeholder', 'e.g. Public Holidays')}
              placeholderTextColor={c.textMuted}
              style={styles.input}
              accessibilityLabel={t('calendar.subscription.name_label', 'Calendar name')}
            />
            <TextInput
              value={url}
              onChangeText={setUrl}
              placeholder={t('calendar.subscription.url_placeholder', 'https://example.com/calendar.ics or webcal://...')}
              placeholderTextColor={c.textMuted}
              accessibilityLabel={t('calendar.subscription.url_label', 'Calendar URL')}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={styles.input}
            />
            <View style={styles.colorRow}>
              {CALENDAR_COLOR_PALETTE.map((col) => (
                <Pressable
                  key={col}
                  onPress={() => setColor(col)}
                  style={[
                    styles.colorDot,
                    { backgroundColor: col },
                    color === col && styles.colorDotActive,
                  ]}
                  accessibilityRole="radio"
                  accessibilityLabel={calendarColorName(col, t)}
                  accessibilityState={{ selected: color === col }}
                />
              ))}
            </View>
            <Text style={styles.fieldLabel}>{t('calendar.subscription.refresh_interval', 'Refresh interval')}</Text>
            <View style={styles.intervalRow}>
              {INTERVAL_OPTIONS.map((opt) => {
                const active = interval === opt.minutes;
                return (
                  <Pressable
                    key={opt.minutes}
                    onPress={() => setInterval(opt.minutes)}
                    style={[styles.intervalChip, active && styles.intervalChipActive]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={[styles.intervalChipText, active && styles.intervalChipTextActive]}>
                      {t(opt.key, opt.fallback)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {!!formError && (
              <View style={styles.errorBox}>
                <AlertTriangle size={16} color={c.error} />
                <Text style={styles.errorText}>{formError}</Text>
              </View>
            )}
            <View style={styles.formActions}>
              {editingId && (
                <Button variant="outline" onPress={resetForm} disabled={adding}>
                  {t('common.cancel', 'Cancel')}
                </Button>
              )}
              <Button
                onPress={() => { void handleSubmit(); }}
                disabled={adding}
                icon={adding ? <ActivityIndicator size="small" color={c.primaryForeground} /> : <Plus size={16} color={c.primaryForeground} />}
              >
                {adding
                  ? (editingId
                    ? t('calendar.subscription.saving', 'Saving...')
                    : t('calendar.subscription.subscribing', 'Subscribing...'))
                  : editingId
                    ? t('calendar.subscription.save', 'Save changes')
                    : t('calendar.subscription.subscribe', 'Subscribe')}
              </Button>
            </View>

            {subscriptions.length > 0 && (
              <>
                <Text style={[styles.sectionLabel, { marginTop: spacing.xl }]}>
                  {t('calendar.subscription.your_subscriptions', 'Your subscriptions')}
                </Text>
                {subscriptions.map((sub) => {
                  const busy = !!syncing[sub.id];
                  return (
                    <View key={sub.id} style={styles.subRow}>
                      <View style={[styles.subSwatch, { backgroundColor: sub.color || c.primary }]} />
                      <Pressable style={{ flex: 1, minWidth: 0 }} onPress={() => startEdit(sub)}>
                        <Text style={styles.subName} numberOfLines={1}>{sub.name}</Text>
                        <Text style={styles.subMeta} numberOfLines={1}>
                          {sub.lastError
                            ? sub.lastError
                            : sub.lastSyncAt
                              ? t('calendar.subscription.last_refreshed', 'Last updated: {time}', {
                                time: formatDistanceToNow(sub.lastSyncAt, { addSuffix: true, locale }),
                              })
                              : t('calendar.subscription.not_synced', 'Not synced yet')}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => { void syncSubscription(sub.id); }}
                        hitSlop={6}
                        style={styles.subBtn}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={t('calendar.subscription.refresh', 'Refresh now')}
                      >
                        {busy ? (
                          <ActivityIndicator size="small" color={c.textMuted} />
                        ) : (
                          <RefreshCw size={16} color={c.textSecondary} />
                        )}
                      </Pressable>
                      <Pressable
                        onPress={() => { void removeSubscription(sub.id); }}
                        hitSlop={6}
                        style={styles.subBtn}
                        accessibilityRole="button"
                        accessibilityLabel={t('calendar.subscription.unsubscribe', 'Unsubscribe')}
                      >
                        <Trash2 size={16} color={c.error} />
                      </Pressable>
                    </View>
                  );
                })}
              </>
            )}
          </ScrollView>
          <View style={{ height: insets.bottom }} />
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      maxHeight: '88%',
      backgroundColor: c.popover,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      borderTopWidth: 1,
      borderColor: c.border,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    title: { flex: 1, ...typography.h3, color: c.text },
    close: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
    scroll: { padding: spacing.lg, gap: spacing.sm },
    sectionLabel: { ...typography.bodySemibold, color: c.text, marginBottom: spacing.xs },
    input: {
      ...typography.body,
      color: c.text,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      backgroundColor: c.surface,
      marginBottom: spacing.sm,
    },
    colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
    fieldLabel: { ...typography.caption, color: c.textSecondary, marginBottom: spacing.xs },
    intervalRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
    intervalChip: {
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    intervalChipActive: { backgroundColor: c.primary, borderColor: c.primary },
    intervalChipText: { ...typography.caption, color: c.text },
    intervalChipTextActive: { color: c.primaryForeground },
    formActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
    colorDot: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: 'transparent' },
    colorDotActive: { borderColor: c.text },
    errorBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.sm,
      backgroundColor: c.errorBg,
      borderWidth: 1,
      borderColor: c.errorBorder,
      marginBottom: spacing.sm,
    },
    errorText: { ...typography.caption, color: c.errorForeground, flex: 1 },
    subRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    subSwatch: { width: 14, height: 14, borderRadius: 7 },
    subName: { ...typography.body, color: c.text },
    subMeta: { ...typography.caption, color: c.textMuted, marginTop: 1 },
    subBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  });
}
