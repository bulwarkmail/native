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
import { format, type Locale } from 'date-fns';
import { displayNow, isDisplayToday, isDisplayTomorrow } from '../../lib/calendar-timezone';
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
  onSelectEvent?: (event: CalendarEvent) => void;
}

interface DaySection extends AgendaDay {
  key: string;
  title: string;
}

function formatDayHeader(
  date: Date,
  t: (key: string, fallback?: string) => string,
  locale: Locale,
): string {
  // Today and tomorrow on a clock in the calendar's time zone.
  if (isDisplayToday(date)) return t('calendar.events.today_header', 'Today');
  if (isDisplayTomorrow(date)) return t('calendar.events.tomorrow_header', 'Tomorrow');
  return format(date, 'EEEE, MMM d', { locale });
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
  onSelectEvent,
}: AgendaViewProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const { locale, t } = useCalendarLocale();
  const tp = useLocaleStore((s) => s.t);
  const index = React.useMemo(
    () => eventsByDay ?? buildEventDayIndex(events),
    [eventsByDay, events],
  );

  const sections = React.useMemo<DaySection[]>(
    () =>
      buildAgendaDays(index, loaded, displayNow()).map((day) => ({
        ...day,
        key: dayKey(day.date),
        title: formatDayHeader(day.date, t, locale),
      })),
    [index, loaded, t, locale],
  );

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
      stickySectionHeadersEnabled
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
      renderSectionHeader={({ section }) => {
        const today = isDisplayToday(section.date);
        return (
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, today && styles.sectionTitleToday]}>
              {section.title}
            </Text>
            <Text style={styles.sectionSub}>{format(section.date, 'PP', { locale })}</Text>
          </View>
        );
      }}
      renderItem={({ item }) => (
        <View style={styles.itemWrap}>
          <EventCard event={item} calendars={calendars} timeFormat={timeFormat} onPress={onSelectEvent} />
        </View>
      )}
      renderSectionFooter={({ section }) =>
        section.data.length === 0 ? (
          <View style={styles.emptyDayWrap}>
            <Text style={styles.emptyDayText}>{t('calendar.events.no_events', 'No events')}</Text>
          </View>
        ) : null
      }
    />
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  sectionTitle: { ...typography.bodyMedium, color: c.text },
  sectionTitleToday: { color: c.primary },
  sectionSub: { ...typography.caption, color: c.textMuted },
  itemWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  emptyDayWrap: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  emptyDayText: { ...typography.caption, color: c.textMuted, textAlign: 'center' },
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
