import React from 'react';
import {
  FlatList,
  View,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import type { Calendar, CalendarEvent } from '../../api/types';
import {
  buildEventDayIndex,
  dayKey,
  type EventDayIndex,
  type TimeFormat,
} from '../../lib/calendar-utils';
import type { CalendarFocus, DayRange } from '../../lib/calendar-scroll-window';
import {
  dayIndexIn,
  monthFocusRow,
  monthKeyOf,
  monthMask,
  sampledRow,
  weekDays,
  windowWeekStarts,
} from '../../lib/calendar-month-scroll';
import { useCalendarLocale } from '../../lib/calendar-locale';
import {
  MONTH_ROW_HEIGHT,
  MONTH_ROW_HEIGHT_CHIPS,
  MonthWeekRow,
  MonthWeekdayHeader,
  useMonthStyles,
} from './MonthView';

type WeekStart = 0 | 1 | 6;

/** Rows the month viewport shows, as one month grid used to. */
const VISIBLE_ROWS = 6;
/** Navigation closer than this many rows scrolls smoothly; further jumps. */
const SMOOTH_SCROLL_ROWS = 12;

interface MonthScrollViewProps {
  /** The day the user navigated to; its month's first week is scrolled to the top. */
  focus: CalendarFocus;
  /** The loaded window: whole weeks, one row each. */
  window: DayRange;
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  eventsByDay?: EventDayIndex;
  weekStartsOn?: WeekStart;
  showWeekNumbers?: boolean;
  showTimeInMonthView?: boolean;
  timeFormat?: TimeFormat;
  /** Widen the window at the top; omitted once the limit is reached. */
  onExtendStart?: () => void;
  /** Widen the window at the bottom; omitted once the limit is reached. */
  onExtendEnd?: () => void;
  /** Reports a day of the month in view whenever that month changes. */
  onVisibleDateChange?: (date: Date) => void;
  onSelectDate: (date: Date) => void;
  onLongPressDate?: (date: Date) => void;
}

/**
 * Freely scrolling month (#759, webmail 15a5497a): the window's weeks as one
 * continuous list of fixed-height rows. The month under the upper part of
 * the viewport is the one in focus: its days are drawn at full strength,
 * the title follows it, and the first of every month carries its name.
 * Reaching either end widens the window; rows added above keep what is on
 * screen in place. The screen remounts the list (keyed by the window) when
 * navigation starts a fresh window.
 */
function MonthScrollViewInner({
  focus,
  window,
  selectedDate,
  events,
  calendars,
  eventsByDay,
  weekStartsOn = 0,
  showWeekNumbers = false,
  showTimeInMonthView = false,
  timeFormat,
  onExtendStart,
  onExtendEnd,
  onVisibleDateChange,
  onSelectDate,
  onLongPressDate,
}: MonthScrollViewProps) {
  const styles = useMonthStyles();
  const { locale } = useCalendarLocale();
  const index = React.useMemo(
    () => eventsByDay ?? buildEventDayIndex(events),
    [eventsByDay, events],
  );
  const opts = React.useMemo(() => ({ weekStartsOn }), [weekStartsOn]);

  // One row per week of the window. A week keeps its array across window
  // changes, so growing the window doesn't re-render the rows already there.
  const weekCacheRef = React.useRef(new Map<string, Date[]>());
  const weeks = React.useMemo(() => {
    const previous = weekCacheRef.current;
    const next = new Map<string, Date[]>();
    const out = windowWeekStarts(window).map((start) => {
      const key = dayKey(start);
      const days = previous.get(key) ?? weekDays(start);
      next.set(key, days);
      return days;
    });
    weekCacheRef.current = next;
    return out;
  }, [window]);
  const weeksRef = React.useRef(weeks);
  weeksRef.current = weeks;
  const rowHeight = showTimeInMonthView ? MONTH_ROW_HEIGHT_CHIPS : MONTH_ROW_HEIGHT;
  const viewportHeight = rowHeight * VISIBLE_ROWS;

  // The month in focus: set by navigation, then by what scrolls under the
  // sample line.
  const [activeMonth, setActiveMonth] = React.useState(() => monthKeyOf(focus.date));
  const activeMonthRef = React.useRef(activeMonth);
  const onVisibleRef = React.useRef(onVisibleDateChange);
  onVisibleRef.current = onVisibleDateChange;
  const offsetRef = React.useRef(0);
  // Row at the top of the viewport; a change of row height (the "show time"
  // setting) remounts the list there.
  const topRowRef = React.useRef<number | null>(null);

  const handleScroll = React.useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = e.nativeEvent.contentOffset.y;
      offsetRef.current = offset;
      topRowRef.current = Math.round(offset / rowHeight);
      const list = weeksRef.current;
      const row = sampledRow(offset, viewportHeight, rowHeight, list.length);
      const days = list[row];
      if (!days) return;
      // Mid-week decides which month a row belongs to.
      const mid = days[3];
      const key = monthKeyOf(mid);
      if (key === activeMonthRef.current) return;
      activeMonthRef.current = key;
      setActiveMonth(key);
      onVisibleRef.current?.(mid);
    },
    [viewportHeight, rowHeight],
  );

  // Navigation inside the window scrolls the focused month's first week to
  // the top. The list mounts there already, so its own nonce needs nothing.
  const listRef = React.useRef<FlatList<Date[]>>(null);
  const handledNonceRef = React.useRef(focus.nonce);
  const initialRef = React.useRef<{ rowHeight: number; row: number } | null>(null);
  if (initialRef.current === null || initialRef.current.rowHeight !== rowHeight) {
    initialRef.current = {
      rowHeight,
      row: topRowRef.current ?? monthFocusRow(window, focus.date, weeks.length, opts),
    };
  }
  React.useEffect(() => {
    if (handledNonceRef.current === focus.nonce) return;
    handledNonceRef.current = focus.nonce;
    const row = monthFocusRow(window, focus.date, weeks.length, opts);
    const currentRow = Math.round(offsetRef.current / rowHeight);
    const key = monthKeyOf(focus.date);
    activeMonthRef.current = key;
    setActiveMonth(key);
    listRef.current?.scrollToIndex({
      index: row,
      animated: Math.abs(row - currentRow) <= SMOOTH_SCROLL_ROWS,
    });
  }, [focus, window, weeks.length, opts, rowHeight]);

  const selectedKey = dayKey(selectedDate);
  const todayKey = dayKey(new Date());

  const renderItem = React.useCallback(
    ({ item: days }: ListRenderItemInfo<Date[]>) => {
      return (
        <MonthWeekRow
          days={days}
          activeMask={monthMask(days, activeMonth)}
          selectedIndex={dayIndexIn(days, selectedDate)}
          todayIndex={dayIndexIn(days, new Date())}
          index={index}
          calendars={calendars}
          weekStartsOn={weekStartsOn}
          showWeekNumbers={showWeekNumbers}
          showTimeInMonthView={showTimeInMonthView}
          timeFormat={timeFormat}
          labelMonths
          height={rowHeight}
          locale={locale}
          styles={styles}
          onSelectDate={onSelectDate}
          onLongPressDate={onLongPressDate}
        />
      );
    },
    [
      activeMonth,
      selectedDate,
      index,
      calendars,
      weekStartsOn,
      showWeekNumbers,
      showTimeInMonthView,
      timeFormat,
      rowHeight,
      locale,
      styles,
      onSelectDate,
      onLongPressDate,
    ],
  );

  const getItemLayout = React.useCallback(
    (_: ArrayLike<Date[]> | null | undefined, i: number) => ({
      length: rowHeight,
      offset: rowHeight * i,
      index: i,
    }),
    [rowHeight],
  );

  return (
    <View style={styles.grid}>
      <MonthWeekdayHeader weekStartsOn={weekStartsOn} showWeekNumbers={showWeekNumbers} styles={styles} />
      <FlatList
        key={rowHeight}
        ref={listRef}
        style={{ height: viewportHeight }}
        data={weeks}
        keyExtractor={weekKey}
        renderItem={renderItem}
        extraData={`${activeMonth}|${selectedKey}|${todayKey}`}
        getItemLayout={getItemLayout}
        initialScrollIndex={Math.min(initialRef.current.row, weeks.length - 1)}
        // Weeks added above keep the rows on screen where they are.
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        // Half the grid: the window opens with a month of room either side,
        // so this doesn't fire while the list settles on the focus.
        onStartReached={onExtendStart}
        onStartReachedThreshold={0.5}
        onEndReached={onExtendEnd}
        onEndReachedThreshold={0.5}
        onScroll={handleScroll}
        scrollEventThrottle={32}
        snapToInterval={rowHeight}
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        initialNumToRender={VISIBLE_ROWS + 2}
        maxToRenderPerBatch={VISIBLE_ROWS}
        windowSize={5}
      />
    </View>
  );
}

export const MonthScrollView = React.memo(MonthScrollViewInner);

function weekKey(days: Date[]): string {
  return dayKey(days[0]);
}
