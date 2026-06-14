import React from 'react';
import { SectionList, StyleSheet, Text, View } from 'react-native';
import { addDays, format, isSameDay, isToday, isTomorrow, parseISO, startOfDay } from 'date-fns';
import { CalendarDays } from 'lucide-react-native';
import type { Calendar, CalendarEvent } from '../../api/types';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import {
  buildEventDayIndex,
  dayKey,
  eventsOnDayFromIndex,
  type EventDayIndex,
  type TimeFormat,
} from '../../lib/calendar-utils';
import { EventCard } from './EventCard';

interface AgendaViewProps {
  fromDate: Date;
  daysAhead?: number;
  events: CalendarEvent[];
  calendars: Calendar[];
  eventsByDay?: EventDayIndex;
  timeFormat?: TimeFormat;
  onSelectEvent?: (event: CalendarEvent) => void;
}

interface DaySection {
  title: string;
  date: Date;
  data: CalendarEvent[];
}

function formatDayHeader(date: Date): string {
  if (isToday(date)) return 'Today';
  if (isTomorrow(date)) return 'Tomorrow';
  return format(date, 'EEEE, MMM d');
}

export function AgendaView({
  fromDate,
  daysAhead = 30,
  events,
  calendars,
  eventsByDay,
  timeFormat,
  onSelectEvent,
}: AgendaViewProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const index = React.useMemo(
    () => eventsByDay ?? buildEventDayIndex(events),
    [eventsByDay, events],
  );

  const sections = React.useMemo<DaySection[]>(() => {
    // Mirror webmail's agenda (calendar-agenda-view.tsx): build a group for
    // every day that actually has events, always include a "Today" anchor, and
    // render them sorted ascending. Driving the list off the events (rather than
    // a fixed day-counter) guarantees every upcoming loaded event appears - not
    // just the ones inside a brittle N-day window from the anchor.
    const anchor = startOfDay(fromDate);
    const horizonEnd = addDays(anchor, daysAhead); // safety bound (exclusive)

    const days = new Map<string, Date>();
    for (const key of index.keys()) {
      const day = parseISO(key); // index keys are local yyyy-MM-dd
      if (isNaN(day.getTime())) continue;
      if (day < anchor || day >= horizonEnd) continue;
      days.set(key, day);
    }
    // Always anchor "Today" so the view has a stable starting point even when
    // the current day has no events (webmail injects the same anchor).
    const today = startOfDay(new Date());
    if (today >= anchor && today < horizonEnd) days.set(dayKey(today), today);

    return [...days.values()]
      .sort((a, b) => a.getTime() - b.getTime())
      .map((day) => ({
        title: formatDayHeader(day),
        date: day,
        // Buckets are pre-sorted by buildEventDayIndex (all-day first, then by
        // start, then title), so no extra sort is needed here.
        data: eventsOnDayFromIndex(index, day),
      }));
  }, [fromDate, daysAhead, index]);

  if (sections.length === 0) {
    return (
      <View style={styles.empty}>
        <CalendarDays size={40} color={c.surfaceActive} />
        <Text style={styles.emptyTitle}>No upcoming events</Text>
        <Text style={styles.emptySubtitle}>The next {daysAhead} days are clear.</Text>
      </View>
    );
  }

  return (
    <SectionList
      sections={sections}
      keyExtractor={(item, index) => `${item.id}:${index}`}
      contentContainerStyle={styles.listContent}
      stickySectionHeadersEnabled
      renderSectionHeader={({ section }) => {
        const today = isSameDay(section.date, new Date());
        return (
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, today && styles.sectionTitleToday]}>
              {section.title}
            </Text>
            <Text style={styles.sectionSub}>{format(section.date, 'MMM d')}</Text>
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
            <Text style={styles.emptyDayText}>No events</Text>
          </View>
        ) : null
      }
    />
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  listContent: { paddingBottom: 80 },
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
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xxxl,
  },
  emptyTitle: { ...typography.bodyMedium, color: c.textSecondary },
  emptySubtitle: { ...typography.caption, color: c.textMuted },
  });
}
