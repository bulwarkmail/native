import React from 'react';
import { SectionList, StyleSheet, Text, View } from 'react-native';
import { format, isSameDay, isToday, isTomorrow } from 'date-fns';
import { CalendarDays } from 'lucide-react-native';
import type { Calendar, CalendarEvent } from '../../api/types';
import { colors, spacing, typography } from '../../theme/tokens';
import {
  buildEventDayIndex,
  eventsOnDayFromIndex,
  getEventStartDate,
  type EventDayIndex,
} from '../../lib/calendar-utils';
import { EventCard } from './EventCard';

interface AgendaViewProps {
  fromDate: Date;
  daysAhead?: number;
  events: CalendarEvent[];
  calendars: Calendar[];
  eventsByDay?: EventDayIndex;
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
  onSelectEvent,
}: AgendaViewProps) {
  const index = React.useMemo(
    () => eventsByDay ?? buildEventDayIndex(events),
    [eventsByDay, events],
  );

  const sections = React.useMemo<DaySection[]>(() => {
    const result: DaySection[] = [];
    const start = new Date(fromDate);
    start.setHours(0, 0, 0, 0);

    for (let i = 0; i < daysAhead; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      const dayEvents = eventsOnDayFromIndex(index, day).slice().sort((a, b) => {
        // All-day events first within a day, then by start time, then title
        // (stable tie-break) - mirrors the comparator the webmail uses for
        // packing week segments and keeps multi-event days predictable.
        if (a.showWithoutTime !== b.showWithoutTime) {
          return a.showWithoutTime ? -1 : 1;
        }
        const diff = getEventStartDate(a).getTime() - getEventStartDate(b).getTime();
        if (diff !== 0) return diff;
        return (a.title || '').localeCompare(b.title || '');
      });
      if (dayEvents.length === 0 && !isToday(day)) continue;
      result.push({
        title: formatDayHeader(day),
        date: day,
        data: dayEvents,
      });
    }
    return result;
  }, [fromDate, daysAhead, index]);

  if (sections.length === 0) {
    return (
      <View style={styles.empty}>
        <CalendarDays size={40} color={colors.surfaceActive} />
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
          <EventCard event={item} calendars={calendars} onPress={onSelectEvent} />
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

const styles = StyleSheet.create({
  listContent: { paddingBottom: 80 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sectionTitle: { ...typography.bodyMedium, color: colors.text },
  sectionTitleToday: { color: colors.primary },
  sectionSub: { ...typography.caption, color: colors.textMuted },
  itemWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  emptyDayWrap: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  emptyDayText: { ...typography.caption, color: colors.textMuted, textAlign: 'center' },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xxxl,
  },
  emptyTitle: { ...typography.bodyMedium, color: colors.textSecondary },
  emptySubtitle: { ...typography.caption, color: colors.textMuted },
});
