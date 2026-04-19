import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
} from 'react-native';
import { addDays, format, isSameDay, isToday, startOfWeek } from 'date-fns';
import type { Calendar, CalendarEvent } from '../../api/types';
import { colors, radius, spacing, typography } from '../../theme/tokens';
import {
  buildEventDayIndex,
  eventsOnDayFromIndex,
  getEventColor,
  layoutOverlappingEvents,
  type EventDayIndex,
} from '../../lib/calendar-utils';

const HOUR_HEIGHT = 48;
const GUTTER_WIDTH = 44;
const ALL_DAY_CHIP_HEIGHT = 18;
const ALL_DAY_GAP = 2;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

interface WeekViewProps {
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  eventsByDay?: EventDayIndex;
  onSelectDate?: (date: Date) => void;
  onSelectEvent?: (event: CalendarEvent) => void;
  onCreateAtTime?: (date: Date) => void;
  weekStartsOn?: 0 | 1;
}

export function WeekView({
  selectedDate,
  events,
  calendars,
  eventsByDay,
  onSelectDate,
  onSelectEvent,
  onCreateAtTime,
  weekStartsOn = 0,
}: WeekViewProps) {
  const scrollRef = React.useRef<ScrollView>(null);

  const index = React.useMemo(
    () => eventsByDay ?? buildEventDayIndex(events),
    [eventsByDay, events],
  );

  const weekDays = React.useMemo(() => {
    const start = startOfWeek(selectedDate, { weekStartsOn });
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [selectedDate, weekStartsOn]);

  const allDayByDay = React.useMemo(() => {
    return weekDays.map((day) =>
      eventsOnDayFromIndex(index, day).filter((e) => e.showWithoutTime),
    );
  }, [weekDays, index]);

  const allDayRowCount = React.useMemo(() => {
    return allDayByDay.reduce((max, list) => Math.max(max, list.length), 0);
  }, [allDayByDay]);

  const allDayStripHeight =
    allDayRowCount > 0
      ? allDayRowCount * (ALL_DAY_CHIP_HEIGHT + ALL_DAY_GAP) + spacing.xs
      : 0;

  const layoutsByDay = React.useMemo(() => {
    return weekDays.map((day) =>
      layoutOverlappingEvents(eventsOnDayFromIndex(index, day), day),
    );
  }, [weekDays, index]);

  const [nowMinutes, setNowMinutes] = React.useState(() => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  });

  React.useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      setNowMinutes(now.getHours() * 60 + now.getMinutes());
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  React.useEffect(() => {
    const target = Math.max(0, (new Date().getHours() - 1) * HOUR_HEIGHT);
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y: target, animated: false });
    });
  }, []);

  const handleSlotLongPress = (day: Date, hour: number) => {
    if (!onCreateAtTime) return;
    const date = new Date(day);
    date.setHours(hour, 0, 0, 0);
    onCreateAtTime(date);
  };

  const dayHeader = (day: Date) => {
    const today = isToday(day);
    const selected = isSameDay(day, selectedDate);
    return (
      <Pressable
        key={day.toISOString()}
        style={styles.dayHeaderCell}
        onPress={() => onSelectDate?.(day)}
      >
        <Text style={styles.dayHeaderWeekday}>{format(day, 'EEE')}</Text>
        <View
          style={[
            styles.dayHeaderNumber,
            today && styles.dayHeaderNumberToday,
            selected && !today && styles.dayHeaderNumberSelected,
          ]}
        >
          <Text
            style={[
              styles.dayHeaderNumberText,
              today && styles.dayHeaderNumberTextToday,
              selected && !today && styles.dayHeaderNumberTextSelected,
            ]}
          >
            {format(day, 'd')}
          </Text>
        </View>
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.gutter} />
        <View style={styles.dayHeaders}>{weekDays.map(dayHeader)}</View>
      </View>

      {allDayRowCount > 0 && (
        <View style={[styles.allDayStrip, { height: allDayStripHeight }]}>
          <View style={[styles.gutter, styles.allDayLabelWrap]}>
            <Text style={styles.allDayLabel}>all-day</Text>
          </View>
          <View style={styles.allDayGrid}>
            {allDayByDay.map((dayEvents, idx) => (
              <View key={idx} style={styles.allDayCol}>
                {dayEvents.map((event) => (
                  <Pressable
                    key={event.id}
                    style={[
                      styles.allDayChip,
                      { backgroundColor: getEventColor(event, calendars) + '33' },
                      { borderLeftColor: getEventColor(event, calendars) },
                    ]}
                    onPress={() => onSelectEvent?.(event)}
                  >
                    <Text style={styles.allDayChipText} numberOfLines={1}>
                      {event.title || 'Untitled'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ))}
          </View>
        </View>
      )}

      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.grid, { height: 24 * HOUR_HEIGHT }]}>
          <View style={styles.gutterCol}>
            {HOURS.map((h) => (
              <View key={h} style={[styles.hourLabelCell, { height: HOUR_HEIGHT }]}>
                {h > 0 && (
                  <Text style={styles.hourLabel}>
                    {h.toString().padStart(2, '0')}:00
                  </Text>
                )}
              </View>
            ))}
          </View>

          <View style={styles.dayCols}>
            {weekDays.map((day, dayIndex) => {
              const layouted = layoutsByDay[dayIndex];
              const todayCol = isToday(day);
              return (
                <View key={day.toISOString()} style={styles.dayCol}>
                  {HOURS.map((h) => (
                    <Pressable
                      key={h}
                      onLongPress={() => handleSlotLongPress(day, h)}
                      style={[styles.hourSlot, { height: HOUR_HEIGHT }]}
                    />
                  ))}

                  {layouted.map(
                    ({ event, column, totalColumns, startMinutes, endMinutes }) => {
                      const top = (startMinutes / 60) * HOUR_HEIGHT;
                      const height = Math.max(
                        20,
                        ((endMinutes - startMinutes) / 60) * HOUR_HEIGHT - 1,
                      );
                      const widthPct = 100 / totalColumns;
                      const leftPct = column * widthPct;
                      const color = getEventColor(event, calendars);
                      return (
                        <Pressable
                          key={event.id}
                          onPress={() => onSelectEvent?.(event)}
                          style={[
                            styles.eventBlock,
                            {
                              top,
                              height,
                              left: `${leftPct}%`,
                              width: `${widthPct}%`,
                              backgroundColor: color + '33',
                              borderLeftColor: color,
                            },
                          ]}
                        >
                          <Text style={styles.eventBlockTitle} numberOfLines={1}>
                            {event.title || 'Untitled'}
                          </Text>
                          {height > 32 && (
                            <Text style={styles.eventBlockTime} numberOfLines={1}>
                              {minutesToTimeLabel(startMinutes)}
                            </Text>
                          )}
                        </Pressable>
                      );
                    },
                  )}

                  {todayCol && (
                    <View
                      pointerEvents="none"
                      style={[
                        styles.nowLine,
                        { top: (nowMinutes / 60) * HOUR_HEIGHT },
                      ]}
                    >
                      <View style={styles.nowDot} />
                      <View style={styles.nowBar} />
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function minutesToTimeLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  headerRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  gutter: { width: GUTTER_WIDTH },
  dayHeaders: { flex: 1, flexDirection: 'row' },
  dayHeaderCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    gap: 4,
  },
  dayHeaderWeekday: {
    ...typography.small,
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  dayHeaderNumber: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayHeaderNumberToday: { backgroundColor: colors.primary },
  dayHeaderNumberSelected: {
    backgroundColor: colors.primaryBg,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  dayHeaderNumberText: { ...typography.bodyMedium, color: colors.text },
  dayHeaderNumberTextToday: { color: colors.textInverse, fontWeight: '700' },
  dayHeaderNumberTextSelected: { color: colors.primary, fontWeight: '600' },

  allDayStrip: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: 2,
  },
  allDayLabelWrap: { alignItems: 'flex-end', justifyContent: 'flex-start', paddingRight: 4 },
  allDayLabel: { ...typography.small, color: colors.textMuted },
  allDayGrid: { flex: 1, flexDirection: 'row' },
  allDayCol: {
    flex: 1,
    paddingHorizontal: 1,
    gap: ALL_DAY_GAP,
  },
  allDayChip: {
    height: ALL_DAY_CHIP_HEIGHT,
    borderRadius: radius.xs,
    borderLeftWidth: 2,
    paddingHorizontal: 4,
    justifyContent: 'center',
  },
  allDayChipText: { fontSize: 10, color: colors.text, fontWeight: '500' },

  scroll: { flex: 1 },
  scrollContent: {},
  grid: { flexDirection: 'row' },
  gutterCol: { width: GUTTER_WIDTH },
  hourLabelCell: { paddingRight: 4, alignItems: 'flex-end' },
  hourLabel: {
    ...typography.small,
    color: colors.textMuted,
    transform: [{ translateY: -6 }],
  },
  dayCols: { flex: 1, flexDirection: 'row' },
  dayCol: {
    flex: 1,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
    position: 'relative',
  },
  hourSlot: {
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  eventBlock: {
    position: 'absolute',
    borderRadius: radius.xs,
    borderLeftWidth: 2,
    paddingHorizontal: 3,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  eventBlockTitle: { fontSize: 10, color: colors.text, fontWeight: '600' },
  eventBlockTime: { fontSize: 9, color: colors.textMuted, marginTop: 1 },

  nowLine: {
    position: 'absolute',
    left: -3,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  nowDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.error,
  },
  nowBar: { flex: 1, height: 1, backgroundColor: colors.error },
});
