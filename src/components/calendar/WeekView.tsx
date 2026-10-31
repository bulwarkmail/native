import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
} from 'react-native';
import { addDays, format, isSameDay, startOfWeek } from 'date-fns';
import { displayNow, displayNowMinutes, isDisplayToday } from '../../lib/calendar-timezone';
import type { Calendar, CalendarEvent } from '../../api/types';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore } from '../../stores/settings-store';
import { useCalendarLocale } from '../../lib/calendar-locale';
import { dayNumberLabel } from '../../lib/calendar-system';
import { eventAccessibilityLabel } from '../../lib/calendar-a11y';
import {
  buildEventDayIndex,
  buildTimedFullDayWeekSegments,
  buildWeekSegmentsRaw,
  eventsOnDayFromIndex,
  getEventColor,
  isTimedEventFullDayOnDate,
  layoutOverlappingEvents,
  type CalendarWeekSegment,
  type EventDayIndex,
} from '../../lib/calendar-utils';
import { isInactiveEvent } from '../../lib/calendar-participants';
import { eventBlockColors } from '../../lib/event-colors';
import { AllDayEventBar, TIME_LINE_MIN_MINUTES, TimedEventBlock } from './EventBlock';
import { AllDayToggle } from './AllDayToggle';
import { packAllDaySegments, shownAllDayRows } from '../../lib/calendar-time-grid';

const HOUR_HEIGHT = 48;
const GUTTER_WIDTH = 44;
const ALL_DAY_CHIP_HEIGHT = 18;
const ALL_DAY_GAP = 2;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

interface WeekViewProps {
  /** A day of the week to show; defaults to the selected day. */
  weekDate?: Date;
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  eventsByDay?: EventDayIndex;
  onSelectDate?: (date: Date) => void;
  onSelectEvent?: (event: CalendarEvent) => void;
  onCreateAtTime?: (date: Date) => void;
  weekStartsOn?: 0 | 1 | 6;
  timeFormat?: '12h' | '24h';
  /** The user's addresses, to draw events they declined as inactive. */
  currentUserEmails?: string[];
}

function WeekViewInner({
  weekDate,
  selectedDate,
  events,
  calendars,
  eventsByDay,
  onSelectDate,
  onSelectEvent,
  onCreateAtTime,
  weekStartsOn = 0,
  timeFormat = '24h',
  currentUserEmails,
}: WeekViewProps) {
  const c = useColors();
  // "Light event colors" (webmail calendarTintedEvents).
  const tinted = useSettingsStore((s) => s.calendarTintedEvents);
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const { locale, t, system } = useCalendarLocale();
  const scrollRef = React.useRef<ScrollView>(null);

  const index = React.useMemo(
    () => eventsByDay ?? buildEventDayIndex(events),
    [eventsByDay, events],
  );

  const shownDate = weekDate ?? selectedDate;
  const weekDays = React.useMemo(() => {
    const start = startOfWeek(shownDate, { weekStartsOn });
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [shownDate, weekStartsOn]);

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
    return packAllDaySegments([...explicit, ...timedFull]);
  }, [events, weekDays]);

  const allDayRows = React.useMemo(() => {
    return allDaySegments.reduce((max, s) => Math.max(max, s.row + 1), 0);
  }, [allDaySegments]);
  // Three rows until expanded (webmail #1122).
  const [allDayExpanded, setAllDayExpanded] = React.useState(false);
  const allDayRowCount = shownAllDayRows(allDayRows, allDayExpanded);
  const allDayHiddenRows = allDayRows - shownAllDayRows(allDayRows, false);

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

  // The now-line and "today" follow a clock in the calendar's time zone.
  const [nowMinutes, setNowMinutes] = React.useState(displayNowMinutes);

  React.useEffect(() => {
    const interval = setInterval(() => {
      setNowMinutes(displayNowMinutes());
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  React.useEffect(() => {
    const target = Math.max(0, (displayNow().getHours() - 1) * HOUR_HEIGHT);
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y: target, animated: false });
    });
  }, []);

  const handleSlotLongPress = (day: Date, hour: number) => {
    if (!onCreateAtTime) return;
    // A display date; the editor converts it when it saves.
    const date = new Date(day);
    date.setHours(hour, 0, 0, 0);
    onCreateAtTime(date);
  };

  const dayHeader = (day: Date) => {
    const today = isDisplayToday(day);
    const selected = isSameDay(day, selectedDate);
    return (
      <Pressable
        key={day.toISOString()}
        style={styles.dayHeaderCell}
        onPress={() => onSelectDate?.(day)}
      >
        <Text style={styles.dayHeaderWeekday}>{format(day, 'EEE', { locale })}</Text>
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
            {dayNumberLabel(day, system)}
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
            <Text style={styles.allDayLabel} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{t('calendar.events.all_day', 'All day')}</Text>
            {allDayHiddenRows > 0 ? (
              <AllDayToggle
                hiddenRows={allDayHiddenRows}
                expanded={allDayExpanded}
                onToggle={() => setAllDayExpanded((v) => !v)}
              />
            ) : null}
          </View>
          <View style={styles.allDayGrid}>
            {/* Empty per-day columns to draw vertical separators */}
            {weekDays.map((day) => (
              <View key={day.toISOString()} style={styles.allDayCol} />
            ))}
            {/* Segments overlay - multi-day events span their date range */}
            <View style={styles.allDayOverlay} pointerEvents="box-none">
              {allDaySegments.filter((segment) => segment.row < allDayRowCount).map((segment) => {
                const leftPct = (segment.startIndex / weekDays.length) * 100;
                const widthPct = (segment.span / weekDays.length) * 100;
                return (
                  <AllDayEventBar
                    key={`${segment.event.id}:${segment.startIndex}:${segment.row}`}
                    title={segment.event.title || t('calendar.events.no_title', '(No title)')}
                    colors={eventBlockColors(
                      getEventColor(segment.event, calendars),
                      isInactiveEvent(segment.event, currentUserEmails),
                      c,
                      tinted,
                    )}
                    continuesBefore={segment.continuesBefore}
                    continuesAfter={segment.continuesAfter}
                    accessibilityLabel={eventAccessibilityLabel(segment.event, { t, locale, timeFormat, calendars, currentUserEmails })}
                    onPress={() => onSelectEvent?.(segment.event)}
                    style={{
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                      top: segment.row * (ALL_DAY_CHIP_HEIGHT + ALL_DAY_GAP),
                      height: ALL_DAY_CHIP_HEIGHT,
                      marginHorizontal: 1,
                    }}
                  />
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
              const todayCol = isDisplayToday(day);
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
                    ({ event, column, totalColumns, startMinutes, endMinutes, continuesBefore, continuesAfter }) => {
                      const top = (startMinutes / 60) * HOUR_HEIGHT;
                      const height = Math.max(
                        20,
                        ((endMinutes - startMinutes) / 60) * HOUR_HEIGHT - 1,
                      );
                      const widthPct = 100 / totalColumns;
                      const leftPct = column * widthPct;
                      return (
                        <TimedEventBlock
                          key={event.id}
                          title={event.title || t('calendar.events.no_title', '(No title)')}
                          timeLabel={endMinutes - startMinutes >= TIME_LINE_MIN_MINUTES
                            ? minutesToTimeLabel(startMinutes, timeFormat)
                            : null}
                          colors={eventBlockColors(
                            getEventColor(event, calendars),
                            isInactiveEvent(event, currentUserEmails),
                            c,
                      tinted,
                          )}
                          ringColor={c.background}
                          continuesBefore={continuesBefore}
                          continuesAfter={continuesAfter}
                          accessibilityLabel={eventAccessibilityLabel(event, { t, locale, timeFormat, calendars, currentUserEmails })}
                          onPress={() => onSelectEvent?.(event)}
                          style={{ top, height, left: `${leftPct}%`, width: `${widthPct}%` }}
                        />
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

// Event-block start label; honours the 12h/24h setting like the gutter does
// (webmail's formatSnapTime).
function minutesToTimeLabel(minutes: number, timeFormat: '12h' | '24h'): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const mm = m.toString().padStart(2, '0');
  if (timeFormat === '12h') {
    const suffix = h < 12 ? 'AM' : 'PM';
    return `${(h % 12) || 12}:${mm} ${suffix}`;
  }
  return `${h.toString().padStart(2, '0')}:${mm}`;
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
