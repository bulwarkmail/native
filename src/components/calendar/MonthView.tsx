import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import {
  addDays,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import type { Calendar, CalendarEvent } from '../../api/types';
import { colors, componentSizes, radius, spacing, typography } from '../../theme/tokens';
import {
  buildEventDayIndex,
  eventsOnDayFromIndex,
  getEventColor,
  type EventDayIndex,
} from '../../lib/calendar-utils';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

interface MonthViewProps {
  currentDate: Date;
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  eventsByDay?: EventDayIndex;
  onSelectDate: (date: Date) => void;
  onLongPressDate?: (date: Date) => void;
}

function MonthViewInner({
  currentDate,
  selectedDate,
  events,
  calendars,
  eventsByDay,
  onSelectDate,
  onLongPressDate,
}: MonthViewProps) {
  const index = React.useMemo(
    () => eventsByDay ?? buildEventDayIndex(events),
    [eventsByDay, events],
  );
  const days = React.useMemo(() => {
    const monthStart = startOfMonth(currentDate);
    const monthEnd = endOfMonth(currentDate);
    const calStart = startOfWeek(monthStart);
    const calEnd = endOfWeek(monthEnd);
    const result: Date[] = [];
    let day = calStart;
    while (day <= calEnd) {
      result.push(day);
      day = addDays(day, 1);
    }
    return result;
  }, [currentDate]);

  return (
    <View style={styles.grid}>
      <View style={styles.weekdayRow}>
        {WEEKDAYS.map((wd, i) => (
          <Text key={i} style={styles.weekdayLabel}>{wd}</Text>
        ))}
      </View>
      <View style={styles.daysGrid}>
        {days.map((d, i) => {
          const sameMonth = isSameMonth(d, currentDate);
          const today = isToday(d);
          const selected = isSameDay(d, selectedDate);
          const dayEvents = eventsOnDayFromIndex(index, d);
          const MAX_DOTS = dayEvents.length > 3 ? 2 : 3;
          const visibleDots = dayEvents.slice(0, MAX_DOTS);
          const overflow = Math.max(0, dayEvents.length - MAX_DOTS);

          return (
            <Pressable
              key={i}
              style={styles.dayCell}
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
        })}
      </View>
    </View>
  );
}

export const MonthView = React.memo(MonthViewInner);

const styles = StyleSheet.create({
  grid: { paddingHorizontal: spacing.sm },
  weekdayRow: { flexDirection: 'row', paddingHorizontal: spacing.xs, marginBottom: 4 },
  weekdayLabel: {
    flex: 1,
    textAlign: 'center',
    ...typography.small,
    color: colors.textMuted,
  },
  daysGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: { width: '14.28%', alignItems: 'center', paddingVertical: 4 },
  dayNumber: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayText: { ...typography.body, color: colors.text },
  dayTextMuted: { color: colors.textMuted },
  todayCircle: { backgroundColor: colors.primary },
  todayText: { color: colors.textInverse, fontWeight: '700' },
  selectedCircle: { backgroundColor: colors.primaryBg, borderWidth: 1.5, borderColor: colors.primary },
  selectedText: { color: colors.primary, fontWeight: '600' },
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
    color: colors.textMuted,
    fontSize: 9,
    lineHeight: 10,
    marginLeft: 1,
  },
});
