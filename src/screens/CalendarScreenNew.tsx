import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, FlatList } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ChevronLeft, ChevronRight, Plus, Clock, MapPin,
  CalendarDays, LayoutGrid, List as ListIcon, Users
} from 'lucide-react-native';
import {
  format, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  addDays, isSameMonth, isToday, isSameDay, addMonths, subMonths
} from 'date-fns';
import { colors, spacing, radius, typography, componentSizes } from '../theme/tokens';
import { Button, Card, Badge } from '../components';

type ViewMode = 'month' | 'week' | 'agenda';

const MOCK_EVENTS = [
  {
    id: '1', title: 'Team Standup', time: '09:00 – 09:30',
    color: colors.calendar.blue, location: 'Zoom',
    date: new Date(), allDay: false, participants: 5,
  },
  {
    id: '2', title: 'Design Review', time: '11:00 – 12:00',
    color: colors.calendar.purple, location: 'Conference Room A',
    date: new Date(), allDay: false, participants: 3,
  },
  {
    id: '3', title: 'Lunch with Sarah', time: '12:30 – 13:30',
    color: colors.calendar.green, location: 'Café Nero',
    date: new Date(), allDay: false, participants: 2,
  },
  {
    id: '4', title: 'Sprint Planning', time: '14:00 – 15:30',
    color: colors.calendar.orange, location: 'Main Office',
    date: new Date(), allDay: false, participants: 8,
  },
  {
    id: '5', title: 'Company Holiday', time: '',
    color: colors.calendar.teal, location: '',
    date: addDays(new Date(), 2), allDay: true, participants: 0,
  },
  {
    id: '6', title: 'Release v2.5', time: '10:00 – 11:00',
    color: colors.calendar.red, location: '',
    date: addDays(new Date(), 1), allDay: false, participants: 4,
  },
];

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function MonthGrid({ currentDate, selectedDate, onSelectDate }: {
  currentDate: Date;
  selectedDate: Date;
  onSelectDate: (d: Date) => void;
}) {
  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const calStart = startOfWeek(monthStart);
  const calEnd = endOfWeek(monthEnd);

  const days: Date[] = [];
  let day = calStart;
  while (day <= calEnd) {
    days.push(day);
    day = addDays(day, 1);
  }

  // Count events per day
  const eventDots = (d: Date) => MOCK_EVENTS.filter(e => isSameDay(e.date, d));

  return (
    <View style={styles.calendarGrid}>
      <View style={styles.weekdayRow}>
        {WEEKDAYS.map((wd, i) => (
          <Text key={i} style={styles.weekdayLabel}>{wd}</Text>
        ))}
      </View>
      <View style={styles.daysGrid}>
        {days.map((d, i) => {
          const sameMonth = isSameMonth(d, currentDate);
          const today = isToday(d);
          const selected = isSameDay(d, selectedDate);
          const dayEvents = eventDots(d);

          return (
            <Pressable key={i} style={styles.dayCell} onPress={() => onSelectDate(d)}>
              <View style={[
                styles.dayNumber,
                today && styles.todayCircle,
                selected && !today && styles.selectedCircle,
              ]}>
                <Text style={[
                  styles.dayText,
                  !sameMonth && styles.dayTextMuted,
                  today && styles.todayText,
                  selected && !today && styles.selectedText,
                ]}>
                  {format(d, 'd')}
                </Text>
              </View>
              {dayEvents.length > 0 && (
                <View style={styles.eventDotsRow}>
                  {dayEvents.slice(0, 3).map((e, idx) => (
                    <View key={idx} style={[styles.eventDotSmall, { backgroundColor: e.color }]} />
                  ))}
                </View>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function EventCard({ event }: { event: typeof MOCK_EVENTS[0] }) {
  return (
    <Pressable style={styles.eventCard}>
      <View style={[styles.eventColorBar, { backgroundColor: event.color }]} />
      <View style={styles.eventBody}>
        <View style={styles.eventHeaderRow}>
          <Text style={styles.eventTitle}>{event.title}</Text>
          {event.allDay && (
            <View style={styles.allDayBadge}>
              <Text style={styles.allDayText}>All day</Text>
            </View>
          )}
        </View>
        {event.time ? (
          <View style={styles.eventDetail}>
            <Clock size={12} color={colors.textMuted} />
            <Text style={styles.eventDetailText}>{event.time}</Text>
          </View>
        ) : null}
        {event.location ? (
          <View style={styles.eventDetail}>
            <MapPin size={12} color={colors.textMuted} />
            <Text style={styles.eventDetailText}>{event.location}</Text>
          </View>
        ) : null}
        {event.participants > 0 && (
          <View style={styles.eventDetail}>
            <Users size={12} color={colors.textMuted} />
            <Text style={styles.eventDetailText}>{event.participants} participants</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

interface CalendarScreenProps {
  onCreateEvent?: () => void;
}

export default function CalendarScreen({ onCreateEvent }: CalendarScreenProps) {
  const [currentDate, setCurrentDate] = React.useState(new Date());
  const [selectedDate, setSelectedDate] = React.useState(new Date());
  const [viewMode, setViewMode] = React.useState<ViewMode>('month');

  const selectedEvents = MOCK_EVENTS.filter(e => isSameDay(e.date, selectedDate));
  const isSelectedToday = isToday(selectedDate);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>{format(currentDate, 'MMMM yyyy')}</Text>
          <Text style={styles.headerSubtitle}>
            {isSelectedToday ? 'Today' : format(selectedDate, 'EEE, MMM d')}
          </Text>
        </View>
        <View style={styles.headerActions}>
          {/* View mode toggle */}
          <View style={styles.viewToggle}>
            {(['month', 'week', 'agenda'] as ViewMode[]).map((mode) => {
              const Icon = mode === 'month' ? LayoutGrid : mode === 'week' ? CalendarDays : ListIcon;
              const active = viewMode === mode;
              return (
                <Pressable
                  key={mode}
                  style={[styles.viewToggleBtn, active && styles.viewToggleBtnActive]}
                  onPress={() => setViewMode(mode)}
                >
                  <Icon size={16} color={active ? colors.primary : colors.textMuted} />
                </Pressable>
              );
            })}
          </View>
          <Button variant="default" size="icon" onPress={onCreateEvent} style={styles.addButton}>
            <Plus size={18} color={colors.primaryForeground} />
          </Button>
        </View>
      </View>

      {/* Month navigation */}
      <View style={styles.monthNav}>
        <Pressable onPress={() => setCurrentDate(subMonths(currentDate, 1))} style={styles.navBtn}>
          <ChevronLeft size={20} color={colors.text} />
        </Pressable>
      <Pressable
          onPress={() => { setCurrentDate(new Date()); setSelectedDate(new Date()); }}
        >
          <Button variant="outline" size="sm" onPress={() => { setCurrentDate(new Date()); setSelectedDate(new Date()); }}>
            Today
          </Button>
        </Pressable>
        <Pressable onPress={() => setCurrentDate(addMonths(currentDate, 1))} style={styles.navBtn}>
          <ChevronRight size={20} color={colors.text} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Calendar grid */}
        <MonthGrid
          currentDate={currentDate}
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
        />

        {/* Events for selected day */}
        <View style={styles.eventsSection}>
          <View style={styles.eventsSectionHeader}>
            <Text style={styles.eventsSectionTitle}>
              {isSelectedToday ? "Today's Events" : format(selectedDate, 'EEEE, MMMM d')}
            </Text>
            <Text style={styles.eventsSectionCount}>
              {selectedEvents.length} event{selectedEvents.length !== 1 ? 's' : ''}
            </Text>
          </View>
          {selectedEvents.length > 0 ? (
            selectedEvents.map(event => <EventCard key={event.id} event={event} />)
          ) : (
            <View style={styles.emptyState}>
              <CalendarDays size={40} color={colors.surfaceActive} />
              <Text style={styles.emptyTitle}>No events</Text>
              <Text style={styles.emptySubtitle}>Tap + to create one</Text>
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scrollContent: { paddingBottom: 80 },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  headerTitle: { ...typography.h3, color: colors.text },
  headerSubtitle: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  viewToggle: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: 2,
  },
  viewToggleBtn: {
    width: 32, height: 32,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.sm,
  },
  viewToggleBtnActive: { backgroundColor: colors.background },
  addButton: {
    borderRadius: radius.full,
  },

  // Month nav
  monthNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xs,
    gap: spacing.lg,
  },
  navBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.full },

  // Calendar grid
  calendarGrid: { paddingHorizontal: spacing.sm },
  weekdayRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.xs,
    marginBottom: 4,
  },
  weekdayLabel: {
    flex: 1,
    textAlign: 'center',
    ...typography.small,
    color: colors.textMuted,
  },
  daysGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: {
    width: '14.28%',
    alignItems: 'center',
    paddingVertical: 4,
  },
  dayNumber: {
    width: 36, height: 36,
    borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  dayText: { ...typography.body, color: colors.text },
  dayTextMuted: { color: colors.textMuted },
  todayCircle: { borderWidth: 2, borderColor: colors.primary, backgroundColor: 'transparent' },
  todayText: { color: colors.textInverse, fontWeight: '700' },
  selectedCircle: { backgroundColor: colors.primaryBg, borderWidth: 1.5, borderColor: colors.primary },
  selectedText: { color: colors.primary, fontWeight: '600' },
  eventDotsRow: {
    flexDirection: 'row',
    gap: 2,
    marginTop: 2,
    height: componentSizes.eventDot,
  },
  eventDotSmall: { width: componentSizes.eventDot, height: componentSizes.eventDot, borderRadius: 3 },

  // Events section
  eventsSection: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
  },
  eventsSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  eventsSectionTitle: { ...typography.bodyMedium, color: colors.text },
  eventsSectionCount: { ...typography.caption, color: colors.textMuted },

  // Event card — matches webmail card styling
  eventCard: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    marginBottom: spacing.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  eventColorBar: { width: 3 },

  eventBody: {
    flex: 1,
    padding: spacing.md,
    gap: 4,
  },
  eventHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  eventTitle: { ...typography.bodyMedium, color: colors.text, flex: 1 },
  allDayBadge: {
    backgroundColor: colors.primaryBg,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  allDayText: { ...typography.small, color: colors.primary },
  eventDetail: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  eventDetailText: { ...typography.caption, color: colors.textMuted },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xxxl,
    gap: spacing.sm,
  },
  emptyTitle: { ...typography.bodyMedium, color: colors.textSecondary },
  emptySubtitle: { ...typography.caption, color: colors.textMuted },
});
