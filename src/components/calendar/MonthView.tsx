import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import {
  addDays,
  endOfMonth,
  endOfWeek,
  format,
  getISOWeek,
  getWeek,
  startOfMonth,
  startOfWeek,
  type Locale,
} from 'date-fns';
import type { Calendar, CalendarEvent } from '../../api/types';
import { componentSizes, radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import {
  buildEventDayIndex,
  eventsOnDayFromIndex,
  getEventColor,
  getEventStartDate,
  timePattern,
  type EventDayIndex,
  type TimeFormat,
} from '../../lib/calendar-utils';
import { dayIndexIn, monthKeyOf, monthMask } from '../../lib/calendar-month-scroll';
import { useCalendarLocale } from '../../lib/calendar-locale';

type WeekStart = 0 | 1 | 6;

// Height of a week row with dots, and with event chips (#666). The freely
// scrolling month uses them as fixed row heights.
export const MONTH_ROW_HEIGHT = 54;
export const MONTH_ROW_HEIGHT_CHIPS = 74;

interface MonthViewProps {
  currentDate: Date;
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  eventsByDay?: EventDayIndex;
  weekStartsOn?: WeekStart;
  showWeekNumbers?: boolean;
  // Render compact event chips (title + start time) instead of dots (#666).
  showTimeInMonthView?: boolean;
  timeFormat?: TimeFormat;
  onSelectDate: (date: Date) => void;
  onLongPressDate?: (date: Date) => void;
}

// ISO week numbers when the week starts on Monday (ISO 8601 weeks do), else
// the locale-style numbering with the given start day — plain
// `getWeek(date, { weekStartsOn })` is not ISO and drifts around New Year.
export function weekNumberFor(date: Date, weekStartsOn: WeekStart): number {
  if (weekStartsOn === 1) return getISOWeek(date);
  return getWeek(date, { weekStartsOn });
}

export type MonthStyles = ReturnType<typeof makeStyles>;

export function useMonthStyles(): MonthStyles {
  const c = useColors();
  return React.useMemo(() => makeStyles(c), [c]);
}

export function MonthWeekdayHeader({
  weekStartsOn,
  showWeekNumbers,
  styles,
}: {
  weekStartsOn: WeekStart;
  showWeekNumbers: boolean;
  styles: MonthStyles;
}) {
  const { locale } = useCalendarLocale();
  const labels = React.useMemo(() => {
    const start = startOfWeek(new Date(), { weekStartsOn });
    return Array.from({ length: 7 }, (_, i) => format(addDays(start, i), 'EEEEE', { locale }));
  }, [weekStartsOn, locale]);
  return (
    <View style={styles.weekdayRow}>
      {showWeekNumbers && <Text style={styles.weekNumberLabel}>#</Text>}
      {labels.map((wd, i) => (
        <Text key={i} style={styles.weekdayLabel}>{wd}</Text>
      ))}
    </View>
  );
}

export interface MonthWeekRowProps {
  days: Date[];
  /** Bit i set: day i belongs to the month in focus (others are muted). */
  activeMask: number;
  /** Index of the selected / today's day in this row, or -1. */
  selectedIndex: number;
  todayIndex: number;
  index: EventDayIndex;
  calendars: Calendar[];
  weekStartsOn: WeekStart;
  showWeekNumbers: boolean;
  showTimeInMonthView: boolean;
  timeFormat?: TimeFormat;
  /** Mark the first day of a month with the month's name (continuous scrolling). */
  labelMonths?: boolean;
  /** Fixed row height (continuous scrolling); natural height otherwise. */
  height?: number;
  locale: Locale;
  styles: MonthStyles;
  onSelectDate: (date: Date) => void;
  onLongPressDate?: (date: Date) => void;
}

function MonthWeekRowInner({
  days,
  activeMask,
  selectedIndex,
  todayIndex,
  index,
  calendars,
  weekStartsOn,
  showWeekNumbers,
  showTimeInMonthView,
  timeFormat,
  labelMonths = false,
  height,
  locale,
  styles,
  onSelectDate,
  onLongPressDate,
}: MonthWeekRowProps) {
  return (
    <View style={[styles.weekRow, height !== undefined && { height, overflow: 'hidden' }]}>
      {showWeekNumbers && (
        <Text style={styles.weekNumberCell}>{weekNumberFor(days[0], weekStartsOn)}</Text>
      )}
      {days.map((d, i) => {
        const sameMonth = (activeMask & (1 << i)) !== 0;
        const today = i === todayIndex;
        const selected = i === selectedIndex;
        const dayEvents = eventsOnDayFromIndex(index, d);
        const MAX_DOTS = dayEvents.length > 3 ? 2 : 3;
        const MAX_CHIPS = dayEvents.length > 2 ? 1 : 2;
        const maxVisible = showTimeInMonthView ? MAX_CHIPS : MAX_DOTS;
        const visible = dayEvents.slice(0, maxVisible);
        const overflow = Math.max(0, dayEvents.length - maxVisible);
        const monthLabel = labelMonths && d.getDate() === 1 ? format(d, 'MMM', { locale }) : null;

        return (
          <Pressable
            key={i}
            style={[styles.dayCell, showTimeInMonthView && styles.dayCellTall]}
            onPress={() => onSelectDate(d)}
            onLongPress={onLongPressDate ? () => onLongPressDate(d) : undefined}
          >
            <View style={[
              styles.dayNumber,
              today && styles.todayCircle,
              selected && !today && styles.selectedCircle,
            ]}>
              {monthLabel && (
                <Text
                  numberOfLines={1}
                  style={[
                    styles.monthLabel,
                    !sameMonth && styles.dayTextMuted,
                    today && styles.todayText,
                    selected && !today && styles.selectedText,
                  ]}
                >
                  {monthLabel}
                </Text>
              )}
              <Text style={[
                styles.dayText,
                monthLabel !== null && styles.dayTextUnderLabel,
                !sameMonth && styles.dayTextMuted,
                today && styles.todayText,
                selected && !today && styles.selectedText,
              ]}>
                {format(d, 'd')}
              </Text>
            </View>
            {dayEvents.length > 0 && !showTimeInMonthView && (
              <View style={styles.dotsRow}>
                {visible.map((event, idx) => (
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
            {dayEvents.length > 0 && showTimeInMonthView && (
              <View style={styles.chipsCol}>
                {visible.map((event, idx) => {
                  const color = getEventColor(event, calendars);
                  const cancelled = event.status === 'cancelled';
                  return (
                    <View key={`${event.id}-${idx}`} style={[styles.chip, { backgroundColor: color }]}>
                      <Text
                        style={[styles.chipText, cancelled && styles.chipTextCancelled]}
                        numberOfLines={1}
                      >
                        {event.showWithoutTime
                          ? (event.title || '')
                          : `${format(getEventStartDate(event), timePattern(timeFormat), { locale })} ${event.title || ''}`}
                      </Text>
                    </View>
                  );
                })}
                {overflow > 0 && (
                  <Text style={styles.overflowText}>+{overflow}</Text>
                )}
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

export const MonthWeekRow = React.memo(MonthWeekRowInner);

function MonthViewInner({
  currentDate,
  selectedDate,
  events,
  calendars,
  eventsByDay,
  weekStartsOn = 0,
  showWeekNumbers = false,
  showTimeInMonthView = false,
  timeFormat,
  onSelectDate,
  onLongPressDate,
}: MonthViewProps) {
  const styles = useMonthStyles();
  const { locale } = useCalendarLocale();
  const index = React.useMemo(
    () => eventsByDay ?? buildEventDayIndex(events),
    [eventsByDay, events],
  );

  // The month grid as rows of 7 days.
  const rows = React.useMemo(() => {
    const calStart = startOfWeek(startOfMonth(currentDate), { weekStartsOn });
    const calEnd = endOfWeek(endOfMonth(currentDate), { weekStartsOn });
    const out: Date[][] = [];
    let day = calStart;
    while (day <= calEnd) {
      out.push(Array.from({ length: 7 }, (_, i) => addDays(day, i)));
      day = addDays(day, 7);
    }
    return out;
  }, [currentDate, weekStartsOn]);
  const activeMonth = monthKeyOf(currentDate);
  const today = new Date();

  return (
    <View style={styles.grid}>
      <MonthWeekdayHeader weekStartsOn={weekStartsOn} showWeekNumbers={showWeekNumbers} styles={styles} />
      {rows.map((days) => (
        <MonthWeekRow
          key={days[0].toISOString()}
          days={days}
          activeMask={monthMask(days, activeMonth)}
          selectedIndex={dayIndexIn(days, selectedDate)}
          todayIndex={dayIndexIn(days, today)}
          index={index}
          calendars={calendars}
          weekStartsOn={weekStartsOn}
          showWeekNumbers={showWeekNumbers}
          showTimeInMonthView={showTimeInMonthView}
          timeFormat={timeFormat}
          locale={locale}
          styles={styles}
          onSelectDate={onSelectDate}
          onLongPressDate={onLongPressDate}
        />
      ))}
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
  weekRow: { flexDirection: 'row', alignItems: 'flex-start' },
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
  dayCell: { flex: 1, alignItems: 'center', paddingVertical: 4 },
  dayCellTall: { minHeight: MONTH_ROW_HEIGHT_CHIPS, paddingHorizontal: 1 },
  dayNumber: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayText: { ...typography.body, color: c.text },
  // Day 1 under its month's name: both fit the 36px circle.
  dayTextUnderLabel: { lineHeight: 16 },
  monthLabel: { fontSize: 8, lineHeight: 10, fontWeight: '600', color: c.textSecondary, textTransform: 'uppercase' },
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
  chipsCol: { width: '100%', gap: 1, marginTop: 2, alignItems: 'stretch' },
  chip: {
    borderRadius: radius.xs,
    paddingHorizontal: 2,
    paddingVertical: 1,
  },
  chipText: { color: c.textInverse, fontSize: 9, lineHeight: 11 },
  chipTextCancelled: { textDecorationLine: 'line-through' },
  overflowText: {
    color: c.textMuted,
    fontSize: 9,
    lineHeight: 10,
    marginLeft: 1,
    textAlign: 'center',
  },
  });
}
