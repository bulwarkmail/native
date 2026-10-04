import React from 'react';
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type FlatList,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewToken,
} from 'react-native';
import { differenceInCalendarDays, format, startOfWeek, type Locale } from 'date-fns';
import type { Calendar, CalendarEvent } from '../../api/types';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useCalendarLocale } from '../../lib/calendar-locale';
import {
  buildEventDayIndex,
  dayKey,
  eventsOnDayFromIndex,
  getEventColor,
  isTimedEventFullDayOnDate,
  layoutOverlappingEvents,
  packWeekSegments,
  type CalendarWeekSegment,
  type EventDayIndex,
  type TimedEventLayout,
} from '../../lib/calendar-utils';
import type { CalendarFocus, DayRange } from '../../lib/calendar-scroll-window';
import { displayNow, displayNowMinutes } from '../../lib/calendar-timezone';
import { useSettingsStore } from '../../stores/settings-store';
import {
  displayGridHeight,
  eventRect,
  indexOfDayOnOrAfter,
  minutesToY,
  partitionByDisplayHours,
  remapSegmentsToShownDays,
  resolveWorkingDays,
  type DisplayHours,
  type DisplayHoursPartition,
} from '../../lib/calendar-display-range';
import { isInactiveEvent } from '../../lib/calendar-participants';
import { eventBlockColors } from '../../lib/event-colors';
import {
  buildAllDaySegments,
  headerColumnRange,
  hourAtOffset,
  timeGridFocusColumn,
  windowDays,
  type TimeGridMode,
} from '../../lib/calendar-time-grid';
import { AllDayEventBar, TIME_LINE_MIN_MINUTES, TimedEventBlock } from './EventBlock';
import { allDayRowCounts, allDayStripLayout } from '../../lib/calendar-all-day';
import { AllDayToggle, AllHoursToggle, HiddenEventsIndicator } from './DisplayHoursControls';
import { useDisplayHours } from './use-display-hours';

const HOUR_HEIGHT = 48;
const GUTTER_WIDTH = 44;
const HEADER_HEIGHT = 60;
const ALL_DAY_CHIP_HEIGHT = 18;
const ALL_DAY_GAP = 2;
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 50 };
const KEEP_VISIBLE_CONTENT = { minIndexForVisible: 0 };

type WeekStart = 0 | 1 | 6;
type TimeFormat = '12h' | '24h';

interface TimeGridScrollViewProps {
  mode: TimeGridMode;
  /** The day the user navigated to; its week (week view) or itself (day view) is scrolled into view. */
  focus: CalendarFocus;
  /** The loaded window: one column per day. */
  window: DayRange;
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  eventsByDay?: EventDayIndex;
  weekStartsOn?: WeekStart;
  timeFormat?: TimeFormat;
  /** The user's addresses, to draw events they declined as inactive. */
  currentUserEmails?: string[];
  /** Widen the window at the start; omitted once the limit is reached. */
  onExtendStart?: () => void;
  /** Widen the window at the end; omitted once the limit is reached. */
  onExtendEnd?: () => void;
  /** Reports the first day in view as the user scrolls. */
  onVisibleDateChange?: (date: Date) => void;
  onSelectDate?: (date: Date) => void;
  onSelectEvent?: (event: CalendarEvent) => void;
  onCreateAtTime?: (date: Date) => void;
}

/**
 * Freely scrolling week and day grids (#759, webmail 15a5497a): one column
 * per day of the window in a horizontal list that snaps to whole days
 * (seven on screen in the week view, one in the day view), inside one
 * vertical scroller for the hours. The day headers and the all-day strip
 * sit above it and follow the sideways scroll on the native thread.
 * Reaching either end widens the window; columns added at the start keep
 * the ones on screen in place. The screen remounts the grid (keyed by the
 * window) when navigation starts a fresh window.
 */
function TimeGridScrollViewBody({
  mode,
  focus,
  window,
  selectedDate,
  events,
  calendars,
  eventsByDay,
  weekStartsOn = 0,
  timeFormat = '24h',
  currentUserEmails,
  onExtendStart,
  onExtendEnd,
  onVisibleDateChange,
  onSelectDate,
  onSelectEvent,
  onCreateAtTime,
}: TimeGridScrollViewProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const { locale, t } = useCalendarLocale();
  const index = React.useMemo(
    () => eventsByDay ?? buildEventDayIndex(events),
    [eventsByDay, events],
  );

  // The non-working days the week grid leaves out (never in the day grid).
  const hideNonWorkingDays = useSettingsStore((s) => s.calendarHideNonWorkingDays);
  const workingDaysSetting = useSettingsStore((s) => s.calendarWorkingDays);
  const workingDays = React.useMemo(
    () => (mode === 'week' ? resolveWorkingDays(hideNonWorkingDays, workingDaysSetting) : null),
    [mode, hideNonWorkingDays, workingDaysSetting],
  );
  const perScreen = mode === 'week' ? (workingDays ? workingDays.size : 7) : 1;
  const { width: screenWidth } = useWindowDimensions();
  const [rootWidth, setRootWidth] = React.useState(screenWidth);
  const listWidth = Math.max(perScreen, rootWidth - GUTTER_WIDTH);
  const colWidth = listWidth / perScreen;
  const handleRootLayout = React.useCallback((e: LayoutChangeEvent) => {
    const width = e.nativeEvent.layout.width;
    if (width > 0) setRootWidth(width);
  }, []);

  // One column per day of the window. A day keeps its Date across window
  // changes so growing the window doesn't re-render the columns already
  // there.
  const dayCacheRef = React.useRef(new Map<string, Date>());
  const allDays = React.useMemo(() => {
    const previous = dayCacheRef.current;
    const next = new Map<string, Date>();
    const out = windowDays(window).map((day) => {
      const key = dayKey(day);
      const kept = previous.get(key) ?? day;
      next.set(key, kept);
      return kept;
    });
    dayCacheRef.current = next;
    return out;
  }, [window]);
  // The columns drawn: every day, or the working days. `shownIndexByDay[i]`
  // is the column of `allDays[i]`, or -1 for a day left out; null when all
  // are drawn.
  const { days, shownIndexByDay } = React.useMemo(() => {
    if (!workingDays) return { days: allDays, shownIndexByDay: null };
    const shown: Date[] = [];
    const indices = allDays.map((day) => {
      if (!workingDays.has(day.getDay())) return -1;
      shown.push(day);
      return shown.length - 1;
    });
    return shown.length > 0 ? { days: shown, shownIndexByDay: indices } : { days: allDays, shownIndexByDay: null };
  }, [allDays, workingDays]);
  // The column holding `day`, or the next one when that day is left out.
  const columnOf = React.useCallback(
    (day: Date) => shownIndexByDay
      ? indexOfDayOnOrAfter(days, day)
      : Math.max(0, Math.min(days.length - 1, differenceInCalendarDays(day, window.start))),
    [shownIndexByDay, days, window.start],
  );
  const columnOfRef = React.useRef(columnOf);
  columnOfRef.current = columnOf;
  // The column navigation aligns with the start of the viewport.
  const focusColumn = (date: Date) => shownIndexByDay
    ? indexOfDayOnOrAfter(days, startOfWeek(date, { weekStartsOn }))
    : timeGridFocusColumn(window, date, mode, weekStartsOn, days.length);
  const daysRef = React.useRef(days);
  daysRef.current = days;

  // The vertical scroller and the hours it draws (the working hours, or the
  // whole day on request).
  const vScrollRef = React.useRef<ScrollView>(null);
  const { hours, configured, canToggle, showAllHours, toggleAllHours, revealMinutes, onScroll: onVScroll } =
    useDisplayHours(vScrollRef, HOUR_HEIGHT);
  const gridHeight = displayGridHeight(hours, HOUR_HEIGHT);
  const firstHour = hours.startMinutes / 60;
  const gridHours = React.useMemo(
    () => Array.from({ length: (hours.endMinutes - hours.startMinutes) / 60 }, (_, i) => firstHour + i),
    [hours, firstHour],
  );

  // Timed layouts per day, computed when a column first renders and kept
  // until the events or the hours change. Events outside the hours are
  // counted, not laid out.
  // (A new day index means new events: start an empty cache.)
  const layoutCache = React.useMemo(
    () => new Map<string, DayLayout>(),
    [index, hours],
  );
  const layoutsFor = React.useCallback(
    (day: Date) => {
      const key = dayKey(day);
      let layout = layoutCache.get(key);
      if (!layout) {
        const timed = eventsOnDayFromIndex(index, day).filter(
          (e) => !e.showWithoutTime && !isTimedEventFullDayOnDate(e, day),
        );
        const partition = partitionByDisplayHours(timed, day, hours);
        layout = { ...partition, layouts: layoutOverlappingEvents(partition.visible, day) };
        layoutCache.set(key, layout);
      }
      return layout;
    },
    [index, hours, layoutCache],
  );

  // All-day bars over the whole window (cut per week, or per day in the day
  // view), so the strip keeps one height while scrolling.
  const allDaySegments = React.useMemo<CalendarWeekSegment[]>(() => {
    if (!shownIndexByDay) return buildAllDaySegments(index, allDays, perScreen);
    // Cut per calendar week, then moved onto the columns that are drawn.
    return packWeekSegments(remapSegmentsToShownDays(buildAllDaySegments(index, allDays, 7), shownIndexByDay));
  }, [index, allDays, perScreen, shownIndexByDay]);
  // The first column in view. Kept as a day so columns added at the start
  // don't move it.
  const [initialColumn] = React.useState(() =>
    focusColumn(focus.date),
  );
  const firstDayRef = React.useRef<Date>(days[initialColumn] ?? window.start);
  const [headerAnchor, setHeaderAnchor] = React.useState<Date>(firstDayRef.current);
  const headerAnchorRef = React.useRef(headerAnchor);

  // Capped at a few rows; the toggle expands it. Sized from the columns on
  // screen (the settled anchor), as webmail does, so a crowded day elsewhere
  // in the window does not touch a quiet week.
  const [allDayExpanded, setAllDayExpanded] = React.useState(false);
  const firstOnScreen = columnOf(headerAnchor);
  const allDayLayout = React.useMemo(
    () =>
      allDayStripLayout(
        allDayRowCounts(allDaySegments, firstOnScreen, Math.min(days.length, firstOnScreen + perScreen)),
        allDayExpanded,
      ),
    [allDaySegments, firstOnScreen, perScreen, days.length, allDayExpanded],
  );
  const allDayRows = allDayLayout.visibleRows;
  const allDayHeight = allDayRows > 0 ? allDayRows * (ALL_DAY_CHIP_HEIGHT + ALL_DAY_GAP) + spacing.xs : 0;

  const scrollX = React.useRef(new Animated.Value(0)).current;
  const headerTranslate = React.useMemo(() => Animated.multiply(scrollX, -1), [scrollX]);
  const colWidthRef = React.useRef(colWidth);
  colWidthRef.current = colWidth;
  // Last sideways offset the list reported.
  const offsetXRef = React.useRef(0);

  // Days added at the start shift the header cells right as soon as they
  // render; maintainVisibleContentPosition shifts the list by the same
  // amount natively. Move the header along now instead of waiting for the
  // list's scroll event, which may come a frame later (or, at rest, not
  // before the next scroll).
  const firstColumnDayRef = React.useRef(days[0]);
  React.useLayoutEffect(() => {
    const added = days.length > 0 ? columnOfRef.current(firstColumnDayRef.current) : 0;
    firstColumnDayRef.current = days[0];
    if (added <= 0) return;
    offsetXRef.current += added * colWidthRef.current;
    scrollX.setValue(offsetXRef.current);
  }, [days, scrollX]);
  const handleScroll = React.useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], {
        useNativeDriver: true,
        listener: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
          const list = daysRef.current;
          offsetXRef.current = e.nativeEvent.contentOffset.x;
          const col = Math.max(
            0,
            Math.min(list.length - 1, Math.round(e.nativeEvent.contentOffset.x / colWidthRef.current)),
          );
          const day = list[col];
          if (!day) return;
          firstDayRef.current = day;
          // Redraw the header cells once the view moved a screen away.
          const moved = Math.abs(columnOfRef.current(day) - columnOfRef.current(headerAnchorRef.current));
          if (moved >= perScreen) {
            headerAnchorRef.current = day;
            setHeaderAnchor(day);
          }
        },
      }),
    [scrollX, perScreen],
  );

  // The day at the start of the viewport drives the title.
  const visibleHandlerRef = React.useRef(onVisibleDateChange);
  visibleHandlerRef.current = onVisibleDateChange;
  const lastVisibleKeyRef = React.useRef<string | null>(null);
  const onViewableItemsChanged = React.useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    let first: Date | null = null;
    for (const token of viewableItems) {
      const day = token.item as Date;
      if (!first || day < first) first = day;
    }
    if (!first) return;
    const key = dayKey(first);
    if (key === lastVisibleKeyRef.current) return;
    lastVisibleKeyRef.current = key;
    visibleHandlerRef.current?.(first);
  }).current;

  // Navigation inside the window scrolls its week / day to the start. The
  // grid mounts there already, so its own nonce needs nothing.
  const listRef = React.useRef<FlatList<Date>>(null);
  const handledNonceRef = React.useRef(focus.nonce);
  React.useEffect(() => {
    if (handledNonceRef.current === focus.nonce) return;
    handledNonceRef.current = focus.nonce;
    const target = focusColumn(focus.date);
    const current = columnOf(firstDayRef.current);
    listRef.current?.scrollToIndex({
      index: target,
      animated: Math.abs(target - current) <= perScreen * 2,
    });
  }, [focus, window, mode, weekStartsOn, days.length, perScreen]);

  // The now-line and "today" follow a clock in the calendar's time zone.
  const [nowMinutes, setNowMinutes] = React.useState(displayNowMinutes);
  React.useEffect(() => {
    const interval = setInterval(() => {
      setNowMinutes(displayNowMinutes());
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  const handleLongPressAt = React.useCallback(
    (day: Date, hour: number) => {
      if (!onCreateAtTime) return;
      // A display date (that hour in the calendar's zone); the editor turns
      // it into the real instant when it saves (eventTimeFieldsToSave).
      const date = new Date(day);
      date.setHours(hour, 0, 0, 0);
      onCreateAtTime(date);
    },
    [onCreateAtTime],
  );

  const todayKey = dayKey(displayNow());
  const renderItem = React.useCallback(
    ({ item: day }: ListRenderItemInfo<Date>) => (
      <DayColumn
        day={day}
        layout={layoutsFor(day)}
        hours={hours}
        gridHeight={gridHeight}
        onReveal={revealMinutes}
        width={colWidth}
        nowMinutes={dayKey(day) === todayKey ? nowMinutes : -1}
        calendars={calendars}
        timeFormat={timeFormat}
        currentUserEmails={currentUserEmails}
        colors={c}
        styles={styles}
        onSelectEvent={onSelectEvent}
        onLongPressAt={onCreateAtTime ? handleLongPressAt : undefined}
      />
    ),
    [
      layoutsFor, hours, gridHeight, revealMinutes, colWidth, todayKey, nowMinutes, calendars, timeFormat, currentUserEmails, c, styles,
      onSelectEvent, onCreateAtTime, handleLongPressAt,
    ],
  );

  const getItemLayout = React.useCallback(
    (_: ArrayLike<Date> | null | undefined, i: number) => ({ length: colWidth, offset: colWidth * i, index: i }),
    [colWidth],
  );

  // Header cells and all-day bars for the columns around the viewport.
  const anchorIndex = columnOf(headerAnchor);
  const { from, to } = headerColumnRange(anchorIndex, perScreen, days.length);
  const selectedKey = dayKey(selectedDate);
  const headerCells: React.ReactNode[] = [];
  for (let i = from; i <= to; i++) {
    const day = days[i];
    const key = dayKey(day);
    headerCells.push(
      <DayHeaderCell
        key={key}
        day={day}
        left={i * colWidth}
        width={colWidth}
        today={key === todayKey}
        selected={key === selectedKey}
        wide={perScreen === 1}
        locale={locale}
        styles={styles}
        onPress={onSelectDate}
      />,
    );
  }
  const visibleSegments = allDaySegments.filter(
    (s) => s.row < allDayRows && s.startIndex <= to && s.startIndex + s.span - 1 >= from,
  );

  const threshold = perScreen === 1 ? 3 : 1;
  const scrollable = days.length > perScreen || !!onExtendStart || !!onExtendEnd;
  // A new column width (rotation, split screen) remounts the list at the
  // day that was at the start.
  const listKey = Math.round(colWidth * 100);
  const initialIndexRef = React.useRef<{ key: number; index: number } | null>(null);
  if (initialIndexRef.current === null || initialIndexRef.current.key !== listKey) {
    initialIndexRef.current = {
      key: listKey,
      index: columnOf(firstDayRef.current),
    };
  }
  const listStyle = React.useMemo(() => ({ width: listWidth, height: gridHeight }), [listWidth, gridHeight]);

  return (
    <View style={styles.container} onLayout={handleRootLayout}>
      <View style={styles.headerRow}>
        <View style={styles.gutter}>
          <View style={{ height: HEADER_HEIGHT, justifyContent: 'flex-end' }}>
            {canToggle && (
              <AllHoursToggle
                showAllHours={showAllHours}
                configured={configured}
                timeFormat={timeFormat}
                onToggle={toggleAllHours}
              />
            )}
          </View>
          {allDayHeight > 0 && (
            <View style={[styles.allDayLabelWrap, { height: allDayHeight }]}>
              {allDayLayout.expandable ? (
                <AllDayToggle
                  expanded={allDayExpanded}
                  hiddenCount={allDayLayout.hiddenCount}
                  onToggle={() => setAllDayExpanded((v) => !v)}
                />
              ) : (
                <Text style={styles.allDayLabel} numberOfLines={2}>
                  {t('calendar.events.all_day', 'All day')}
                </Text>
              )}
            </View>
          )}
        </View>
        <View style={[styles.headerClip, { width: listWidth, height: HEADER_HEIGHT + allDayHeight }]}>
          <Animated.View
            style={[
              styles.headerStrip,
              { width: days.length * colWidth, transform: [{ translateX: headerTranslate }] },
            ]}
          >
            {headerCells}
            {visibleSegments.map((segment) => (
              <AllDayEventBar
                key={`${segment.event.id}:${segment.startIndex}:${segment.row}`}
                title={segment.event.title || t('calendar.events.no_title', '(No title)')}
                colors={eventBlockColors(
                  getEventColor(segment.event, calendars),
                  isInactiveEvent(segment.event, currentUserEmails),
                  c,
                )}
                continuesBefore={segment.continuesBefore}
                continuesAfter={segment.continuesAfter}
                onPress={() => onSelectEvent?.(segment.event)}
                style={{
                  left: segment.startIndex * colWidth + 1,
                  width: segment.span * colWidth - 2,
                  top: HEADER_HEIGHT + 2 + segment.row * (ALL_DAY_CHIP_HEIGHT + ALL_DAY_GAP),
                  height: ALL_DAY_CHIP_HEIGHT,
                }}
              />
            ))}
          </Animated.View>
        </View>
      </View>

      <ScrollView
        ref={vScrollRef}
        style={styles.vScroll}
        showsVerticalScrollIndicator={false}
        onScroll={onVScroll}
        scrollEventThrottle={16}
      >
        <View style={[styles.gridRow, { height: gridHeight }]}>
          <View style={styles.gutter}>
            {gridHours.map((h) => (
              <View key={h} style={styles.hourLabelCell}>
                {h > firstHour && (
                  <Text style={styles.hourLabel}>
                    {timeFormat === '12h'
                      ? `${(h % 12) || 12} ${h < 12 ? 'AM' : 'PM'}`
                      : `${h.toString().padStart(2, '0')}:00`}
                  </Text>
                )}
              </View>
            ))}
          </View>
          <View style={{ width: listWidth, height: gridHeight }}>
            <View style={StyleSheet.absoluteFill} pointerEvents="none">
              {gridHours.map((h) => (
                <View key={h} style={[styles.hourLine, { top: minutesToY((h + 1) * 60, hours, HOUR_HEIGHT) - 1 }]} />
              ))}
            </View>
            <Animated.FlatList
              key={listKey}
              ref={listRef}
              horizontal
              data={days}
              keyExtractor={dayKey}
              renderItem={renderItem}
              getItemLayout={getItemLayout}
              initialScrollIndex={initialIndexRef.current.index}
              // Days added at the start keep the columns on screen in place.
              maintainVisibleContentPosition={KEEP_VISIBLE_CONTENT}
              onStartReached={onExtendStart}
              onStartReachedThreshold={threshold}
              onEndReached={onExtendEnd}
              onEndReachedThreshold={threshold}
              onScroll={handleScroll}
              scrollEventThrottle={16}
              snapToInterval={colWidth}
              decelerationRate="fast"
              disableIntervalMomentum={perScreen === 1}
              scrollEnabled={scrollable}
              showsHorizontalScrollIndicator={false}
              onViewableItemsChanged={onViewableItemsChanged}
              viewabilityConfig={VIEWABILITY_CONFIG}
              initialNumToRender={perScreen + 2}
              maxToRenderPerBatch={perScreen + 1}
              windowSize={perScreen === 1 ? 5 : 3}
              style={listStyle}
            />
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * The week grid leaves out the non-working days when the user asked for it.
 * Its columns are built once from the window, so a change to that setting
 * starts the grid afresh.
 */
function TimeGridScrollViewInner(props: TimeGridScrollViewProps) {
  const hide = useSettingsStore((s) => s.calendarHideNonWorkingDays);
  const workingDays = useSettingsStore((s) => s.calendarWorkingDays);
  const columnsKey = props.mode === 'week' && hide ? workingDays.join(',') : 'all';
  return <TimeGridScrollViewBody key={columnsKey} {...props} />;
}

export const TimeGridScrollView = React.memo(TimeGridScrollViewInner);

type GridStyles = ReturnType<typeof makeStyles>;

const DayHeaderCell = React.memo(function DayHeaderCell({
  day,
  left,
  width,
  today,
  selected,
  wide,
  locale,
  styles,
  onPress,
}: {
  day: Date;
  left: number;
  width: number;
  today: boolean;
  selected: boolean;
  wide: boolean;
  locale: Locale;
  styles: GridStyles;
  onPress?: (date: Date) => void;
}) {
  return (
    <Pressable style={[styles.dayHeaderCell, { left, width }]} onPress={() => onPress?.(day)}>
      <Text style={styles.dayHeaderWeekday} numberOfLines={1}>
        {format(day, wide ? 'EEEE' : 'EEE', { locale })}
      </Text>
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
});

type DayLayout = DisplayHoursPartition & { layouts: TimedEventLayout[] };

const DayColumn = React.memo(function DayColumn({
  day,
  layout,
  hours,
  gridHeight,
  onReveal,
  width,
  nowMinutes,
  calendars,
  timeFormat,
  currentUserEmails,
  colors,
  styles,
  onSelectEvent,
  onLongPressAt,
}: {
  day: Date;
  layout: DayLayout;
  /** The hours the grid draws. */
  hours: DisplayHours;
  gridHeight: number;
  /** Shows the whole day at a minute from midnight. */
  onReveal: (minutes: number) => void;
  width: number;
  /** Minutes since midnight for today's column, -1 for the others. */
  nowMinutes: number;
  calendars: Calendar[];
  timeFormat: TimeFormat;
  currentUserEmails?: string[];
  colors: ThemePalette;
  styles: GridStyles;
  onSelectEvent?: (event: CalendarEvent) => void;
  onLongPressAt?: (day: Date, hour: number) => void;
}) {
  const { t } = useCalendarLocale();
  const handleLongPress = React.useCallback(
    (e: GestureResponderEvent) => {
      onLongPressAt?.(day, hourAtOffset(e.nativeEvent.locationY, HOUR_HEIGHT, hours));
    },
    [onLongPressAt, day, hours],
  );
  return (
    <Pressable
      style={[styles.dayCol, { width, height: gridHeight }]}
      onLongPress={onLongPressAt ? handleLongPress : undefined}
    >
      {layout.before > 0 && (
        <HiddenEventsIndicator
          count={layout.before}
          direction="before"
          onReveal={() => onReveal(layout.firstBeforeMinutes ?? hours.startMinutes)}
        />
      )}
      {layout.after > 0 && (
        <HiddenEventsIndicator
          count={layout.after}
          direction="after"
          onReveal={() => onReveal(layout.firstAfterMinutes ?? hours.endMinutes)}
        />
      )}
      {layout.layouts.map(({ event, column, totalColumns, startMinutes, endMinutes, continuesBefore, continuesAfter }) => {
        const { top, height, clippedStart, clippedEnd } = eventRect(startMinutes, endMinutes, hours, HOUR_HEIGHT);
        const widthPct = 100 / totalColumns;
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
              colors,
            )}
            ringColor={colors.background}
            continuesBefore={continuesBefore || clippedStart}
            continuesAfter={continuesAfter || clippedEnd}
            onPress={() => onSelectEvent?.(event)}
            style={{ top, height, left: `${column * widthPct}%`, width: `${widthPct}%` }}
          />
        );
      })}
      {nowMinutes >= hours.startMinutes && nowMinutes < hours.endMinutes && (
        <View pointerEvents="none" style={[styles.nowLine, { top: minutesToY(nowMinutes, hours, HOUR_HEIGHT) }]}>
          <View style={styles.nowDot} />
          <View style={styles.nowBar} />
        </View>
      )}
    </Pressable>
  );
});

// Event-block start label; honours the 12h/24h setting like the gutter does.
function minutesToTimeLabel(minutes: number, timeFormat: TimeFormat): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const mm = m.toString().padStart(2, '0');
  if (timeFormat === '12h') {
    return `${(h % 12) || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
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
  headerClip: { overflow: 'hidden' },
  headerStrip: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  dayHeaderCell: {
    position: 'absolute',
    top: 0,
    height: HEADER_HEIGHT,
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

  allDayLabelWrap: { alignItems: 'flex-end', justifyContent: 'flex-start', paddingRight: 4, paddingTop: 2 },
  allDayLabel: { ...typography.small, color: c.textMuted, textAlign: 'right' },

  vScroll: { flex: 1 },
  gridRow: { flexDirection: 'row' },
  hourLabelCell: { height: HOUR_HEIGHT, paddingRight: 4, alignItems: 'flex-end' },
  hourLabel: {
    ...typography.small,
    color: c.textMuted,
    transform: [{ translateY: -6 }],
  },
  hourLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: c.borderLight,
  },
  dayCol: {
    borderLeftWidth: 1,
    borderLeftColor: c.border,
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
