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
  ListChecks,
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
import { useSettingsStore } from '../stores/settings-store';
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
import { TasksSheet } from '../components/calendar/TasksSheet';
import { ICalImportSheet } from '../components/calendar/ICalImportSheet';
import { ICalSubscriptionSheet } from '../components/calendar/ICalSubscriptionSheet';
import {
  applySharedCalendarColors,
  buildEventDayIndex,
  eventsOnDayFromIndex,
  pickUnusedCalendarColor,
  sharedCalendarColorKey,
  type EventDayIndex,
} from '../lib/calendar-utils';
import { buildReplyTo } from '../lib/calendar-invitation';
import { generateBirthdayEvents, createBirthdayCalendar, BIRTHDAY_CALENDAR_ID } from '../lib/birthday-calendar';
import { useContactsStore } from '../stores/contacts-store';
import type { Calendar, CalendarEvent } from '../api/types';

type ViewMode = 'month' | 'week' | 'agenda';
type PendingAction =
  | { kind: 'edit'; event: CalendarEvent }
  | { kind: 'delete'; event: CalendarEvent }
  | null;

const AGENDA_DAYS = 30;
const RANGE_BUFFER_DAYS = 14;

function rangeForView(
  viewMode: ViewMode,
  currentDate: Date,
  weekStartsOn: 0 | 1,
): { after: Date; before: Date } {
  if (viewMode === 'month') {
    const start = startOfWeek(startOfMonth(currentDate), { weekStartsOn });
    const end = endOfWeek(endOfMonth(currentDate), { weekStartsOn });
    return { after: addDays(start, -RANGE_BUFFER_DAYS), before: addDays(end, RANGE_BUFFER_DAYS) };
  }
  if (viewMode === 'week') {
    const start = startOfWeek(currentDate, { weekStartsOn });
    const end = endOfWeek(currentDate, { weekStartsOn });
    return { after: addDays(start, -RANGE_BUFFER_DAYS), before: addDays(end, RANGE_BUFFER_DAYS) };
  }
  return {
    after: addDays(currentDate, -1),
    before: addDays(currentDate, AGENDA_DAYS + RANGE_BUFFER_DAYS),
  };
}

function headerTitle(
  viewMode: ViewMode,
  currentDate: Date,
  weekStartsOn: 0 | 1,
): string {
  if (viewMode === 'month') return format(currentDate, 'MMMM yyyy');
  if (viewMode === 'week') {
    const start = startOfWeek(currentDate, { weekStartsOn });
    const end = endOfWeek(currentDate, { weekStartsOn });
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
  const calendarDefaultView = useSettingsStore((s) => s.calendarDefaultView);
  const calendarFirstDayOfWeek = useSettingsStore((s) => s.calendarFirstDayOfWeek);
  const calendarShowWeekNumbers = useSettingsStore((s) => s.calendarShowWeekNumbers);
  const calendarTimeFormat = useSettingsStore((s) => s.calendarTimeFormat);
  const showBirthdayCalendar = useSettingsStore((s) => s.showBirthdayCalendar);
  const enableCalendarTasks = useSettingsStore((s) => s.enableCalendarTasks);
  const sharedCalendarColors = useSettingsStore((s) => s.sharedCalendarColors);
  const setSharedCalendarColor = useSettingsStore((s) => s.setSharedCalendarColor);
  const removeSharedCalendarColor = useSettingsStore((s) => s.removeSharedCalendarColor);
  const contacts = useContactsStore((s) => s.contacts);

  const [currentDate, setCurrentDate] = React.useState(new Date());
  const [selectedDate, setSelectedDate] = React.useState(new Date());
  // Day view falls back to Agenda on mobile (we don't have a dedicated day
  // grid yet, but the agenda's 30-day view already serves the same purpose).
  const initialViewMode: ViewMode =
    calendarDefaultView === 'week' ? 'week'
    : calendarDefaultView === 'day' || calendarDefaultView === 'agenda' ? 'agenda'
    : 'month';
  const [viewMode, setViewMode] = React.useState<ViewMode>(initialViewMode);

  const [detailEvent, setDetailEvent] = React.useState<CalendarEvent | null>(null);
  const [modalEvent, setModalEvent] = React.useState<CalendarEvent | null>(null);
  const [modalDate, setModalDate] = React.useState<Date | undefined>(undefined);
  const [modalVisible, setModalVisible] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<PendingAction>(null);
  const [sidebarVisible, setSidebarVisible] = React.useState(false);
  const [tasksVisible, setTasksVisible] = React.useState(false);
  const [importVisible, setImportVisible] = React.useState(false);
  const [subscriptionsVisible, setSubscriptionsVisible] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  const hydrate = useCalendarStore((s) => s.hydrate);
  const fetchCalendarsAction = useCalendarStore((s) => s.fetchCalendars);
  const ensureRange = useCalendarStore((s) => s.ensureRange);
  const refresh = useCalendarStore((s) => s.refresh);
  const createEvent = useCalendarStore((s) => s.createEvent);
  const updateEvent = useCalendarStore((s) => s.updateEvent);
  const deleteEvent = useCalendarStore((s) => s.deleteEvent);
  const rsvpEvent = useCalendarStore((s) => s.rsvpEvent);
  const importEvents = useCalendarStore((s) => s.importEvents);
  const tasks = useCalendarStore((s) => s.tasks);
  const createTask = useCalendarStore((s) => s.createTask);
  const toggleTaskComplete = useCalendarStore((s) => s.toggleTaskComplete);
  const deleteTask = useCalendarStore((s) => s.deleteTask);
  const toggleCalendarVisibility = useCalendarStore((s) => s.toggleCalendarVisibility);
  const setDefaultCalendar = useCalendarStore((s) => s.setDefaultCalendar);
  const storeCalendars = useCalendarStore((s) => s.calendars);
  const hiddenCalendarIds = useCalendarStore((s) => s.hiddenCalendarIds);
  const loading = useCalendarStore((s) => s.loading);
  const error = useCalendarStore((s) => s.error);
  const storeEvents = useCalendarStore((s) => s.events);

  // The birthday calendar is a client-side virtual calendar: its events are
  // generated from contacts for the visible range and merged in alongside the
  // server calendars. Toggling it on/off is instant (no refetch).
  const birthdayEvents = React.useMemo(() => {
    if (!showBirthdayCalendar) return [];
    const { after, before } = rangeForView(viewMode, currentDate, calendarFirstDayOfWeek);
    return generateBirthdayEvents(contacts, after.toISOString(), before.toISOString());
  }, [showBirthdayCalendar, contacts, viewMode, currentDate, calendarFirstDayOfWeek]);

  // Per-viewer recolor (#345): shared calendars get the viewer's local color
  // override applied before anything renders. Personal calendars pass through.
  const displayCalendars = React.useMemo(
    () => applySharedCalendarColors(storeCalendars, sharedCalendarColors),
    [storeCalendars, sharedCalendarColors],
  );

  // Auto-assign a random, not-yet-used palette color to any freshly shared
  // calendar so multiple shared calendars don't collide on one color. Runs
  // once per calendar (guarded by the presence of an existing key), and the
  // user can still overwrite it from the sidebar.
  React.useEffect(() => {
    const missing = storeCalendars.filter(
      (cal) => cal.isShared && !sharedCalendarColors[sharedCalendarColorKey(cal)],
    );
    if (missing.length === 0) return;
    // Seed "used" with personal calendar colors plus already-assigned shared
    // overrides so the picks stay distinct from what's already on screen.
    const used = new Set<string>();
    for (const cal of storeCalendars) {
      if (!cal.isShared && cal.color) used.add(cal.color.toLowerCase());
    }
    for (const color of Object.values(sharedCalendarColors)) {
      if (color) used.add(color.toLowerCase());
    }
    for (const cal of missing) {
      const color = pickUnusedCalendarColor(used);
      used.add(color.toLowerCase());
      setSharedCalendarColor(sharedCalendarColorKey(cal), color);
    }
  }, [storeCalendars, sharedCalendarColors, setSharedCalendarColor]);

  const allCalendars = React.useMemo(
    () => (showBirthdayCalendar ? [...displayCalendars, createBirthdayCalendar()] : displayCalendars),
    [displayCalendars, showBirthdayCalendar],
  );
  const allEvents = React.useMemo(
    () => (birthdayEvents.length > 0 ? [...storeEvents, ...birthdayEvents] : storeEvents),
    [storeEvents, birthdayEvents],
  );

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
    const { after, before } = rangeForView(viewMode, currentDate, calendarFirstDayOfWeek);
    void ensureRange(after.toISOString(), before.toISOString());
  }, [viewMode, currentDate, ensureRange, calendarFirstDayOfWeek]);

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

  const isReadOnlyEvent = React.useCallback(
    (event: CalendarEvent) => !!event.calendarIds?.[BIRTHDAY_CALENDAR_ID],
    [],
  );

  const handleEditFromDetail = React.useCallback((event: CalendarEvent) => {
    if (isReadOnlyEvent(event)) { setDetailEvent(null); return; }
    setDetailEvent(null);
    if (event.recurrenceRules?.length || event.originalId) {
      setPendingAction({ kind: 'edit', event });
    } else {
      openEditDirect(event);
    }
  }, [openEditDirect, isReadOnlyEvent]);

  const handleDeleteFromDetail = React.useCallback((event: CalendarEvent) => {
    if (isReadOnlyEvent(event)) { setDetailEvent(null); return; }
    setDetailEvent(null);
    if (event.recurrenceRules?.length || event.originalId) {
      setPendingAction({ kind: 'delete', event });
    } else {
      void deleteEvent(event.id);
    }
  }, [deleteEvent, isReadOnlyEvent]);

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
          <Text style={styles.headerTitle}>{headerTitle(viewMode, currentDate, calendarFirstDayOfWeek)}</Text>
          <Text style={styles.headerSubtitle}>
            {isSelectedToday ? 'Today' : format(selectedDate, 'EEE, MMM d')}
          </Text>
        </View>
        <View style={styles.headerActions}>
          {enableCalendarTasks && (
            <Pressable
              style={styles.headerBtn}
              onPress={() => setTasksVisible(true)}
              hitSlop={6}
            >
              <ListChecks size={20} color={c.text} />
            </Pressable>
          )}
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
            weekStartsOn={calendarFirstDayOfWeek}
            showWeekNumbers={calendarShowWeekNumbers}
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
            weekStartsOn={calendarFirstDayOfWeek}
            timeFormat={calendarTimeFormat}
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
        onRsvp={async (ev, participantId, status) => {
          await rsvpEvent(ev.id, participantId, status, buildReplyTo(ev));
          setDetailEvent((cur) =>
            cur && cur.id === ev.id && cur.participants?.[participantId]
              ? {
                  ...cur,
                  participants: {
                    ...cur.participants,
                    [participantId]: { ...cur.participants[participantId], participationStatus: status },
                  },
                }
              : cur,
          );
        }}
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
        onImport={() => { setSidebarVisible(false); setImportVisible(true); }}
        onManageSubscriptions={() => { setSidebarVisible(false); setSubscriptionsVisible(true); }}
        onSetDefault={(cal) => { void setDefaultCalendar(cal.id); }}
        onSetColor={(cal, color) => setSharedCalendarColor(sharedCalendarColorKey(cal), color)}
        onResetColor={(cal) => {
          // Drop the local override; the auto-assign effect picks a fresh
          // unused color (so it never reverts to a collision).
          removeSharedCalendarColor(sharedCalendarColorKey(cal));
        }}
      />

      <TasksSheet
        visible={tasksVisible}
        tasks={tasks}
        calendars={allCalendars}
        onClose={() => setTasksVisible(false)}
        onCreate={createTask}
        onToggle={toggleTaskComplete}
        onDelete={deleteTask}
      />

      <ICalImportSheet
        visible={importVisible}
        // Import batch-creates against the primary account, so only offer the
        // user's own calendars as targets.
        calendars={displayCalendars.filter((cal) => !cal.isShared)}
        onClose={() => setImportVisible(false)}
        onImport={importEvents}
      />

      <ICalSubscriptionSheet
        visible={subscriptionsVisible}
        onClose={() => setSubscriptionsVisible(false)}
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
