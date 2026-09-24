import React from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Check, X, Upload, Rss, Shuffle, Star, Plus, Pencil, Share2, Eraser, Trash2,
} from 'lucide-react-native';
import type { Calendar } from '../../api/types';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useAnimDuration } from '../../theme/dynamic';
import { CALENDAR_COLOR_PALETTE, calendarColorName, getCalendarColor } from '../../lib/calendar-utils';
import { BIRTHDAY_CALENDAR_ID } from '../../lib/birthday-calendar';
import { isWritableCalendar } from '../../lib/calendar-editability';
import { useLocaleStore } from '../../stores/locale-store';

interface CalendarSidebarDrawerProps {
  visible: boolean;
  calendars: Calendar[];
  hiddenCalendarIds: string[];
  onToggle: (id: string) => void;
  onClose: () => void;
  onImport?: () => void;
  onManageSubscriptions?: () => void;
  onCreate?: () => void;
  // Long-press actions. Set-default / rename / share / clear / delete apply
  // to the user's own calendars; color change applies to own calendars
  // (server-side) and shared calendars (per-viewer recolor).
  onSetDefault?: (calendar: Calendar) => void;
  onSetColor?: (calendar: Calendar, color: string) => void;
  onResetColor?: (calendar: Calendar) => void;
  onRename?: (calendar: Calendar) => void;
  onShare?: (calendar: Calendar) => void;
  onClear?: (calendar: Calendar) => void;
  onDelete?: (calendar: Calendar) => void;
  // Client-side iCal subscriptions are managed from the subscriptions sheet.
  isSubscriptionCalendar?: (calendarId: string) => boolean;
}

export function CalendarSidebarDrawer({
  visible,
  calendars,
  hiddenCalendarIds,
  onToggle,
  onClose,
  onImport,
  onManageSubscriptions,
  onCreate,
  onSetDefault,
  onSetColor,
  onResetColor,
  onRename,
  onShare,
  onClear,
  onDelete,
  isSubscriptionCalendar,
}: CalendarSidebarDrawerProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const slideX = React.useRef(new Animated.Value(-Dimensions.get('window').width)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const openDuration = useAnimDuration(240);
  const closeDuration = useAnimDuration(200);
  const t = useLocaleStore((s) => s.t);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  // Also kicked from the Modal's onShow — the first open fires this effect
  // before the modal's native view exists, so that animation is dropped and
  // the drawer stays parked off-screen until the second open.
  const runOpen = React.useCallback(() => {
    Animated.parallel([
      Animated.timing(slideX, {
        toValue: 0,
        duration: openDuration,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(overlayOpacity, {
        toValue: 1,
        duration: openDuration,
        useNativeDriver: true,
      }),
    ]).start();
  }, [slideX, overlayOpacity, openDuration]);

  React.useEffect(() => {
    if (visible) {
      runOpen();
    } else {
      setExpandedId(null);
      Animated.parallel([
        Animated.timing(slideX, {
          toValue: -Dimensions.get('window').width,
          duration: closeDuration,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(overlayOpacity, {
          toValue: 0,
          duration: closeDuration,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, runOpen, slideX, overlayOpacity, closeDuration]);

  const hiddenSet = React.useMemo(() => new Set(hiddenCalendarIds), [hiddenCalendarIds]);

  const sharedCalendars = calendars.filter((cal) => cal.isShared);
  const myCalendars = calendars.filter((cal) => !cal.isShared && isWritableCalendar(cal));
  const subscribed = calendars.filter((cal) => !cal.isShared && !isWritableCalendar(cal));

  const sectionProps = {
    hiddenSet,
    onToggle,
    expandedId,
    onExpand: setExpandedId,
    onSetDefault,
    onSetColor,
    onResetColor,
    onRename,
    onShare,
    onClear,
    onDelete,
    isSubscriptionCalendar,
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
      onShow={runOpen}
    >
      <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
        <Pressable style={styles.overlayPress} onPress={onClose} />
      </Animated.View>

      <Animated.View
        style={[styles.drawer, { transform: [{ translateX: slideX }] }]}
      >
        <SafeAreaView style={styles.drawerSafe} edges={['top', 'bottom', 'left']}>
          <View style={styles.header}>
            <Pressable
              onPress={onClose}
              style={styles.headerClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('common.close', 'Close')}
            >
              <X size={20} color={c.text} />
            </Pressable>
            <Text style={styles.headerTitle}>{t('calendar.my_calendars', 'Calendars')}</Text>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            {calendars.length === 0 && (
              <Text style={styles.empty}>{t('calendar.drawer.no_calendars', 'No calendars yet.')}</Text>
            )}

            {myCalendars.length > 0 && (
              <Section title={t('calendar.drawer.my_calendars', 'My calendars')} calendars={myCalendars} {...sectionProps} />
            )}

            {sharedCalendars.length > 0 && (
              <Section title={t('calendar.drawer.shared_with_me', 'Shared with me')} calendars={sharedCalendars} {...sectionProps} />
            )}

            {subscribed.length > 0 && (
              <Section title={t('calendar.drawer.subscribed', 'Subscribed')} calendars={subscribed} {...sectionProps} />
            )}

            {(onImport || onManageSubscriptions || onCreate) && (
              <View style={styles.actionsSection}>
                {onCreate && (
                  <Pressable
                    onPress={onCreate}
                    style={({ pressed }) => [styles.actionRow, pressed && styles.rowPressed]}
                  >
                    <Plus size={18} color={c.textSecondary} />
                    <Text style={styles.actionText}>{t('calendar.management.new_calendar', 'New calendar')}</Text>
                  </Pressable>
                )}
                {onManageSubscriptions && (
                  <Pressable
                    onPress={onManageSubscriptions}
                    style={({ pressed }) => [styles.actionRow, pressed && styles.rowPressed]}
                  >
                    <Rss size={18} color={c.textSecondary} />
                    <Text style={styles.actionText}>{t('calendar.subscription.section_title', 'iCal Subscriptions')}</Text>
                  </Pressable>
                )}
                {onImport && (
                  <Pressable
                    onPress={onImport}
                    style={({ pressed }) => [styles.actionRow, pressed && styles.rowPressed]}
                  >
                    <Upload size={18} color={c.textSecondary} />
                    <Text style={styles.actionText}>{t('calendar.import.title', 'Import Calendar')}</Text>
                  </Pressable>
                )}
              </View>
            )}
          </ScrollView>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

function Section({
  title,
  calendars,
  hiddenSet,
  onToggle,
  expandedId,
  onExpand,
  onSetDefault,
  onSetColor,
  onResetColor,
  onRename,
  onShare,
  onClear,
  onDelete,
  isSubscriptionCalendar,
}: {
  title: string;
  calendars: Calendar[];
  hiddenSet: Set<string>;
  onToggle: (id: string) => void;
  expandedId: string | null;
  onExpand: (id: string | null) => void;
  onSetDefault?: (calendar: Calendar) => void;
  onSetColor?: (calendar: Calendar, color: string) => void;
  onResetColor?: (calendar: Calendar) => void;
  onRename?: (calendar: Calendar) => void;
  onShare?: (calendar: Calendar) => void;
  onClear?: (calendar: Calendar) => void;
  onDelete?: (calendar: Calendar) => void;
  isSubscriptionCalendar?: (calendarId: string) => boolean;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {calendars.map((cal) => {
        const visible = !hiddenSet.has(cal.id);
        const isBirthday = cal.id === BIRTHDAY_CALENDAR_ID;
        const isSubscription = !!isSubscriptionCalendar?.(cal.id);
        const isOwn = !cal.isShared && !isBirthday && !isSubscription;
        const canSetDefault = !!onSetDefault && isOwn && !cal.isDefault;
        // Own calendars recolour server-side; shared ones locally (#345).
        const canRecolor = !!onSetColor && (!!cal.isShared || isOwn);
        const canRename = !!onRename && isOwn;
        const canShare = !!onShare && isOwn && (!cal.myRights || cal.myRights.mayShare !== false);
        const canClear = !!onClear && isOwn && isWritableCalendar(cal);
        // Like webmail: the default calendar and shared calendars can't be deleted.
        const canDelete = !!onDelete && isOwn && !cal.isDefault && (!cal.myRights || cal.myRights.mayDelete !== false);
        const hasActions = canSetDefault || canRecolor || canRename || canShare || canClear || canDelete;
        const expanded = expandedId === cal.id && hasActions;
        return (
          <View key={cal.id}>
            <Pressable
              onPress={() => onToggle(cal.id)}
              onLongPress={hasActions ? () => onExpand(expanded ? null : cal.id) : undefined}
              style={({ pressed }) => [
                styles.row,
                pressed && styles.rowPressed,
              ]}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: visible }}
            >
              <View
                style={[
                  styles.swatch,
                  {
                    backgroundColor: visible ? getCalendarColor(cal) : 'transparent',
                    borderColor: getCalendarColor(cal),
                  },
                ]}
              >
                {visible && <Check size={12} color={c.textInverse} />}
              </View>
              <Text style={[styles.rowName, !visible && styles.rowNameMuted]} numberOfLines={1}>
                {cal.name}
              </Text>
              {cal.isDefault && !cal.isShared && (
                <Star size={14} color={c.textMuted} fill={c.textMuted} />
              )}
            </Pressable>

            {expanded && (
              <View style={styles.actionsPanel}>
                {canSetDefault && (
                  <Pressable
                    onPress={() => { onExpand(null); onSetDefault!(cal); }}
                    style={({ pressed }) => [styles.panelRow, pressed && styles.rowPressed]}
                  >
                    <Star size={16} color={c.textSecondary} />
                    <Text style={styles.panelRowText}>{t('calendar.management.set_default', 'Set as default')}</Text>
                  </Pressable>
                )}
                {canRename && (
                  <Pressable
                    onPress={() => { onExpand(null); onRename!(cal); }}
                    style={({ pressed }) => [styles.panelRow, pressed && styles.rowPressed]}
                  >
                    <Pencil size={16} color={c.textSecondary} />
                    <Text style={styles.panelRowText}>{t('calendar.management.edit', 'Edit')}</Text>
                  </Pressable>
                )}
                {canRecolor && (
                  <>
                    <View style={styles.paletteRow}>
                      {CALENDAR_COLOR_PALETTE.map((color) => {
                        const active = cal.color?.toLowerCase() === color.toLowerCase();
                        return (
                          <Pressable
                            key={color}
                            onPress={() => { onExpand(null); onSetColor!(cal, color); }}
                            style={[
                              styles.paletteSwatch,
                              { backgroundColor: color },
                              active && styles.paletteSwatchActive,
                            ]}
                            accessibilityRole="radio"
                            accessibilityLabel={calendarColorName(color, t)}
                            accessibilityState={{ selected: active }}
                          >
                            {active && <Check size={12} color={c.textInverse} />}
                          </Pressable>
                        );
                      })}
                    </View>
                    {!!onResetColor && cal.isShared && cal.colorIsLocalOverride && (
                      <Pressable
                        onPress={() => { onExpand(null); onResetColor(cal); }}
                        style={({ pressed }) => [styles.panelRow, pressed && styles.rowPressed]}
                      >
                        <Shuffle size={16} color={c.textSecondary} />
                        <Text style={styles.panelRowText}>{t('calendar.management.random_color', 'New random color')}</Text>
                      </Pressable>
                    )}
                  </>
                )}
                {canShare && (
                  <Pressable
                    onPress={() => { onExpand(null); onShare!(cal); }}
                    style={({ pressed }) => [styles.panelRow, pressed && styles.rowPressed]}
                  >
                    <Share2 size={16} color={c.textSecondary} />
                    <Text style={styles.panelRowText}>{t('calendar.management.share', 'Share calendar')}</Text>
                  </Pressable>
                )}
                {canClear && (
                  <Pressable
                    onPress={() => { onExpand(null); onClear!(cal); }}
                    style={({ pressed }) => [styles.panelRow, pressed && styles.rowPressed]}
                  >
                    <Eraser size={16} color={c.textSecondary} />
                    <Text style={styles.panelRowText}>{t('calendar.management.clear_events', 'Clear events')}</Text>
                  </Pressable>
                )}
                {canDelete && (
                  <Pressable
                    onPress={() => { onExpand(null); onDelete!(cal); }}
                    style={({ pressed }) => [styles.panelRow, pressed && styles.rowPressed]}
                  >
                    <Trash2 size={16} color={c.error} />
                    <Text style={[styles.panelRowText, { color: c.error }]}>{t('calendar.management.delete', 'Delete')}</Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  overlayPress: { flex: 1 },
  drawer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: '85%',
    maxWidth: 340,
    backgroundColor: c.secondary,
    borderRightWidth: 1,
    borderRightColor: c.border,
  },
  drawerSafe: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  headerClose: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  headerTitle: { ...typography.h3, color: c.text },

  scroll: { flex: 1 },
  scrollContent: { paddingBottom: spacing.lg },

  empty: {
    ...typography.body,
    color: c.textMuted,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },

  section: { paddingTop: spacing.md },
  sectionTitle: {
    ...typography.bodySemibold,
    color: c.text,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    minHeight: 44,
  },
  rowPressed: { backgroundColor: c.surfaceHover },
  swatch: {
    width: 18,
    height: 18,
    borderRadius: radius.xs,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowName: { flex: 1, ...typography.body, color: c.text },
  rowNameMuted: { color: c.textMuted },

  actionsPanel: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    backgroundColor: c.surface,
    overflow: 'hidden',
  },
  panelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 40,
  },
  panelRowText: { ...typography.body, color: c.text },
  paletteRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  paletteSwatch: {
    width: 24,
    height: 24,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  paletteSwatchActive: {
    borderWidth: 2,
    borderColor: c.text,
  },

  actionsSection: {
    marginTop: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    minHeight: 44,
  },
  actionText: { ...typography.body, color: c.text },
  });
}
