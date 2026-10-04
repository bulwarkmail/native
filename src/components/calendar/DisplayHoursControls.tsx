import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { ChevronDown, ChevronUp, FoldVertical, UnfoldVertical } from 'lucide-react-native';
import { typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useCalendarLocale } from '../../lib/calendar-locale';
import { formatDisplayHour, type DisplayHours } from '../../lib/calendar-display-range';

/**
 * Marks a day column that has events above or below the visible hours
 * (webmail #1164); tapping it shows the whole day at the first of them.
 * Absolutely positioned: the column it sits in supplies the room.
 */
export function HiddenEventsIndicator({
  count,
  direction,
  onReveal,
}: {
  count: number;
  direction: 'before' | 'after';
  onReveal: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const { t } = useCalendarLocale();
  const label = direction === 'before'
    ? t('calendar.events.hidden_before', '{count, plural, one {# earlier event} other {# earlier events}}', { count })
    : t('calendar.events.hidden_after', '{count, plural, one {# later event} other {# later events}}', { count });
  const Icon = direction === 'before' ? ChevronUp : ChevronDown;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={onReveal}
      style={[styles.indicator, direction === 'before' ? styles.indicatorTop : styles.indicatorBottom]}
    >
      <Icon size={12} color={c.textMuted} />
      <Text style={styles.indicatorText}>{count}</Text>
    </Pressable>
  );
}

/** Switches a time grid between the configured hours and the whole day. */
export function AllHoursToggle({
  showAllHours,
  configured,
  timeFormat,
  onToggle,
}: {
  showAllHours: boolean;
  configured: DisplayHours;
  timeFormat: '12h' | '24h';
  onToggle: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const { t } = useCalendarLocale();
  const label = showAllHours
    ? t('calendar.events.show_display_hours', 'Show only {start} – {end}', {
        start: formatDisplayHour(configured.startMinutes / 60, timeFormat),
        end: formatDisplayHour(configured.endMinutes / 60, timeFormat),
      })
    : t('calendar.events.show_all_hours', 'Show all hours');
  const Icon = showAllHours ? FoldVertical : UnfoldVertical;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: showAllHours }}
      hitSlop={6}
      onPress={onToggle}
      style={styles.toggle}
    >
      <Icon size={16} color={c.textMuted} />
    </Pressable>
  );
}

/**
 * The "All day" label of a crowded strip, as a toggle: "+N" while it is
 * capped, a chevron once it is expanded.
 */
export function AllDayToggle({
  expanded,
  hiddenCount,
  onToggle,
}: {
  expanded: boolean;
  hiddenCount: number;
  onToggle: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const { t } = useCalendarLocale();
  const label = expanded
    ? t('calendar.events.show_less', 'Show less')
    : `${t('calendar.events.show_more', 'Show more')} (+${hiddenCount})`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded }}
      hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
      onPress={onToggle}
      style={styles.allDayToggle}
    >
      {expanded ? (
        <ChevronUp size={14} color={c.textMuted} />
      ) : (
        <>
          <Text style={styles.allDayToggleText}>+{hiddenCount}</Text>
          <ChevronDown size={14} color={c.textMuted} />
        </>
      )}
    </Pressable>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    indicator: {
      position: 'absolute',
      alignSelf: 'center',
      zIndex: 20,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      borderRadius: 10,
      paddingHorizontal: 6,
      paddingVertical: 2,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    indicatorTop: { top: 2 },
    indicatorBottom: { bottom: 2 },
    indicatorText: { ...typography.small, color: c.textMuted },
    toggle: { alignSelf: 'center', padding: 6 },
    allDayToggle: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end' },
    allDayToggleText: { ...typography.small, color: c.textMuted },
  });
}
