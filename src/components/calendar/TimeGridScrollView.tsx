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
import { differenceInCalendarDays, format, type Locale } from 'date-fns';
import type { Calendar, CalendarEvent } from '../../api/types';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useCalendarLocale } from '../../lib/calendar-locale';
import {
  buildEventDayIndex,
  dayKey,
  eventsOnDayFromIndex,
  getEventColor,
  isTimedEventFullDayOnDate,
  layoutOverlappingEvents,
  type CalendarWeekSegment,
  type EventDayIndex,
  type TimedEventLayout,
} from '../../lib/calendar-utils';
import type { CalendarFocus, DayRange } from '../../lib/calendar-scroll-window';
import { displayNow, displayNowMinutes } from '../../lib/calendar-timezone';
import {
  buildAllDaySegments,
  headerColumnRange,
  hourAtOffset,
  timeGridFocusColumn,
  windowDays,
  type TimeGridMode,
} from '../../lib/calendar-time-grid';

const HOUR_HEIGHT = 48;
const GRID_HEIGHT = 24 * HOUR_HEIGHT;
const GUTTER_WIDTH = 44;
const HEADER_HEIGHT = 60;
const ALL_DAY_CHIP_HEIGHT = 18;
const ALL_DAY_GAP = 2;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
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
function TimeGridScrollViewInner({
  mode,
  focus,
  window,
  selectedDate,
  events,
  calendars,
  eventsByDay,
  weekStartsOn = 0,
  timeFormat = '24h',
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

  const perScreen = mode === 'week' ? 7 : 1;
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
  const days = React.useMemo(() => {
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
  const daysRef = React.useRef(days);
  daysRef.current = days;

  // Timed layouts per day, computed when a column first renders and kept
  // until the events change.
  // (A new day index means new events: start an empty cache.)
  const layoutCache = React.useMemo(() => new Map<string, TimedEventLayout[]>(), [index]);
  const layoutsFor = React.useCallback(
    (day: Date) => {
      const key = dayKey(day);
      let layouts = layoutCache.get(key);
      if (!layouts) {
        const timed = eventsOnDayFromIndex(index, day).filter(
          (e) => !e.showWithoutTime && !isTimedEventFullDayOnDate(e, day),
        );
        layouts = layoutOverlappingEvents(timed, day);
        layoutCache.set(key, layouts);
      }
      return layouts;
    },
    [index, layoutCache],
  );

  // All-day bars over the whole window (cut per week, or per day in the day
  // view), so the strip keeps one height while scrolling.
  const allDaySegments = React.useMemo<CalendarWeekSegment[]>(
    () => buildAllDaySegments(index, days, perScreen),
    [index, days, perScreen],
  );
  const allDayRows = React.useMemo(
    () => allDaySegments.reduce((max, s) => Math.max(max, s.row + 1), 0),
    [allDaySegments],
  );
  const allDayHeight = allDayRows > 0 ? allDayRows * (ALL_DAY_CHIP_HEIGHT + ALL_DAY_GAP) + spacing.xs : 0;

  // The first column in view. Kept as a day so columns added at the start
  // don't move it.
  const [initialColumn] = React.useState(() =>
    timeGridFocusColumn(window, focus.date, mode, weekStartsOn, days.length),
  );
  const firstDayRef = React.useRef<Date>(days[initialColumn] ?? window.start);
  const [headerAnchor, setHeaderAnchor] = React.useState<Date>(firstDayRef.current);
  const headerAnchorRef = React.useRef(headerAnchor);

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
  const windowStartRef = React.useRef(window.start);
  React.useLayoutEffect(() => {
    const added = differenceInCalendarDays(windowStartRef.current, window.start);
    windowStartRef.current = window.start;
    if (added <= 0) return;
    offsetXRef.current += added * colWidthRef.current;
    scrollX.setValue(offsetXRef.current);
  }, [window.start, scrollX]);
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
          const moved = Math.abs(differenceInCalendarDays(day, headerAnchorRef.current));
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
    const target = timeGridFocusColumn(window, focus.date, mode, weekStartsOn, days.length);
    const current = Math.max(0, differenceInCalendarDays(firstDayRef.current, window.start));
    listRef.current?.scrollToIndex({
      index: target,
      animated: Math.abs(target - current) <= perScreen * 2,
    });
  }, [focus, window, mode, weekStartsOn, days.length, perScreen]);

  // Start the hours at the one before now, like the paged week view.
  const vScrollRef = React.useRef<ScrollView>(null);
  React.useEffect(() => {
    const target = Math.max(0, (displayNow().getHours() - 1) * HOUR_HEIGHT);
    const frame = requestAnimationFrame(() => {
      vScrollRef.current?.scrollTo({ y: target, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

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
        layouts={layoutsFor(day)}
        width={colWidth}
        nowMinutes={dayKey(day) === todayKey ? nowMinutes : -1}
        calendars={calendars}
        timeFormat={timeFormat}
        styles={styles}
        onSelectEvent={onSelectEvent}
        onLongPressAt={onCreateAtTime ? handleLongPressAt : undefined}
      />
    ),
    [layoutsFor, colWidth, todayKey, nowMinutes, calendars, timeFormat, styles, onSelectEvent, onCreateAtTime, handleLongPressAt],
  );

  const getItemLayout = React.useCallback(
    (_: ArrayLike<Date> | null | undefined, i: number) => ({ length: colWidth, offset: colWidth * i, index: i }),
    [colWidth],
  );

  // Header cells and all-day bars for the columns around the viewport.
  const anchorIndex = Math.max(0, Math.min(days.length - 1, differenceInCalendarDays(headerAnchor, window.start)));
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
    (s) => s.startIndex <= to && s.startIndex + s.span - 1 >= from,
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
      index: Math.max(
        0,
        Math.min(days.length - 1, differenceInCalendarDays(firstDayRef.current, window.start)),
      ),
    };
  }
  const listStyle = React.useMemo(() => ({ width: listWidth, height: GRID_HEIGHT }), [listWidth]);

  return (
    <View style={styles.container} onLayout={handleRootLayout}>
      <View style={styles.headerRow}>
        <View style={styles.gutter}>
          <View style={{ height: HEADER_HEIGHT }} />
          {allDayHeight > 0 && (
            <View style={[styles.allDayLabelWrap, { height: allDayHeight }]}>
              <Text style={styles.allDayLabel} numberOfLines={2}>
                {t('calendar.events.all_day', 'All day')}
              </Text>
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
            {visibleSegments.map((segment) => {
              const color = getEventColor(segment.event, calendars);
              return (
                <Pressable
                  key={`${segment.event.id}:${segment.startIndex}:${segment.row}`}
                  onPress={() => onSelectEvent?.(segment.event)}
                  style={[
                    styles.allDayChip,
                    {
                      left: segment.startIndex * colWidth + 1,
                      width: segment.span * colWidth - 2,
                      top: HEADER_HEIGHT + 2 + segment.row * (ALL_DAY_CHIP_HEIGHT + ALL_DAY_GAP),
                      backgroundColor: color + '33',
                      borderLeftColor: color,
                      borderTopLeftRadius: segment.continuesBefore ? 0 : radius.xs,
                      borderBottomLeftRadius: segment.continuesBefore ? 0 : radius.xs,
                      borderTopRightRadius: segment.continuesAfter ? 0 : radius.xs,
                      borderBottomRightRadius: segment.continuesAfter ? 0 : radius.xs,
                    },
                  ]}
                >
                  <Text style={styles.allDayChipText} numberOfLines={1}>
                    {segment.continuesBefore ? '… ' : ''}
                    {segment.event.title || t('calendar.events.no_title', '(No title)')}
                  </Text>
                </Pressable>
              );
            })}
          </Animated.View>
        </View>
      </View>

      <ScrollView ref={vScrollRef} style={styles.vScroll} showsVerticalScrollIndicator={false}>
        <View style={styles.gridRow}>
          <View style={styles.gutter}>
            {HOURS.map((h) => (
              <View key={h} style={styles.hourLabelCell}>
                {h > 0 && (
                  <Text style={styles.hourLabel}>
                    {timeFormat === '12h'
                      ? `${(h % 12) || 12} ${h < 12 ? 'AM' : 'PM'}`
                      : `${h.toString().padStart(2, '0')}:00`}
                  </Text>
                )}
              </View>
            ))}
          </View>
          <View style={{ width: listWidth, height: GRID_HEIGHT }}>
            <View style={StyleSheet.absoluteFill} pointerEvents="none">
              {HOURS.map((h) => (
                <View key={h} style={[styles.hourLine, { top: (h + 1) * HOUR_HEIGHT - 1 }]} />
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

const DayColumn = React.memo(function DayColumn({
  day,
  layouts,
  width,
  nowMinutes,
  calendars,
  timeFormat,
  styles,
  onSelectEvent,
  onLongPressAt,
}: {
  day: Date;
  layouts: TimedEventLayout[];
  width: number;
  /** Minutes since midnight for today's column, -1 for the others. */
  nowMinutes: number;
  calendars: Calendar[];
  timeFormat: TimeFormat;
  styles: GridStyles;
  onSelectEvent?: (event: CalendarEvent) => void;
  onLongPressAt?: (day: Date, hour: number) => void;
}) {
  const { t } = useCalendarLocale();
  const handleLongPress = React.useCallback(
    (e: GestureResponderEvent) => {
      onLongPressAt?.(day, hourAtOffset(e.nativeEvent.locationY, HOUR_HEIGHT));
    },
    [onLongPressAt, day],
  );
  return (
    <Pressable
      style={[styles.dayCol, { width }]}
      onLongPress={onLongPressAt ? handleLongPress : undefined}
    >
      {layouts.map(({ event, column, totalColumns, startMinutes, endMinutes }) => {
        const top = (startMinutes / 60) * HOUR_HEIGHT;
        const height = Math.max(20, ((endMinutes - startMinutes) / 60) * HOUR_HEIGHT - 1);
        const widthPct = 100 / totalColumns;
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
                left: `${column * widthPct}%`,
                width: `${widthPct}%`,
                backgroundColor: color + '33',
                borderLeftColor: color,
              },
            ]}
          >
            <Text style={styles.eventBlockTitle} numberOfLines={1}>
              {event.title || t('calendar.events.no_title', '(No title)')}
            </Text>
            {height > 32 && (
              <Text style={styles.eventBlockTime} numberOfLines={1}>
                {minutesToTimeLabel(startMinutes, timeFormat)}
              </Text>
            )}
          </Pressable>
        );
      })}
      {nowMinutes >= 0 && (
        <View pointerEvents="none" style={[styles.nowLine, { top: (nowMinutes / 60) * HOUR_HEIGHT }]}>
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
  allDayChip: {
    position: 'absolute',
    height: ALL_DAY_CHIP_HEIGHT,
    borderLeftWidth: 2,
    paddingHorizontal: 4,
    justifyContent: 'center',
  },
  allDayChipText: { fontSize: 10, color: c.text, fontWeight: '500' },

  vScroll: { flex: 1 },
  gridRow: { flexDirection: 'row', height: GRID_HEIGHT },
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
    height: GRID_HEIGHT,
    borderLeftWidth: 1,
    borderLeftColor: c.border,
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
