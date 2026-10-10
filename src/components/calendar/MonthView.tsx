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
import { componentSizes, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import {
  buildEventDayIndex,
  eventsOnDayFromIndex,
  getEventColor,
  getEventStartDate,
  isTimedEventFullDayOnDate,
  timePattern,
  type EventDayIndex,
  type TimeFormat,
} from '../../lib/calendar-utils';
import { dayIndexIn, monthKeyOf, monthMask } from '../../lib/calendar-month-scroll';
import { isInactiveEvent } from '../../lib/calendar-participants';
import { eventBlockColors } from '../../lib/event-colors';
import { useCalendarLocale } from '../../lib/calendar-locale';
import { displayNow } from '../../lib/calendar-timezone';

type WeekStart = 0 | 1 | 6;

// Height of a week row with dots, and with event chips (#666). The freely
// scrolling month uses them as fixed row heights.
export const MONTH_ROW_HEIGHT = 54;
export const MONTH_ROW_HEIGHT_CHIPS = 74;
// Smallest week row of the full-screen month grid.
export const MONTH_ROW_HEIGHT_FULL_MIN = 72;
// Corner radius of event bars (repos/branding/APP.md).
const EVENT_RADIUS = 2;

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
  /** Fill the available height with the full month grid. */
  fill?: boolean;
  timeFormat?: TimeFormat;
  /** The user's addresses, to draw events they declined as inactive. */
  currentUserEmails?: string[];
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
  /** The user's addresses, to draw events they declined as inactive. */
  currentUserEmails?: string[];
  /** Mark the first day of a month with the month's name (continuous scrolling). */
  labelMonths?: boolean;
  /** Fixed row height (continuous scrolling); natural height otherwise. */
  height?: number;
  /**
   * 'full': the month fills the screen, with grid
   * lines and an event chip per event. 'compact': numbers with event dots
   * (the month under the title).
   */
  variant?: 'compact' | 'full';
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
  currentUserEmails,
  labelMonths = false,
  height,
  variant = 'compact',
  locale,
  styles,
  onSelectDate,
  onLongPressDate,
}: MonthWeekRowProps) {
  const c = useColors();
  if (variant === 'full') {
    return (
      <FullWeekRow
        days={days}
        activeMask={activeMask}
        todayIndex={todayIndex}
        index={index}
        calendars={calendars}
        weekStartsOn={weekStartsOn}
        showWeekNumbers={showWeekNumbers}
        showTimeInMonthView={showTimeInMonthView}
        timeFormat={timeFormat}
        currentUserEmails={currentUserEmails}
        labelMonths={labelMonths}
        height={height ?? MONTH_ROW_HEIGHT_FULL_MIN}
        locale={locale}
        styles={styles}
        colors={c}
        onSelectDate={onSelectDate}
        onLongPressDate={onLongPressDate}
      />
    );
  }
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
                  // Solid bars in the calendar colour; declined and
                  // cancelled events outlined (repos/branding/APP.md).
                  const inactive = isInactiveEvent(event, currentUserEmails);
                  const colors = eventBlockColors(getEventColor(event, calendars), inactive, c);
                  return (
                    <View
                      key={`${event.id}-${idx}`}
                      style={[
                        styles.chip,
                        { backgroundColor: colors.fill },
                        colors.border !== null && [styles.chipInactive, { borderColor: colors.border }],
                      ]}
                    >
                      <Text style={[styles.chipText, { color: colors.text }]} numberOfLines={1}>
                        {event.showWithoutTime
                          ? null
                          : `${format(getEventStartDate(event), timePattern(timeFormat), { locale })} `}
                        <Text style={inactive && styles.chipTextInactive}>{event.title || ''}</Text>
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

/** Day number area at the top of a full month cell. */
const FULL_NUMBER_HEIGHT = 24;
/** One event chip in a full month cell, with its gap. */
const FULL_CHIP_HEIGHT = 16;
const FULL_CHIP_GAP = 2;

/** Event chips that fit a full month cell of `height`, keeping a line for "+N" when needed. */
export function fullCellChipCount(height: number, eventCount: number): number {
  const room = Math.max(0, Math.floor((height - FULL_NUMBER_HEIGHT - 2) / (FULL_CHIP_HEIGHT + FULL_CHIP_GAP)));
  if (eventCount <= room) return eventCount;
  return Math.max(0, room - 1);
}

// A week of the full-screen month grid: thin cell lines, the day number
// small at the top (today in a filled circle), then one filled chip per
// event and "+N" for those that don't fit.
function FullWeekRow({
  days,
  activeMask,
  todayIndex,
  index,
  calendars,
  weekStartsOn,
  showWeekNumbers,
  showTimeInMonthView,
  timeFormat,
  currentUserEmails,
  labelMonths,
  height,
  locale,
  styles,
  colors: c,
  onSelectDate,
  onLongPressDate,
}: Omit<MonthWeekRowProps, 'selectedIndex' | 'variant'> & {
  height: number;
  colors: ThemePalette;
}) {
  return (
    <View style={[styles.fullWeekRow, { height }]}>
      {showWeekNumbers && (
        <Text style={[styles.weekNumberCell, styles.fullWeekNumber]}>{weekNumberFor(days[0], weekStartsOn)}</Text>
      )}
      {days.map((d, i) => {
        const sameMonth = (activeMask & (1 << i)) !== 0;
        const today = i === todayIndex;
        const dayEvents = eventsOnDayFromIndex(index, d);
        const shown = fullCellChipCount(height, dayEvents.length);
        const overflow = dayEvents.length - shown;
        const label = labelMonths && d.getDate() === 1 ? format(d, 'MMM d', { locale }) : format(d, 'd');
        return (
          <Pressable
            key={i}
            style={({ pressed }) => [styles.fullCell, i === 0 && styles.fullCellFirst, pressed && styles.fullCellPressed]}
            onPress={() => onSelectDate(d)}
            onLongPress={onLongPressDate ? () => onLongPressDate(d) : undefined}
            accessibilityRole="button"
            accessibilityLabel={format(d, 'PPPP', { locale })}
          >
            <View style={styles.fullNumberWrap}>
              <View style={[styles.fullNumber, today && styles.fullNumberToday]}>
                <Text
                  numberOfLines={1}
                  style={[
                    styles.fullNumberText,
                    !sameMonth && styles.dayTextMuted,
                    today && styles.fullNumberTextToday,
                  ]}
                >
                  {label}
                </Text>
              </View>
            </View>
            {dayEvents.slice(0, shown).map((event, idx) => {
              const inactive = isInactiveEvent(event, currentUserEmails);
              const colors = eventBlockColors(getEventColor(event, calendars), inactive, c);
              // No time on events that fill the whole day.
              const time = showTimeInMonthView && !event.showWithoutTime && !isTimedEventFullDayOnDate(event, d)
                ? `${format(getEventStartDate(event), timePattern(timeFormat), { locale })} `
                : '';
              return (
                <View
                  key={`${event.id}-${idx}`}
                  style={[
                    styles.fullChip,
                    { backgroundColor: colors.fill },
                    colors.border !== null && [styles.chipInactive, { borderColor: colors.border }],
                  ]}
                >
                  <Text
                    style={[styles.fullChipText, { color: colors.text }, inactive && styles.chipTextInactive]}
                    numberOfLines={1}
                    ellipsizeMode="clip"
                  >
                    {time}{event.title || ''}
                  </Text>
                </View>
              );
            })}
            {overflow > 0 && <Text style={styles.fullOverflow}>+{overflow}</Text>}
          </Pressable>
        );
      })}
    </View>
  );
}

function MonthViewInner({
  currentDate,
  selectedDate,
  events,
  calendars,
  eventsByDay,
  weekStartsOn = 0,
  showWeekNumbers = false,
  showTimeInMonthView = false,
  fill = false,
  timeFormat,
  currentUserEmails,
  onSelectDate,
  onLongPressDate,
}: MonthViewProps) {
  const styles = useMonthStyles();
  const [gridHeight, setGridHeight] = React.useState(0);
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
  // Today on a clock in the calendar's time zone.
  const today = displayNow();

  const fullRowHeight = fill && gridHeight > 0
    ? Math.max(MONTH_ROW_HEIGHT_FULL_MIN, Math.floor(gridHeight / rows.length))
    : undefined;

  return (
    <View style={fill ? styles.fullGrid : styles.grid}>
      <MonthWeekdayHeader weekStartsOn={weekStartsOn} showWeekNumbers={showWeekNumbers} styles={styles} />
      <View
        style={fill && styles.fullRows}
        onLayout={fill ? (e) => setGridHeight(e.nativeEvent.layout.height) : undefined}
      >
      {(!fill || fullRowHeight !== undefined) && rows.map((days) => (
        <MonthWeekRow
          key={days[0].toISOString()}
          variant={fill ? 'full' : 'compact'}
          height={fullRowHeight}
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
          currentUserEmails={currentUserEmails}
          locale={locale}
          styles={styles}
          onSelectDate={onSelectDate}
          onLongPressDate={onLongPressDate}
        />
      ))}
      </View>
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
    borderRadius: EVENT_RADIUS,
    paddingHorizontal: 2,
    paddingVertical: 1,
  },
  // The 1px outline takes the place of a pixel of padding, so outlined and
  // solid bars are the same size.
  chipInactive: { borderWidth: 1, paddingHorizontal: 1, paddingVertical: 0 },
  // Colour comes from eventBlockColors(): computed from the calendar colour,
  // never a theme colour.
  chipText: { fontSize: 9, lineHeight: 11, fontWeight: '500' },
  chipTextInactive: { textDecorationLine: 'line-through' },
  overflowText: {
    color: c.textMuted,
    fontSize: 9,
    lineHeight: 10,
    marginLeft: 1,
    textAlign: 'center',
  },

  fullGrid: { flex: 1 },
  fullRows: { flex: 1 },
  fullWeekRow: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
  },
  fullWeekNumber: { paddingTop: 6 },
  fullCell: {
    flex: 1,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: c.border,
    paddingHorizontal: 1,
    overflow: 'hidden',
  },
  fullCellFirst: { borderLeftWidth: 0 },
  fullCellPressed: { backgroundColor: c.surfaceHover },
  fullNumberWrap: { height: FULL_NUMBER_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  fullNumber: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullNumberToday: { backgroundColor: c.primary },
  fullNumberText: { fontSize: 12, lineHeight: 16, fontWeight: '500', color: c.text },
  fullNumberTextToday: { color: c.primaryForeground, fontWeight: '700' },
  fullChip: {
    height: FULL_CHIP_HEIGHT,
    marginBottom: FULL_CHIP_GAP,
    borderRadius: EVENT_RADIUS,
    paddingHorizontal: 3,
    justifyContent: 'center',
  },
  // 9px text on the phone's month bars (repos/branding/APP.md).
  fullChipText: { fontSize: 9, lineHeight: 12, fontWeight: '500' },
  fullOverflow: { fontSize: 10, lineHeight: 13, fontWeight: '500', color: c.textSecondary, paddingHorizontal: 3 },
  });
}
