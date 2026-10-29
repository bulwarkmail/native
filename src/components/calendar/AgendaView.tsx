import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type ViewToken,
} from 'react-native';
import { endOfWeek, format, startOfWeek, type Locale } from 'date-fns';
import { displayNow, isDisplayToday } from '../../lib/calendar-timezone';
import type { Calendar, CalendarEvent } from '../../api/types';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import {
  buildEventDayIndex,
  dayKey,
  type EventDayIndex,
  type TimeFormat,
} from '../../lib/calendar-utils';
import type { CalendarFocus, DayRange } from '../../lib/calendar-scroll-window';
import { buildAgendaDays, findAgendaFocusIndex, type AgendaDay } from '../../lib/calendar-agenda';
import { useCalendarLocale } from '../../lib/calendar-locale';
import { useLocaleStore } from '../../stores/locale-store';
import { EventCard } from './EventCard';

interface AgendaViewProps {
  /** The day the user navigated to; the list shows the first day at or after it. */
  focus: CalendarFocus;
  events: CalendarEvent[];
  calendars: Calendar[];
  eventsByDay?: EventDayIndex;
  /** The days the agenda covers. */
  window: DayRange;
  /** The part of the window whose events are loaded, or null while none is. */
  loaded: DayRange | null;
  /** Widen the window into the past; omitted once the limit is reached. */
  onExtendStart?: () => void;
  /** Widen the window into the future; omitted once the limit is reached. */
  onExtendEnd?: () => void;
  /** The side an extension is loading, if any. */
  loadingEdge?: 'start' | 'end' | null;
  /** True while events for the window are being fetched. */
  isLoading?: boolean;
  /** Reports the first day in view as the user scrolls. */
  onVisibleDateChange?: (date: Date) => void;
  timeFormat?: TimeFormat;
  weekStartsOn?: 0 | 1 | 6;
  /** The user's addresses, to draw events they declined as inactive. */
  currentUserEmails?: string[];
  onSelectEvent?: (event: CalendarEvent) => void;
  /** Tapping an empty "today" row creates an event on that day. */
  onCreateAt?: (date: Date) => void;
}

interface DaySection extends AgendaDay {
  key: string;
  /** Set on the first day of a month in the list: the month's name. */
  monthTitle: string | null;
  /** Set on the first day of a week in the list: the week's range. */
  weekTitle: string | null;
}

// The week separators: "Oct 11 – 17", or "Sep 27 – Oct 3" across months.
function formatWeekRange(date: Date, weekStartsOn: 0 | 1 | 6, locale: Locale): string {
  const start = startOfWeek(date, { weekStartsOn });
  const end = endOfWeek(date, { weekStartsOn });
  const sameMonth = start.getMonth() === end.getMonth();
  return `${format(start, 'MMM d', { locale })} – ${format(end, sameMonth ? 'd' : 'MMM d', { locale })}`;
}

const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 1 };
const MAX_SCROLL_RETRIES = 3;

/**
 * Infinite agenda (webmail 60e05c00, #759): days with events over a window
 * that grows as the user scrolls. Reaching the end loads further ahead,
 * "Show earlier events" loads the past without moving what is on screen,
 * and navigation ("Today", the arrows) scrolls to its day when it lies in
 * the window. A navigation outside it gets a fresh window; the screen
 * remounts the list for that.
 */
export function AgendaView({
  focus,
  events,
  calendars,
  eventsByDay,
  window,
  loaded,
  onExtendStart,
  onExtendEnd,
  loadingEdge = null,
  isLoading = false,
  onVisibleDateChange,
  timeFormat,
  weekStartsOn = 1,
  currentUserEmails,
  onSelectEvent,
  onCreateAt,
}: AgendaViewProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const { locale, t } = useCalendarLocale();
  const tp = useLocaleStore((s) => s.t);
  const index = React.useMemo(
    () => eventsByDay ?? buildEventDayIndex(events),
    [eventsByDay, events],
  );

  // A heading where a month starts and a separator where a week starts,
  // then the days.
  const sections = React.useMemo<DaySection[]>(() => {
    let lastMonth = '';
    let lastWeek = '';
    return buildAgendaDays(index, loaded, displayNow()).map((day) => {
      const month = format(day.date, 'yyyy-MM');
      const week = dayKey(startOfWeek(day.date, { weekStartsOn }));
      const monthTitle = month !== lastMonth ? format(day.date, 'LLLL yyyy', { locale }) : null;
      const weekTitle = week !== lastWeek ? formatWeekRange(day.date, weekStartsOn, locale) : null;
      lastMonth = month;
      lastWeek = week;
      return { ...day, key: dayKey(day.date), monthTitle, weekTitle };
    });
  }, [index, loaded, weekStartsOn, locale]);

  const listRef = React.useRef<SectionList<CalendarEvent, DaySection>>(null);
  const sectionsRef = React.useRef(sections);
  sectionsRef.current = sections;
  const focusRef = React.useRef(focus);
  focusRef.current = focus;

  // Navigation inside the window scrolls to the first day at or after the
  // focus. The list starts out at the focus already (a fresh window begins
  // there), so the nonce it mounted with needs no scrolling.
  const scrolledNonceRef = React.useRef(focus.nonce);
  const retryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const retriesRef = React.useRef(0);
  const scrollToSection = React.useCallback((sectionIndex: number) => {
    if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    listRef.current?.scrollToLocation({
      sectionIndex,
      itemIndex: 0,
      viewOffset: 0,
      viewPosition: 0,
      animated: false,
    });
  }, []);
  React.useEffect(() => {
    if (scrolledNonceRef.current === focus.nonce || !loaded) return;
    const target = findAgendaFocusIndex(sections, focus.date);
    if (target < 0) {
      // Its days are still loading: try again when they arrive.
      if (isLoading) return;
      scrolledNonceRef.current = focus.nonce;
      return;
    }
    scrolledNonceRef.current = focus.nonce;
    retriesRef.current = 0;
    scrollToSection(target);
  }, [focus, sections, loaded, isLoading, scrollToSection]);
  React.useEffect(() => () => {
    if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
  }, []);

  // Rows between here and the target aren't measured yet: jump to the
  // estimate so the list renders around it, then retry.
  const handleScrollToIndexFailed = React.useCallback(
    (info: { index: number; averageItemLength: number }) => {
      listRef.current
        ?.getScrollResponder()
        ?.scrollTo({ y: info.averageItemLength * info.index, animated: false });
      if (retriesRef.current >= MAX_SCROLL_RETRIES) return;
      retriesRef.current += 1;
      retryTimerRef.current = setTimeout(() => {
        const target = findAgendaFocusIndex(sectionsRef.current, focusRef.current.date);
        if (target >= 0) scrollToSection(target);
      }, 50);
    },
    [scrollToSection],
  );

  // The first day in view drives the header title. The list wants a stable
  // callback, so the latest handler is read through a ref.
  const visibleHandlerRef = React.useRef(onVisibleDateChange);
  visibleHandlerRef.current = onVisibleDateChange;
  const lastVisibleKeyRef = React.useRef<string | null>(null);
  const onViewableItemsChanged = React.useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const section = viewableItems.find((token) => token.section)?.section as DaySection | undefined;
      if (!section || section.key === lastVisibleKeyRef.current) return;
      lastVisibleKeyRef.current = section.key;
      visibleHandlerRef.current?.(section.date);
    },
  ).current;

  // One outstanding extension at a time, and none while the last one hasn't
  // landed: an extension that failed (offline) must not keep widening the
  // window with nothing in it. The screen clears the loading edge once the
  // wider window is in, and asks again for a window it hasn't got.
  const sizeRef = React.useRef({ content: 0, viewport: 0 });
  // Content height when an end request had to wait, or null.
  const deferredEndRef = React.useRef<number | null>(null);
  const endLanded = !!loaded && loaded.end.getTime() >= window.end.getTime();
  const startLanded = !!loaded && loaded.start.getTime() <= window.start.getTime();
  const requestEnd = React.useCallback(() => {
    if (!onExtendEnd) return;
    if (isLoading || loadingEdge || !endLanded) {
      deferredEndRef.current = sizeRef.current.content;
      return;
    }
    deferredEndRef.current = null;
    onExtendEnd();
  }, [onExtendEnd, isLoading, loadingEdge, endLanded]);
  const requestStart = React.useCallback(() => {
    if (!onExtendStart || isLoading || loadingEdge || !startLanded) return;
    onExtendStart();
  }, [onExtendStart, isLoading, loadingEdge, startLanded]);

  // Once a load has finished and laid out: replay an end request that had
  // to wait if the list didn't change height meanwhile (it would not ask
  // again by itself), and keep filling a list shorter than the screen, which
  // can't be scrolled to its end, up to the limit.
  const requestEndRef = React.useRef(requestEnd);
  requestEndRef.current = requestEnd;
  const settled = !isLoading && !loadingEdge && endLanded;
  React.useEffect(() => {
    if (!settled) return;
    const timer = setTimeout(() => {
      const { content, viewport } = sizeRef.current;
      const deferred = deferredEndRef.current;
      deferredEndRef.current = null;
      if ((deferred !== null && deferred === content) || (viewport > 0 && content <= viewport)) {
        requestEndRef.current();
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [settled]);
  const handleLayout = React.useCallback((e: LayoutChangeEvent) => {
    sizeRef.current.viewport = e.nativeEvent.layout.height;
  }, []);
  const handleContentSizeChange = React.useCallback((_w: number, h: number) => {
    sizeRef.current.content = h;
  }, []);

  const formatRangeDate = (date: Date) => format(date, 'PP', { locale });

  const header = (
    <View style={styles.edge}>
      {onExtendStart ? (
        <Pressable
          onPress={requestStart}
          disabled={isLoading || !!loadingEdge || !startLanded}
          hitSlop={6}
          style={({ pressed }) => [styles.edgeButton, pressed && styles.edgeButtonPressed]}
        >
          <Text style={styles.edgeButtonText}>
            {loadingEdge === 'start'
              ? t('calendar.events.agenda_loading', 'Loading…')
              : t('calendar.events.agenda_show_earlier', 'Show earlier events')}
          </Text>
        </Pressable>
      ) : (
        <Text style={styles.edgeText}>
          {tp('calendar.events.agenda_range_start', 'Showing events from {date}', {
            date: formatRangeDate(window.start),
          })}
        </Text>
      )}
    </View>
  );

  // The footer is taller while more days load, so the list re-checks its end
  // once they are in, even when they brought no new rows.
  const footer = onExtendEnd ? (
    loadingEdge === 'end' ? (
      <View style={styles.footerLoading}>
        <ActivityIndicator size="small" color={c.textMuted} />
        <Text style={styles.edgeText}>{t('calendar.events.agenda_loading', 'Loading…')}</Text>
      </View>
    ) : (
      <View style={styles.footerIdle} />
    )
  ) : (
    <View style={[styles.edge, styles.footerIdle]}>
      <Text style={styles.edgeText}>
        {tp('calendar.events.agenda_range_end', 'Showing events until {date}', {
          date: formatRangeDate(window.end),
        })}
      </Text>
    </View>
  );

  const empty = (
    <View style={styles.emptyWrap}>
      {isLoading ? (
        <ActivityIndicator size="small" color={c.textMuted} />
      ) : (
        <Text style={styles.emptyDayText}>{t('calendar.events.no_events', 'No events')}</Text>
      )}
    </View>
  );

  return (
    <SectionList<CalendarEvent, DaySection>
      ref={listRef}
      sections={sections}
      keyExtractor={(item, i) => `${item.id}:${i}`}
      stickySectionHeadersEnabled={false}
      // Earlier days are inserted above what the user is reading without
      // moving it.
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      ListEmptyComponent={empty}
      onEndReached={requestEnd}
      onEndReachedThreshold={0.5}
      onScrollToIndexFailed={handleScrollToIndexFailed}
      onViewableItemsChanged={onViewableItemsChanged}
      viewabilityConfig={VIEWABILITY_CONFIG}
      onLayout={handleLayout}
      onContentSizeChange={handleContentSizeChange}
      initialNumToRender={12}
      maxToRenderPerBatch={12}
      windowSize={11}
      renderSectionHeader={({ section }) =>
        section.monthTitle || section.weekTitle ? (
          <View>
            {section.monthTitle && <Text style={styles.monthTitle}>{section.monthTitle}</Text>}
            {section.weekTitle && <Text style={styles.weekTitle}>{section.weekTitle}</Text>}
          </View>
        ) : null
      }
      renderItem={({ item, index: i, section }) => (
        <View style={[styles.row, i === section.data.length - 1 && styles.rowLast]}>
          <DateColumn date={section.date} show={i === 0} locale={locale} styles={styles} />
          <View style={styles.eventCol}>
            <EventCard
              event={item}
              calendars={calendars}
              timeFormat={timeFormat}
              currentUserEmails={currentUserEmails}
              onPress={onSelectEvent}
              day={section.date}
            />
          </View>
        </View>
      )}
      renderSectionFooter={({ section }) =>
        section.data.length === 0 ? (
          <View style={[styles.row, styles.rowLast]}>
            <DateColumn date={section.date} show locale={locale} styles={styles} />
            <Pressable
              style={styles.emptyDay}
              onPress={onCreateAt ? () => onCreateAt(section.date) : undefined}
              accessibilityRole={onCreateAt ? 'button' : undefined}
            >
              <Text style={styles.emptyDayText}>
                {t('calendar.events.nothing_planned', 'Nothing planned. Tap to create.')}
              </Text>
            </Pressable>
          </View>
        ) : null
      }
    />
  );
}

type AgendaStyles = ReturnType<typeof makeStyles>;

// The day on the left of its first row: weekday over the day number, today
// in a filled circle.
function DateColumn({
  date,
  show,
  locale,
  styles,
}: {
  date: Date;
  show: boolean;
  locale: Locale;
  styles: AgendaStyles;
}) {
  if (!show) return <View style={styles.dateCol} />;
  const today = isDisplayToday(date);
  return (
    <View style={styles.dateCol}>
      <Text style={[styles.dateWeekday, today && styles.dateWeekdayToday]}>
        {format(date, 'EEE', { locale })}
      </Text>
      <View style={[styles.dateNumber, today && styles.dateNumberToday]}>
        <Text style={[styles.dateNumberText, today && styles.dateNumberTextToday]}>
          {format(date, 'd')}
        </Text>
      </View>
    </View>
  );
}

const DATE_COL_WIDTH = 52;

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  monthTitle: {
    ...typography.h2,
    fontWeight: '500',
    color: c.text,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.sm,
  },
  weekTitle: {
    ...typography.caption,
    color: c.textMuted,
    paddingLeft: DATE_COL_WIDTH + spacing.sm,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingRight: spacing.lg,
    paddingLeft: spacing.sm,
  },
  rowLast: { paddingBottom: spacing.sm },
  dateCol: { width: DATE_COL_WIDTH, alignItems: 'center' },
  dateWeekday: { ...typography.captionMedium, color: c.textSecondary },
  dateWeekdayToday: { color: c.primary },
  dateNumber: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateNumberToday: { backgroundColor: c.primary },
  dateNumberText: { fontSize: 20, lineHeight: 26, fontWeight: '500', color: c.text },
  dateNumberTextToday: { color: c.primaryForeground },
  eventCol: { flex: 1, marginLeft: spacing.md },
  emptyDay: { flex: 1, marginLeft: spacing.md, paddingTop: 18 },
  emptyDayText: { ...typography.body, color: c.textSecondary },
  emptyWrap: { paddingVertical: spacing.xl, alignItems: 'center' },
  edge: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  edgeButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
  },
  edgeButtonPressed: { backgroundColor: c.surfaceHover },
  edgeButtonText: { ...typography.caption, color: c.primary },
  edgeText: { ...typography.caption, color: c.textMuted, textAlign: 'center' },
  footerLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingTop: spacing.lg,
    paddingBottom: 80,
  },
  // Room below the last day, as the list had before.
  footerIdle: { minHeight: 80 },
  });
}
