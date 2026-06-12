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
import { Check, X, Upload, Rss, Shuffle, Star } from 'lucide-react-native';
import type { Calendar } from '../../api/types';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useAnimDuration } from '../../theme/dynamic';
import { CALENDAR_COLOR_PALETTE, getCalendarColor } from '../../lib/calendar-utils';
import { BIRTHDAY_CALENDAR_ID } from '../../lib/birthday-calendar';

interface CalendarSidebarDrawerProps {
  visible: boolean;
  calendars: Calendar[];
  hiddenCalendarIds: string[];
  onToggle: (id: string) => void;
  onClose: () => void;
  onImport?: () => void;
  onManageSubscriptions?: () => void;
  // Long-press actions. Set-default applies to the user's own calendars;
  // color change/reset applies to shared calendars (per-viewer recolor).
  onSetDefault?: (calendar: Calendar) => void;
  onSetColor?: (calendar: Calendar, color: string) => void;
  onResetColor?: (calendar: Calendar) => void;
}

export function CalendarSidebarDrawer({
  visible,
  calendars,
  hiddenCalendarIds,
  onToggle,
  onClose,
  onImport,
  onManageSubscriptions,
  onSetDefault,
  onSetColor,
  onResetColor,
}: CalendarSidebarDrawerProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const slideX = React.useRef(new Animated.Value(-Dimensions.get('window').width)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const openDuration = useAnimDuration(240);
  const closeDuration = useAnimDuration(200);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (visible) {
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
  }, [visible, slideX, overlayOpacity, openDuration, closeDuration]);

  const hiddenSet = React.useMemo(() => new Set(hiddenCalendarIds), [hiddenCalendarIds]);

  const sharedCalendars = calendars.filter((cal) => cal.isShared);
  const myCalendars = calendars.filter(
    (cal) => !cal.isShared && (!cal.myRights || cal.myRights.mayWrite !== false),
  );
  const subscribed = calendars.filter(
    (cal) => !cal.isShared && cal.myRights && cal.myRights.mayWrite === false,
  );

  const sectionProps = {
    hiddenSet,
    onToggle,
    expandedId,
    onExpand: setExpandedId,
    onSetDefault,
    onSetColor,
    onResetColor,
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
        <Pressable style={styles.overlayPress} onPress={onClose} />
      </Animated.View>

      <Animated.View
        style={[styles.drawer, { transform: [{ translateX: slideX }] }]}
      >
        <SafeAreaView style={styles.drawerSafe} edges={['top', 'bottom', 'left']}>
          <View style={styles.header}>
            <Pressable onPress={onClose} style={styles.headerClose} hitSlop={8}>
              <X size={20} color={c.text} />
            </Pressable>
            <Text style={styles.headerTitle}>Calendars</Text>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            {calendars.length === 0 && (
              <Text style={styles.empty}>No calendars yet.</Text>
            )}

            {myCalendars.length > 0 && (
              <Section title="My calendars" calendars={myCalendars} {...sectionProps} />
            )}

            {sharedCalendars.length > 0 && (
              <Section title="Shared with me" calendars={sharedCalendars} {...sectionProps} />
            )}

            {subscribed.length > 0 && (
              <Section title="Subscribed" calendars={subscribed} {...sectionProps} />
            )}

            {(onImport || onManageSubscriptions) && (
              <View style={styles.actionsSection}>
                {onManageSubscriptions && (
                  <Pressable
                    onPress={onManageSubscriptions}
                    style={({ pressed }) => [styles.actionRow, pressed && styles.rowPressed]}
                  >
                    <Rss size={18} color={c.textSecondary} />
                    <Text style={styles.actionText}>Subscriptions</Text>
                  </Pressable>
                )}
                {onImport && (
                  <Pressable
                    onPress={onImport}
                    style={({ pressed }) => [styles.actionRow, pressed && styles.rowPressed]}
                  >
                    <Upload size={18} color={c.textSecondary} />
                    <Text style={styles.actionText}>Import from file</Text>
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
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {calendars.map((cal) => {
        const visible = !hiddenSet.has(cal.id);
        const isBirthday = cal.id === BIRTHDAY_CALENDAR_ID;
        const canSetDefault = !!onSetDefault && !cal.isShared && !isBirthday && !cal.isDefault;
        const canRecolor = !!onSetColor && !!cal.isShared;
        const hasActions = canSetDefault || canRecolor;
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
                    <Text style={styles.panelRowText}>Set as default calendar</Text>
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
                          >
                            {active && <Check size={12} color={c.textInverse} />}
                          </Pressable>
                        );
                      })}
                    </View>
                    {!!onResetColor && cal.colorIsLocalOverride && (
                      <Pressable
                        onPress={() => { onExpand(null); onResetColor(cal); }}
                        style={({ pressed }) => [styles.panelRow, pressed && styles.rowPressed]}
                      >
                        <Shuffle size={16} color={c.textSecondary} />
                        <Text style={styles.panelRowText}>Random color</Text>
                      </Pressable>
                    )}
                  </>
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
