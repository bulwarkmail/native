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
import { Check, X } from 'lucide-react-native';
import type { Calendar } from '../../api/types';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useAnimDuration } from '../../theme/dynamic';
import { getCalendarColor } from '../../lib/calendar-utils';

interface CalendarSidebarDrawerProps {
  visible: boolean;
  calendars: Calendar[];
  hiddenCalendarIds: string[];
  onToggle: (id: string) => void;
  onClose: () => void;
}

export function CalendarSidebarDrawer({
  visible,
  calendars,
  hiddenCalendarIds,
  onToggle,
  onClose,
}: CalendarSidebarDrawerProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const slideX = React.useRef(new Animated.Value(-Dimensions.get('window').width)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const openDuration = useAnimDuration(240);
  const closeDuration = useAnimDuration(200);

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

  const myCalendars = calendars.filter((c) => !c.myRights || c.myRights.mayWrite !== false);
  const subscribed = calendars.filter((c) => c.myRights && c.myRights.mayWrite === false);

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
              <Section
                title="My calendars"
                calendars={myCalendars}
                hiddenSet={hiddenSet}
                onToggle={onToggle}
              />
            )}

            {subscribed.length > 0 && (
              <Section
                title="Subscribed"
                calendars={subscribed}
                hiddenSet={hiddenSet}
                onToggle={onToggle}
              />
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
}: {
  title: string;
  calendars: Calendar[];
  hiddenSet: Set<string>;
  onToggle: (id: string) => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {calendars.map((cal) => {
        const visible = !hiddenSet.has(cal.id);
        return (
          <Pressable
            key={cal.id}
            onPress={() => onToggle(cal.id)}
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
            <Text style={[styles.rowName, !visible && styles.rowNameMuted]}>
              {cal.name}
            </Text>
          </Pressable>
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
    backgroundColor: '#262626',
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
  });
}
