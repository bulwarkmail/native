import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import {
  addDays,
  endOfMonth,
  endOfWeek,
  format,
  getWeek,
  isSameDay,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import type { Calendar, CalendarEvent } from '../../api/types';
import { componentSizes, radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import {
  buildEventDayIndex,
  eventsOnDayFromIndex,
  getEventColor,
  type EventDayIndex,
} from '../../lib/calendar-utils';

const SUN_FIRST = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MON_FIRST = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

interface MonthViewProps {
  currentDate: Date;
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  eventsByDay?: EventDayIndex;
  weekStartsOn?: 0 | 1;
  showWeekNumbers?: boolean;
  onSelectDate: (date: Date) => void;
  onLongPressDate?: (date: Date) => void;
}

function MonthViewInner({
  currentDate,
  selectedDate,
  events,
  calendars,
  eventsByDay,
  weekStartsOn = 0,
  showWeekNumbers = false,
  onSelectDate,
  onLongPressDate,
}: MonthViewProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const weekdayLabels = weekStartsOn === 1 ? MON_FIRST : SUN_FIRST;
  const index = React.useMemo(
    () => eventsByDay ?? buildEventDayIndex(events),
    [eventsByDay, events],
  );
  const days = React.useMemo(() => {
    const monthStart = startOfMonth(currentDate);
    const monthEnd = endOfMonth(currentDate);
    const calStart = startOfWeek(monthStart, { weekStartsOn });
    const calEnd = endOfWeek(monthEnd, { weekStartsOn });
    const result: Date[] = [];
    let day = calStart;
    while (day <= calEnd) {
      result.push(day);
      day = addDays(day, 1);
    }
    return result;
  }, [currentDate, weekStartsOn]);

  // Group days into rows of 7 so we can prepend a week-number column.
  const rows = React.useMemo(() => {
    const out: Date[][] = [];
    for (let i = 0; i < days.length; i += 7) out.push(days.slice(i, i + 7));
    return out;
  }, [days]);

  const renderDay = (d: Date, key: React.Key, flexLayout = false) => {
    const sameMonth = isSameMonth(d, currentDate);
    const today = isToday(d);
    const selected = isSameDay(d, selectedDate);
    const dayEvents = eventsOnDayFromIndex(index, d);
    const MAX_DOTS = dayEvents.length > 3 ? 2 : 3;
    const visibleDots = dayEvents.slice(0, MAX_DOTS);
    const overflow = Math.max(0, dayEvents.length - MAX_DOTS);

    return (
      <Pressable
        key={key}
        style={[styles.dayCell, flexLayout && styles.dayCellFlex]}
        onPress={() => onSelectDate(d)}
        onLongPress={onLongPressDate ? () => onLongPressDate(d) : undefined}
      >
        <View style={[
          styles.dayNumber,
          today && styles.todayCircle,
          selected && !today && styles.selectedCircle,
        ]}>
          <Text style={[
            styles.dayText,
            !sameMonth && styles.dayTextMuted,
            today && styles.todayText,
            selected && !today && styles.selectedText,
          ]}>
            {format(d, 'd')}
          </Text>
        </View>
        {dayEvents.length > 0 && (
          <View style={styles.dotsRow}>
            {visibleDots.map((event, idx) => (
              <View
                key={`${event.id}-${idx}`}
                style={[styles.dot, { backgroundColor: getEventColor(event, calendars) }]}
              />
            ))}
            {overflow > 0 && (
              <Text style={styles.overflowText}>+{overflow}</Text>
            )}
          </View>
        )}
      </Pressable>
    );
  };

  return (
    <View style={styles.grid}>
      <View style={styles.weekdayRow}>
        {showWeekNumbers && <Text style={styles.weekNumberLabel}>#</Text>}
        {weekdayLabels.map((wd, i) => (
          <Text key={i} style={styles.weekdayLabel}>{wd}</Text>
        ))}
      </View>
      {showWeekNumbers ? (
        rows.map((row, rowIdx) => (
          <View key={rowIdx} style={styles.weekRow}>
            <Text style={styles.weekNumberCell}>{getWeek(row[0], { weekStartsOn })}</Text>
            {row.map((d, i) => renderDay(d, `${rowIdx}-${i}`, true))}
          </View>
        ))
      ) : (
        <View style={styles.daysGrid}>
          {days.map((d, i) => renderDay(d, i))}
        </View>
      )}
    </View>
  );
}

export const MonthView = React.memo(MonthViewInner);

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  grid: { paddingHorizontal: spacing.sm },
  weekdayRow: { flexDirection: 'row', paddingHorizontal: spacing.xs, marginBottom: 4 },
  weekdayLabel: {
    flex: 1,
    textAlign: 'center',
    ...typography.small,
    color: c.textMuted,
  },
  daysGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  weekRow: { flexDirection: 'row', alignItems: 'center' },
  weekNumberLabel: {
    width: 24,
    textAlign: 'center',
    ...typography.small,
    color: c.textMuted,
  },
  weekNumberCell: {
    width: 24,
    textAlign: 'center',
    ...typography.caption,
    color: c.textMuted,
    paddingVertical: 4,
  },
  dayCell: { width: '14.28%', alignItems: 'center', paddingVertical: 4 },
  dayCellFlex: { width: undefined, flex: 1 },
  dayNumber: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayText: { ...typography.body, color: c.text },
  dayTextMuted: { color: c.textMuted },
  todayCircle: { backgroundColor: c.primary },
  todayText: { color: c.textInverse, fontWeight: '700' },
  selectedCircle: { backgroundColor: c.primaryBg, borderWidth: 1.5, borderColor: c.primary },
  selectedText: { color: c.primary, fontWeight: '600' },
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    marginTop: 2,
    height: componentSizes.eventDot + 2,
    width: '100%',
    paddingHorizontal: 2,
  },
  dot: {
    width: componentSizes.eventDot,
    height: componentSizes.eventDot,
    borderRadius: componentSizes.eventDot / 2,
  },
  overflowText: {
    color: c.textMuted,
    fontSize: 9,
    lineHeight: 10,
    marginLeft: 1,
  },
  });
}
