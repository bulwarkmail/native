import React from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { CalendarPlus, CircleCheck, Plus } from 'lucide-react-native';
import { componentSizes, radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useAnimDuration } from '../../theme/dynamic';
import { useLocaleStore } from '../../stores/locale-store';

interface CalendarFabProps {
  onNewEvent: () => void;
  /** With tasks turned on, the button first offers "Event" and "Task". */
  onNewTask?: () => void;
}

/**
 * The floating create button in the corner of the calendar, styled like the
 * mail list's compose button. Without tasks it creates an event at once;
 * with tasks it opens a small menu over a scrim.
 */
export function CalendarFab({ onNewEvent, onNewTask }: CalendarFabProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [open, setOpen] = React.useState(false);
  const progress = React.useRef(new Animated.Value(0)).current;
  const duration = useAnimDuration(160);

  React.useEffect(() => {
    Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [open, progress, duration]);

  const pick = (action: () => void) => {
    setOpen(false);
    action();
  };

  const onMainPress = () => {
    if (!onNewTask) {
      onNewEvent();
      return;
    }
    if (open) pick(onNewEvent);
    else setOpen(true);
  };

  const rotate = progress.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '90deg'] });
  const lift = progress.interpolate({ inputRange: [0, 1], outputRange: [12, 0] });

  return (
    <>
      {open && (
        <Animated.View style={[styles.scrim, { opacity: progress }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setOpen(false)}
            accessibilityRole="button"
            accessibilityLabel={t('common.close', 'Close')}
          />
        </Animated.View>
      )}
      <View style={styles.anchor} pointerEvents="box-none">
        {open && onNewTask && (
          <Animated.View style={[styles.option, { opacity: progress, transform: [{ translateY: lift }] }]}>
            <Text style={styles.optionLabel}>{t('calendar.fab.task', 'Task')}</Text>
            <Pressable
              style={styles.miniFab}
              onPress={() => pick(onNewTask)}
              accessibilityRole="button"
              accessibilityLabel={t('calendar.events.new_task', 'New task')}
            >
              <CircleCheck size={20} color={c.text} />
            </Pressable>
          </Animated.View>
        )}
        <View style={styles.mainRow}>
          {open && (
            <Animated.Text style={[styles.optionLabel, { opacity: progress }]}>
              {t('calendar.fab.event', 'Event')}
            </Animated.Text>
          )}
          <Pressable
            style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
            onPress={onMainPress}
            accessibilityRole="button"
            accessibilityLabel={t('calendar.events.new_event', 'New event')}
          >
            {open ? (
              <CalendarPlus size={24} color={c.background} />
            ) : (
              <Animated.View style={{ transform: [{ rotate }] }}>
                <Plus size={26} color={c.background} />
              </Animated.View>
            )}
          </Pressable>
        </View>
      </View>
    </>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    scrim: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.55)',
      zIndex: 20,
    },
    anchor: {
      position: 'absolute',
      right: spacing.lg,
      bottom: spacing.lg,
      alignItems: 'flex-end',
      gap: spacing.lg,
      zIndex: 21,
    },
    option: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginRight: 8 },
    mainRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    optionLabel: { ...typography.baseMedium, color: '#ffffff' },
    miniFab: {
      width: 40,
      height: 40,
      borderRadius: radius.full,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
      elevation: 3,
      shadowColor: '#000',
      shadowOpacity: 0.2,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 2 },
    },
    // Same as the compose button on the mail list (EmailListScreen).
    fab: {
      width: componentSizes.fab,
      height: componentSizes.fab,
      borderRadius: radius.full,
      backgroundColor: c.text,
      alignItems: 'center',
      justifyContent: 'center',
      elevation: 6,
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 3 },
    },
    fabPressed: { opacity: 0.85 },
  });
}
