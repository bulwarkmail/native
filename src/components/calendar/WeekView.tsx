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
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import {
  buildEventDayIndex,
  buildTimedFullDayWeekSegments,
  buildWeekSegmentsRaw,
  eventsOnDayFromIndex,
  getEventColor,
  isTimedEventFullDayOnDate,
  layoutOverlappingEvents,
  packWeekSegments,
  type CalendarWeekSegment,
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
  timeFormat?: '12h' | '24h';
}

function WeekViewInner({
  selectedDate,
  events,
  calendars,
  eventsByDay,
  onSelectDate,
  onSelectEvent,
  onCreateAtTime,
  weekStartsOn = 0,
  timeFormat = '24h',
}: WeekViewProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const scrollRef = React.useRef<ScrollView>(null);

  const index = React.useMemo(
    () => eventsByDay ?? buildEventDayIndex(events),
    [eventsByDay, events],
  );

  const weekDays = React.useMemo(() => {
    const start = startOfWeek(selectedDate, { weekStartsOn });
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [selectedDate, weekStartsOn]);

  // Multi-day all-day events render as one bar across the days they span.
  // Timed events that consume the entire day get promoted to this strip too.
  const allDaySegments = React.useMemo<CalendarWeekSegment[]>(() => {
    const explicit = buildWeekSegmentsRaw(
      events.filter((e) => e.showWithoutTime),
      weekDays,
    );
    const timedFull = buildTimedFullDayWeekSegments(
      events.filter((e) => !e.showWithoutTime),
      weekDays,
    );
    return packWeekSegments([...explicit, ...timedFull]);
  }, [events, weekDays]);

  const allDayRowCount = React.useMemo(() => {
    return allDaySegments.reduce((max, s) => Math.max(max, s.row + 1), 0);
  }, [allDaySegments]);

  const allDayStripHeight =
    allDayRowCount > 0
      ? allDayRowCount * (ALL_DAY_CHIP_HEIGHT + ALL_DAY_GAP) + spacing.xs
      : 0;

  // Timed grid excludes events that fill the full day on that day - they're
  // already promoted to the all-day strip above.
  const layoutsByDay = React.useMemo(() => {
    return weekDays.map((day) => {
      const dayEvents = eventsOnDayFromIndex(index, day).filter(
        (e) => !e.showWithoutTime && !isTimedEventFullDayOnDate(e, day),
      );
      return layoutOverlappingEvents(dayEvents, day);
    });
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
            {/* Empty per-day columns to draw vertical separators */}
            {weekDays.map((day) => (
              <View key={day.toISOString()} style={styles.allDayCol} />
            ))}
            {/* Segments overlay - multi-day events span their date range */}
            <View style={styles.allDayOverlay} pointerEvents="box-none">
              {allDaySegments.map((segment) => {
                const color = getEventColor(segment.event, calendars);
                const leftPct = (segment.startIndex / weekDays.length) * 100;
                const widthPct = (segment.span / weekDays.length) * 100;
                return (
                  <Pressable
                    key={`${segment.event.id}:${segment.startIndex}:${segment.row}`}
                    onPress={() => onSelectEvent?.(segment.event)}
                    style={[
                      styles.allDayChip,
                      {
                        position: 'absolute',
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        top: segment.row * (ALL_DAY_CHIP_HEIGHT + ALL_DAY_GAP),
                        backgroundColor: color + '33',
                        borderLeftColor: color,
                        borderTopLeftRadius: segment.continuesBefore ? 0 : radius.xs,
                        borderBottomLeftRadius: segment.continuesBefore ? 0 : radius.xs,
                        borderTopRightRadius: segment.continuesAfter ? 0 : radius.xs,
                        borderBottomRightRadius: segment.continuesAfter ? 0 : radius.xs,
                        marginHorizontal: 1,
                      },
                    ]}
                  >
                    <Text style={styles.allDayChipText} numberOfLines={1}>
                      {segment.continuesBefore ? '… ' : ''}
                      {segment.event.title || 'Untitled'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
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
                    {timeFormat === '12h'
                      ? `${((h % 12) || 12)} ${h < 12 ? 'AM' : 'PM'}`
                      : `${h.toString().padStart(2, '0')}:00`}
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

export const WeekView = React.memo(WeekViewInner);

function minutesToTimeLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  headerRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: c.border,
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
    color: c.textMuted,
    textTransform: 'uppercase',
  },
  dayHeaderNumber: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayHeaderNumberToday: { backgroundColor: c.primary },
  dayHeaderNumberSelected: {
    backgroundColor: c.primaryBg,
    borderWidth: 1,
    borderColor: c.primary,
  },
  dayHeaderNumberText: { ...typography.bodyMedium, color: c.text },
  dayHeaderNumberTextToday: { color: c.textInverse, fontWeight: '700' },
  dayHeaderNumberTextSelected: { color: c.primary, fontWeight: '600' },

  allDayStrip: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    paddingVertical: 2,
  },
  allDayLabelWrap: { alignItems: 'flex-end', justifyContent: 'flex-start', paddingRight: 4 },
  allDayLabel: { ...typography.small, color: c.textMuted },
  allDayGrid: { flex: 1, flexDirection: 'row', position: 'relative' },
  allDayCol: {
    flex: 1,
    borderLeftWidth: 1,
    borderLeftColor: c.borderLight,
  },
  allDayOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  allDayChip: {
    height: ALL_DAY_CHIP_HEIGHT,
    borderRadius: radius.xs,
    borderLeftWidth: 2,
    paddingHorizontal: 4,
    justifyContent: 'center',
  },
  allDayChipText: { fontSize: 10, color: c.text, fontWeight: '500' },

  scroll: { flex: 1 },
  scrollContent: {},
  grid: { flexDirection: 'row' },
  gutterCol: { width: GUTTER_WIDTH },
  hourLabelCell: { paddingRight: 4, alignItems: 'flex-end' },
  hourLabel: {
    ...typography.small,
    color: c.textMuted,
    transform: [{ translateY: -6 }],
  },
  dayCols: { flex: 1, flexDirection: 'row' },
  dayCol: {
    flex: 1,
    borderLeftWidth: 1,
    borderLeftColor: c.border,
    position: 'relative',
  },
  hourSlot: {
    borderBottomWidth: 1,
    borderBottomColor: c.borderLight,
  },
  eventBlock: {
    position: 'absolute',
    borderRadius: radius.xs,
    borderLeftWidth: 2,
    paddingHorizontal: 3,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  eventBlockTitle: { fontSize: 10, color: c.text, fontWeight: '600' },
  eventBlockTime: { fontSize: 9, color: c.textMuted, marginTop: 1 },

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
    backgroundColor: c.error,
  },
  nowBar: { flex: 1, height: 1, backgroundColor: c.error },
  });
}
