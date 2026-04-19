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
import { colors, radius, spacing, typography } from '../../theme/tokens';
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
  const slideX = React.useRef(new Animated.Value(-Dimensions.get('window').width)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(slideX, {
          toValue: 0,
          duration: 240,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(overlayOpacity, {
          toValue: 1,
          duration: 240,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideX, {
          toValue: -Dimensions.get('window').width,
          duration: 200,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(overlayOpacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, slideX, overlayOpacity]);

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
              <X size={20} color={colors.text} />
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
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {calendars.map((c) => {
        const visible = !hiddenSet.has(c.id);
        return (
          <Pressable
            key={c.id}
            onPress={() => onToggle(c.id)}
            style={({ pressed }) => [
              styles.row,
              pressed && styles.rowPressed,
            ]}
          >
            <View
              style={[
                styles.swatch,
                {
                  backgroundColor: visible ? getCalendarColor(c) : 'transparent',
                  borderColor: getCalendarColor(c),
                },
              ]}
            >
              {visible && <Check size={12} color={colors.textInverse} />}
            </View>
            <Text style={[styles.rowName, !visible && styles.rowNameMuted]}>
              {c.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
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
    borderRightColor: colors.border,
  },
  drawerSafe: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerClose: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  headerTitle: { ...typography.h3, color: colors.text },

  scroll: { flex: 1 },
  scrollContent: { paddingBottom: spacing.lg },

  empty: {
    ...typography.body,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },

  section: { paddingTop: spacing.md },
  sectionTitle: {
    ...typography.bodySemibold,
    color: colors.text,
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
  rowPressed: { backgroundColor: colors.surfaceHover },
  swatch: {
    width: 18,
    height: 18,
    borderRadius: radius.xs,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowName: { flex: 1, ...typography.body, color: colors.text },
  rowNameMuted: { color: colors.textMuted },
});
