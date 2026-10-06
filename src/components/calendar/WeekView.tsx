import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
} from 'react-native';
import { addDays, format, isSameDay, startOfWeek } from 'date-fns';
import { displayNowMinutes, isDisplayToday } from '../../lib/calendar-timezone';
import type { Calendar, CalendarEvent } from '../../api/types';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useCalendarLocale } from '../../lib/calendar-locale';
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
import { useSettingsStore } from '../../stores/settings-store';
import {
  displayGridHeight,
  eventRect,
  minutesToY,
  partitionByDisplayHours,
  remapSegmentsToShownDays,
  resolveWorkingDays,
} from '../../lib/calendar-display-range';
import { isInactiveEvent } from '../../lib/calendar-participants';
import { eventBlockColors } from '../../lib/event-colors';
import { AllDayEventBar, TIME_LINE_MIN_MINUTES, TimedEventBlock, taskControlFor } from './EventBlock';
import { isTaskDone } from '../../lib/calendar-tasks';
import { allDayRowCounts, allDayStripLayout } from '../../lib/calendar-all-day';
import { AllDayToggle, AllHoursToggle, HiddenEventsIndicator } from './DisplayHoursControls';
import { useDisplayHours } from './use-display-hours';

const HOUR_HEIGHT = 48;
const GUTTER_WIDTH = 44;
const ALL_DAY_CHIP_HEIGHT = 18;
const ALL_DAY_GAP = 2;

interface WeekViewProps {
  /** A day of the week to show; defaults to the selected day. */
  weekDate?: Date;
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  eventsByDay?: EventDayIndex;
  onSelectDate?: (date: Date) => void;
  onSelectEvent?: (event: CalendarEvent) => void;
  /** Toggles a task done from its circle; gets the task's id. */
  onToggleTask?: (taskId: string) => void;
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
  onToggleTask,
  onCreateAtTime,
  weekStartsOn = 0,
  timeFormat = '24h',
  currentUserEmails,
}: WeekViewProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const { locale, t } = useCalendarLocale();
  const scrollRef = React.useRef<ScrollView>(null);
  // The working hours, or the whole day on request.
  const { hours, configured, canToggle, showAllHours, toggleAllHours, revealMinutes, onScroll } =
    useDisplayHours(scrollRef, HOUR_HEIGHT);
  const gridHeight = displayGridHeight(hours, HOUR_HEIGHT);
  const firstHour = hours.startMinutes / 60;
  const gridHours = React.useMemo(
    () => Array.from({ length: (hours.endMinutes - hours.startMinutes) / 60 }, (_, i) => firstHour + i),
    [hours, firstHour],
  );

  const index = React.useMemo(
    () => eventsByDay ?? buildEventDayIndex(events),
    [eventsByDay, events],
  );

  const shownDate = weekDate ?? selectedDate;
  const fullWeek = React.useMemo(() => {
    const start = startOfWeek(shownDate, { weekStartsOn });
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [shownDate, weekStartsOn]);
  // The non-working days the user asked to leave out. `shownIndexByDay[i]`
  // is the column of `fullWeek[i]`, or -1 for a day left out.
  const hideNonWorkingDays = useSettingsStore((s) => s.calendarHideNonWorkingDays);
  const workingDaysSetting = useSettingsStore((s) => s.calendarWorkingDays);
  const { weekDays, shownIndexByDay } = React.useMemo(() => {
    const working = resolveWorkingDays(hideNonWorkingDays, workingDaysSetting);
    if (!working) return { weekDays: fullWeek, shownIndexByDay: null };
    const shown: Date[] = [];
    const indices = fullWeek.map((day) => {
      if (!working.has(day.getDay())) return -1;
      shown.push(day);
      return shown.length - 1;
    });
    return shown.length > 0
      ? { weekDays: shown, shownIndexByDay: indices }
      : { weekDays: fullWeek, shownIndexByDay: null };
  }, [fullWeek, hideNonWorkingDays, workingDaysSetting]);

  // Multi-day all-day events render as one bar across the days they span.
  // Timed events that consume the entire day get promoted to this strip too.
  const allDaySegments = React.useMemo<CalendarWeekSegment[]>(() => {
    const explicit = buildWeekSegmentsRaw(
      events.filter((e) => e.showWithoutTime),
      fullWeek,
    );
    const timedFull = buildTimedFullDayWeekSegments(
      events.filter((e) => !e.showWithoutTime),
      fullWeek,
    );
    const raw = [...explicit, ...timedFull];
    return packWeekSegments(shownIndexByDay ? remapSegmentsToShownDays(raw, shownIndexByDay) : raw);
  }, [events, fullWeek, shownIndexByDay]);

  // The strip is capped at a few rows, sized from the days drawn.
  const [allDayExpanded, setAllDayExpanded] = React.useState(false);
  const allDayLayout = React.useMemo(
    () => allDayStripLayout(allDayRowCounts(allDaySegments, 0, weekDays.length), allDayExpanded),
    [allDaySegments, weekDays.length, allDayExpanded],
  );
  const allDayRowCount = allDayLayout.visibleRows;
  const shownAllDaySegments = React.useMemo(
    () => allDaySegments.filter((s) => s.row < allDayRowCount),
    [allDaySegments, allDayRowCount],
  );

  const allDayStripHeight =
    allDayRowCount > 0
      ? allDayRowCount * (ALL_DAY_CHIP_HEIGHT + ALL_DAY_GAP) + spacing.xs
      : 0;

  // Timed grid excludes events that fill the full day on that day - they're
  // already promoted to the all-day strip above.
  // Events outside the visible hours are counted, not laid out.
  const layoutsByDay = React.useMemo(() => {
    return weekDays.map((day) => {
      const dayEvents = eventsOnDayFromIndex(index, day).filter(
        (e) => !e.showWithoutTime && !isTimedEventFullDayOnDate(e, day),
      );
      const partition = partitionByDisplayHours(dayEvents, day, hours);
      return { ...partition, layouts: layoutOverlappingEvents(partition.visible, day) };
    });
  }, [weekDays, index, hours]);

  // The now-line and "today" follow a clock in the calendar's time zone.
  const [nowMinutes, setNowMinutes] = React.useState(displayNowMinutes);

  React.useEffect(() => {
    const interval = setInterval(() => {
      setNowMinutes(displayNowMinutes());
    }, 60_000);
    return () => clearInterval(interval);
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
            {format(day, 'd')}
          </Text>
        </View>
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={[styles.gutter, { justifyContent: 'flex-end' }]}>
          {canToggle && (
            <AllHoursToggle
              showAllHours={showAllHours}
              configured={configured}
              timeFormat={timeFormat}
              onToggle={toggleAllHours}
            />
          )}
        </View>
        <View style={styles.dayHeaders}>{weekDays.map(dayHeader)}</View>
      </View>

      {allDayRowCount > 0 && (
        <View style={[styles.allDayStrip, { height: allDayStripHeight }]}>
          <View style={[styles.gutter, styles.allDayLabelWrap]}>
            {allDayLayout.expandable ? (
              <AllDayToggle
                expanded={allDayExpanded}
                hiddenCount={allDayLayout.hiddenCount}
                onToggle={() => setAllDayExpanded((v) => !v)}
              />
            ) : (
              <Text style={styles.allDayLabel} numberOfLines={2}>{t('calendar.events.all_day', 'All day')}</Text>
            )}
          </View>
          <View style={styles.allDayGrid}>
            {/* Empty per-day columns to draw vertical separators */}
            {weekDays.map((day) => (
              <View key={day.toISOString()} style={styles.allDayCol} />
            ))}
            {/* Segments overlay - multi-day events span their date range */}
            <View style={styles.allDayOverlay} pointerEvents="box-none">
              {shownAllDaySegments.map((segment) => {
                const leftPct = (segment.startIndex / weekDays.length) * 100;
                const widthPct = (segment.span / weekDays.length) * 100;
                return (
                  <AllDayEventBar
                    key={`${segment.event.id}:${segment.startIndex}:${segment.row}`}
                    title={segment.event.title || t('calendar.events.no_title', '(No title)')}
                    colors={eventBlockColors(
                      getEventColor(segment.event, calendars),
                      isInactiveEvent(segment.event, currentUserEmails) || isTaskDone(segment.event),
                      c,
                    )}
                    continuesBefore={segment.continuesBefore}
                    continuesAfter={segment.continuesAfter}
                    task={taskControlFor(segment.event, onToggleTask, t)}
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
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        <View style={[styles.grid, { height: gridHeight }]}>
          <View style={styles.gutterCol}>
            {gridHours.map((h) => (
              <View key={h} style={[styles.hourLabelCell, { height: HOUR_HEIGHT }]}>
                {h > firstHour && (
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
              const dayLayout = layoutsByDay[dayIndex];
              const layouted = dayLayout.layouts;
              const todayCol = isDisplayToday(day);
              return (
                <View key={day.toISOString()} style={styles.dayCol}>
                  {gridHours.map((h) => (
                    <Pressable
                      key={h}
                      onLongPress={() => handleSlotLongPress(day, h)}
                      style={[styles.hourSlot, { height: HOUR_HEIGHT }]}
                    />
                  ))}

                  {dayLayout.before > 0 && (
                    <HiddenEventsIndicator
                      count={dayLayout.before}
                      direction="before"
                      onReveal={() => revealMinutes(dayLayout.firstBeforeMinutes ?? hours.startMinutes)}
                    />
                  )}
                  {dayLayout.after > 0 && (
                    <HiddenEventsIndicator
                      count={dayLayout.after}
                      direction="after"
                      onReveal={() => revealMinutes(dayLayout.firstAfterMinutes ?? hours.endMinutes)}
                    />
                  )}

                  {layouted.map(
                    ({ event, column, totalColumns, startMinutes, endMinutes, continuesBefore, continuesAfter }) => {
                      const { top, height, clippedStart, clippedEnd } = eventRect(
                        startMinutes,
                        endMinutes,
                        hours,
                        HOUR_HEIGHT,
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
                            isInactiveEvent(event, currentUserEmails) || isTaskDone(event),
                            c,
                          )}
                          ringColor={c.background}
                          continuesBefore={continuesBefore || clippedStart}
                          continuesAfter={continuesAfter || clippedEnd}
                          task={taskControlFor(event, onToggleTask, t)}
                          onPress={() => onSelectEvent?.(event)}
                          style={{ top, height, left: `${leftPct}%`, width: `${widthPct}%` }}
                        />
                      );
                    },
                  )}

                  {todayCol && nowMinutes >= hours.startMinutes && nowMinutes < hours.endMinutes && (
                    <View
                      pointerEvents="none"
                      style={[
                        styles.nowLine,
                        { top: minutesToY(nowMinutes, hours, HOUR_HEIGHT) },
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
