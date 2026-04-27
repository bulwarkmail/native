import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  ScrollView,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  CalendarDays,
  LayoutGrid,
  List as ListIcon,
  Menu,
} from 'lucide-react-native';
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  addDays,
  isToday,
  addMonths,
  subMonths,
  addWeeks,
  subWeeks,
} from 'date-fns';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { Button } from '../components';
import { useCalendarStore } from '../stores/calendar-store';
import { MonthView } from '../components/calendar/MonthView';
import { WeekView } from '../components/calendar/WeekView';
import { AgendaView } from '../components/calendar/AgendaView';
import { EventCard } from '../components/calendar/EventCard';
import { EventDetailSheet } from '../components/calendar/EventDetailSheet';
import { EventModal } from '../components/calendar/EventModal';
import {
  RecurrenceScopeDialog,
  type RecurrenceEditScope,
} from '../components/calendar/RecurrenceScopeDialog';
import { CalendarSidebarDrawer } from '../components/calendar/CalendarSidebarDrawer';
import {
  buildEventDayIndex,
  eventsOnDayFromIndex,
  type EventDayIndex,
} from '../lib/calendar-utils';
import type { Calendar, CalendarEvent } from '../api/types';

type ViewMode = 'month' | 'week' | 'agenda';
type PendingAction =
  | { kind: 'edit'; event: CalendarEvent }
  | { kind: 'delete'; event: CalendarEvent }
  | null;

const AGENDA_DAYS = 30;
const RANGE_BUFFER_DAYS = 14;

function rangeForView(viewMode: ViewMode, currentDate: Date): { after: Date; before: Date } {
  if (viewMode === 'month') {
    const start = startOfWeek(startOfMonth(currentDate));
    const end = endOfWeek(endOfMonth(currentDate));
    return { after: addDays(start, -RANGE_BUFFER_DAYS), before: addDays(end, RANGE_BUFFER_DAYS) };
  }
  if (viewMode === 'week') {
    const start = startOfWeek(currentDate);
    const end = endOfWeek(currentDate);
    return { after: addDays(start, -RANGE_BUFFER_DAYS), before: addDays(end, RANGE_BUFFER_DAYS) };
  }
  return {
    after: addDays(currentDate, -1),
    before: addDays(currentDate, AGENDA_DAYS + RANGE_BUFFER_DAYS),
  };
}

function headerTitle(viewMode: ViewMode, currentDate: Date): string {
  if (viewMode === 'month') return format(currentDate, 'MMMM yyyy');
  if (viewMode === 'week') {
    const start = startOfWeek(currentDate);
    const end = endOfWeek(currentDate);
    if (start.getMonth() === end.getMonth()) {
      return `${format(start, 'MMM d')} – ${format(end, 'd, yyyy')}`;
    }
    return `${format(start, 'MMM d')} – ${format(end, 'MMM d, yyyy')}`;
  }
  return format(currentDate, 'MMMM yyyy');
}

export default function CalendarScreen() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [currentDate, setCurrentDate] = React.useState(new Date());
  const [selectedDate, setSelectedDate] = React.useState(new Date());
  const [viewMode, setViewMode] = React.useState<ViewMode>('month');

  const [detailEvent, setDetailEvent] = React.useState<CalendarEvent | null>(null);
  const [modalEvent, setModalEvent] = React.useState<CalendarEvent | null>(null);
  const [modalDate, setModalDate] = React.useState<Date | undefined>(undefined);
  const [modalVisible, setModalVisible] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<PendingAction>(null);
  const [sidebarVisible, setSidebarVisible] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  const hydrate = useCalendarStore((s) => s.hydrate);
  const fetchCalendarsAction = useCalendarStore((s) => s.fetchCalendars);
  const ensureRange = useCalendarStore((s) => s.ensureRange);
  const refresh = useCalendarStore((s) => s.refresh);
  const createEvent = useCalendarStore((s) => s.createEvent);
  const updateEvent = useCalendarStore((s) => s.updateEvent);
  const deleteEvent = useCalendarStore((s) => s.deleteEvent);
  const toggleCalendarVisibility = useCalendarStore((s) => s.toggleCalendarVisibility);
  const allCalendars = useCalendarStore((s) => s.calendars);
  const hiddenCalendarIds = useCalendarStore((s) => s.hiddenCalendarIds);
  const loading = useCalendarStore((s) => s.loading);
  const error = useCalendarStore((s) => s.error);
  const allEvents = useCalendarStore((s) => s.events);

  const calendars = React.useMemo(
    () => allCalendars.filter((c) => !hiddenCalendarIds.includes(c.id)),
    [allCalendars, hiddenCalendarIds],
  );
  const events = React.useMemo(() => {
    if (hiddenCalendarIds.length === 0) return allEvents;
    const hidden = new Set(hiddenCalendarIds);
    return allEvents.filter((e) => {
      const ids = Object.keys(e.calendarIds || {});
      if (ids.length === 0) return true;
      return ids.some((id) => !hidden.has(id));
    });
  }, [allEvents, hiddenCalendarIds]);
  // Pre-index events by day once. Child views do O(1) map lookups per cell
  // instead of re-filtering the full event list with parseISO per day.
  const eventsByDay = React.useMemo(() => buildEventDayIndex(events), [events]);

  React.useEffect(() => {
    void hydrate();
    void fetchCalendarsAction();
  }, [hydrate, fetchCalendarsAction]);

  React.useEffect(() => {
    const { after, before } = rangeForView(viewMode, currentDate);
    void ensureRange(after.toISOString(), before.toISOString());
  }, [viewMode, currentDate, ensureRange]);

  const goPrev = React.useCallback(() => {
    setCurrentDate((d) => {
      if (viewMode === 'month') return subMonths(d, 1);
      if (viewMode === 'week') return subWeeks(d, 1);
      return addDays(d, -AGENDA_DAYS);
    });
  }, [viewMode]);

  const goNext = React.useCallback(() => {
    setCurrentDate((d) => {
      if (viewMode === 'month') return addMonths(d, 1);
      if (viewMode === 'week') return addWeeks(d, 1);
      return addDays(d, AGENDA_DAYS);
    });
  }, [viewMode]);

  const goToday = React.useCallback(() => {
    const today = new Date();
    setCurrentDate(today);
    setSelectedDate(today);
  }, []);

  const handleSelectDate = React.useCallback(
    (date: Date) => {
      setSelectedDate(date);
      if (viewMode === 'week') setCurrentDate(date);
    },
    [viewMode],
  );

  const openCreate = React.useCallback((date?: Date) => {
    setModalEvent(null);
    setModalDate(date);
    setModalVisible(true);
  }, []);

  const openEditDirect = React.useCallback((event: CalendarEvent) => {
    setModalEvent(event);
    setModalDate(undefined);
    setModalVisible(true);
  }, []);

  const handleEditFromDetail = React.useCallback((event: CalendarEvent) => {
    setDetailEvent(null);
    if (event.recurrenceRules?.length || event.originalId) {
      setPendingAction({ kind: 'edit', event });
    } else {
      openEditDirect(event);
    }
  }, [openEditDirect]);

  const handleDeleteFromDetail = React.useCallback((event: CalendarEvent) => {
    setDetailEvent(null);
    if (event.recurrenceRules?.length || event.originalId) {
      setPendingAction({ kind: 'delete', event });
    } else {
      void deleteEvent(event.id);
    }
  }, [deleteEvent]);

  const handleScopeSelect = React.useCallback(
    async (scope: RecurrenceEditScope) => {
      const action = pendingAction;
      setPendingAction(null);
      if (!action) return;
      // For the first pass, treat all scopes as "all" - proper override
      // handling lives in the store's update/delete path against originalId.
      // TODO: implement "this only" via recurrenceOverrides write, and
      // "this and following" via excludedRecurrenceRules + new master.
      if (action.kind === 'edit') {
        openEditDirect(action.event);
      } else {
        await deleteEvent(action.event.id);
      }
    },
    [pendingAction, openEditDirect, deleteEvent],
  );

  const handleSave = React.useCallback(
    async (data: Partial<CalendarEvent>, calendarId: string) => {
      if (modalEvent) {
        await updateEvent(modalEvent.id, data);
      } else {
        await createEvent(data, calendarId);
      }
    },
    [modalEvent, createEvent, updateEvent],
  );

  const handleDeleteFromModal = React.useCallback(
    async (event: CalendarEvent) => {
      setModalVisible(false);
      await deleteEvent(event.id);
    },
    [deleteEvent],
  );

  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const isSelectedToday = isToday(selectedDate);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => setSidebarVisible(true)}
          hitSlop={8}
          style={styles.headerBtn}
        >
          <Menu size={20} color={c.text} />
        </Pressable>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>{headerTitle(viewMode, currentDate)}</Text>
          <Text style={styles.headerSubtitle}>
            {isSelectedToday ? 'Today' : format(selectedDate, 'EEE, MMM d')}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <View style={styles.viewToggle}>
            {(['month', 'week', 'agenda'] as ViewMode[]).map((mode) => {
              const Icon =
                mode === 'month' ? LayoutGrid : mode === 'week' ? CalendarDays : ListIcon;
              const active = viewMode === mode;
              return (
                <Pressable
                  key={mode}
                  style={[styles.viewToggleBtn, active && styles.viewToggleBtnActive]}
                  onPress={() => setViewMode(mode)}
                >
                  <Icon size={16} color={active ? c.primary : c.textMuted} />
                </Pressable>
              );
            })}
          </View>
          <Pressable style={styles.fab} onPress={() => openCreate(selectedDate)}>
            <Plus size={18} color={c.primaryForeground} />
          </Pressable>
        </View>
      </View>

      <View style={styles.nav}>
        <Pressable onPress={goPrev} style={styles.navBtn} hitSlop={8}>
          <ChevronLeft size={20} color={c.text} />
        </Pressable>
        <Button variant="outline" size="sm" onPress={goToday}>
          Today
        </Button>
        <Pressable onPress={goNext} style={styles.navBtn} hitSlop={8}>
          <ChevronRight size={20} color={c.text} />
        </Pressable>
      </View>

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View style={styles.content}>
        {viewMode === 'month' && (
          <MonthView
            currentDate={currentDate}
            selectedDate={selectedDate}
            events={events}
            eventsByDay={eventsByDay}
            calendars={calendars}
            onSelectDate={handleSelectDate}
            onLongPressDate={openCreate}
          />
        )}
        {viewMode === 'week' && (
          <WeekView
            selectedDate={selectedDate}
            events={events}
            eventsByDay={eventsByDay}
            calendars={calendars}
            onSelectDate={handleSelectDate}
            onSelectEvent={setDetailEvent}
            onCreateAtTime={openCreate}
          />
        )}
        {viewMode === 'agenda' && (
          <AgendaView
            fromDate={currentDate}
            daysAhead={AGENDA_DAYS}
            events={events}
            eventsByDay={eventsByDay}
            calendars={calendars}
            onSelectEvent={setDetailEvent}
          />
        )}

        {viewMode === 'month' && (
          <View style={styles.dayDetail}>
            <View style={styles.dayDetailHeader}>
              <Text style={styles.dayDetailTitle}>
                {isSelectedToday ? "Today's Events" : format(selectedDate, 'EEEE, MMMM d')}
              </Text>
              {loading && <ActivityIndicator size="small" color={c.textMuted} />}
            </View>
            <DayEventList
              date={selectedDate}
              eventsByDay={eventsByDay}
              calendars={calendars}
              onSelectEvent={setDetailEvent}
              refreshing={refreshing}
              onRefresh={onRefresh}
            />
          </View>
        )}
      </View>

      <EventDetailSheet
        event={detailEvent}
        calendars={calendars}
        onClose={() => setDetailEvent(null)}
        onEdit={handleEditFromDetail}
        onDelete={handleDeleteFromDetail}
      />

      <EventModal
        visible={modalVisible}
        event={modalEvent}
        calendars={allCalendars}
        defaultDate={modalDate}
        onSave={handleSave}
        onDelete={handleDeleteFromModal}
        onClose={() => setModalVisible(false)}
      />

      <RecurrenceScopeDialog
        visible={!!pendingAction}
        actionType={pendingAction?.kind === 'delete' ? 'delete' : 'edit'}
        onSelect={handleScopeSelect}
        onClose={() => setPendingAction(null)}
      />

      <CalendarSidebarDrawer
        visible={sidebarVisible}
        calendars={allCalendars}
        hiddenCalendarIds={hiddenCalendarIds}
        onToggle={toggleCalendarVisibility}
        onClose={() => setSidebarVisible(false)}
      />
    </SafeAreaView>
  );
}

function DayEventList({
  date,
  eventsByDay,
  calendars,
  onSelectEvent,
  refreshing,
  onRefresh,
}: {
  date: Date;
  eventsByDay: EventDayIndex;
  calendars: Calendar[];
  onSelectEvent?: (event: CalendarEvent) => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const dayEvents = React.useMemo(
    () => eventsOnDayFromIndex(eventsByDay, date),
    [eventsByDay, date],
  );
  if (dayEvents.length === 0) {
    return (
      <ScrollView
        contentContainerStyle={styles.emptyState}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.textMuted} />
        }
      >
        <CalendarDays size={32} color={c.surfaceActive} />
        <Text style={styles.emptyTitle}>No events</Text>
        <Text style={styles.emptySubtitle}>Tap + to create one</Text>
      </ScrollView>
    );
  }
  return (
    <ScrollView
      contentContainerStyle={styles.dayList}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.textMuted} />
      }
    >
      {dayEvents.map((event) => (
        <EventCard
          key={event.id}
          event={event}
          calendars={calendars}
          onPress={onSelectEvent}
        />
      ))}
    </ScrollView>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  headerBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  headerLeft: { flex: 1 },
  headerTitle: { ...typography.h3, color: c.text },
  headerSubtitle: { ...typography.caption, color: c.textMuted, marginTop: 2 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  viewToggle: {
    flexDirection: 'row',
    backgroundColor: c.surface,
    borderRadius: radius.md,
    padding: 2,
  },
  viewToggleBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  viewToggleBtnActive: { backgroundColor: c.background },
  fab: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: c.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },

  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xs,
    gap: spacing.lg,
  },
  navBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },

  errorBanner: {
    backgroundColor: c.errorBg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  errorText: { ...typography.caption, color: c.errorForeground },

  content: { flex: 1 },

  dayDetail: {
    flex: 1,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  dayDetailHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  dayDetailTitle: { ...typography.bodyMedium, color: c.text },
  dayList: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },

  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    gap: spacing.xs,
    flexGrow: 1,
  },
  emptyTitle: { ...typography.bodyMedium, color: c.textSecondary },
  emptySubtitle: { ...typography.caption, color: c.textMuted },
  });
}
