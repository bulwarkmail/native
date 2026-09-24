import React from 'react';
import {
  Alert,
  AppState,
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
  startOfWeek,
  endOfWeek,
  addDays,
  isToday,
  addMonths,
  subMonths,
  addWeeks,
  subWeeks,
  type Locale,
} from 'date-fns';
import { useCalendarLocale } from '../lib/calendar-locale';
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
import { CalendarEditSheet, type CalendarEditValues } from '../components/calendar/CalendarEditSheet';
import { CalendarShareSheet } from '../components/calendar/CalendarShareSheet';
import {
  computeScrollWindow,
  fixedScrollWindowState,
  freshScrollWindowState,
  growScrollWindow,
  loadedPartOfWindow,
  normalizeScrollWindowState,
  parseDayKey,
  scrollWindowLoadRange,
  windowStateForJump,
  type CalendarFocus,
  type ScrollWindowOptions,
  type ScrollWindowState,
} from '../lib/calendar-scroll-window';
import { coversRange, createRangeLoader } from '../lib/calendar-range-cache';
import {
  applySharedCalendarColors,
  buildEventDayIndex,
  dayKey,
  eventsOnDayFromIndex,
  getEventStartDate,
  getPrimaryCalendarId,
  getTaskDueDate,
  pickUnusedCalendarColor,
  sharedCalendarColorKey,
  type EventDayIndex,
  type TimeFormat,
} from '../lib/calendar-utils';
import { buildReplyTo } from '../lib/calendar-invitation';
import {
  buildAllScopeUpdates,
  buildFutureSeriesData,
  isRecurringSeriesMember,
  truncateRecurrenceRules,
} from '../lib/recurrence-overrides';
import { generateBirthdayEvents, createBirthdayCalendar, BIRTHDAY_CALENDAR_ID } from '../lib/birthday-calendar';
import { useContactsStore } from '../stores/contacts-store';
import { useLocaleStore } from '../stores/locale-store';
import { useUserCalendarAddresses } from '../lib/calendar-user-addresses';
import { useCalendarSubscriptionsStore } from '../stores/calendar-subscriptions-store';
import { startCalendarNotificationSync } from '../lib/calendar-notifications';
import { useCalendarReminderOpen } from '../lib/calendar-reminder-open';
import { shareEventICS } from '../lib/calendar-ics-export';
import * as Clipboard from 'expo-clipboard';
import type { Calendar, CalendarEvent, RecurrenceRule } from '../api/types';

type ViewMode = 'month' | 'week' | 'agenda';
type PendingAction =
  | {
      kind: 'edit';
      event: CalendarEvent;
      updates: Partial<CalendarEvent>;
      calendarId: string;
      sendScheduling?: boolean;
    }
  | { kind: 'delete'; event: CalendarEvent }
  | {
      kind: 'rsvp';
      event: CalendarEvent;
      participantId: string;
      status: 'accepted' | 'declined' | 'tentative';
    }
  | null;

// Events are loaded this many days past either end of the visible window, so
// the next arrow press or edge usually finds them there already.
const RANGE_MARGIN_DAYS = 14;

type WeekStart = 0 | 1 | 6;

function headerTitle(
  viewMode: ViewMode,
  currentDate: Date,
  weekStartsOn: WeekStart,
  locale: Locale,
): string {
  if (viewMode === 'month') return format(currentDate, 'MMMM yyyy', { locale });
  if (viewMode === 'week') {
    const start = startOfWeek(currentDate, { weekStartsOn });
    const end = endOfWeek(currentDate, { weekStartsOn });
    if (start.getMonth() === end.getMonth()) {
      return `${format(start, 'MMM d', { locale })} – ${format(end, 'd, yyyy', { locale })}`;
    }
    return `${format(start, 'MMM d', { locale })} – ${format(end, 'MMM d, yyyy', { locale })}`;
  }
  return format(currentDate, 'MMMM yyyy', { locale });
}

export default function CalendarScreen() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const currentUserEmails = useUserCalendarAddresses();
  const { locale } = useCalendarLocale();
  const calendarDefaultView = useSettingsStore((s) => s.calendarDefaultView);
  const calendarShowTimeInMonth = useSettingsStore((s) => s.calendarShowTimeInMonth);
  const showTasksOnCalendar = useSettingsStore((s) => s.showTasksOnCalendar);
  const calendarFirstDayOfWeek = useSettingsStore((s) => s.calendarFirstDayOfWeek);
  const calendarShowWeekNumbers = useSettingsStore((s) => s.calendarShowWeekNumbers);
  const calendarTimeFormat = useSettingsStore((s) => s.calendarTimeFormat);
  const showBirthdayCalendar = useSettingsStore((s) => s.showBirthdayCalendar);
  const enableCalendarTasks = useSettingsStore((s) => s.enableCalendarTasks);
  const sharedCalendarColors = useSettingsStore((s) => s.sharedCalendarColors);
  const setSharedCalendarColor = useSettingsStore((s) => s.setSharedCalendarColor);
  const removeSharedCalendarColor = useSettingsStore((s) => s.removeSharedCalendarColor);
  const contacts = useContactsStore((s) => s.contacts);

  const [selectedDate, setSelectedDate] = React.useState(() => new Date());
  // Day view falls back to Agenda on mobile (we don't have a dedicated day
  // grid yet, but the agenda already serves the same purpose).
  const initialViewMode: ViewMode =
    calendarDefaultView === 'week' ? 'week'
    : calendarDefaultView === 'day' || calendarDefaultView === 'agenda' ? 'agenda'
    : 'month';
  const [viewMode, setViewMode] = React.useState<ViewMode>(initialViewMode);

  // Scroll window (#759, webmail calendar-app): every view shows a window of
  // days around the day the user navigated to (the "focus"). The agenda
  // scrolls freely: reaching an edge widens that side and only the new days
  // are fetched. Month and week show exactly one period. Navigation moves the
  // focus and, when that leaves the window, starts a fresh window there.
  const windowOptions = React.useMemo<ScrollWindowOptions>(
    () => ({ weekStartsOn: calendarFirstDayOfWeek }),
    [calendarFirstDayOfWeek],
  );
  const [focus, setFocus] = React.useState<CalendarFocus>(() => ({ date: new Date(), nonce: 0 }));
  // The day the scrolled view shows at its top, while it differs from the focus.
  const [visibleDate, setVisibleDate] = React.useState<Date | null>(null);
  const [windowState, setWindowState] = React.useState<ScrollWindowState>(
    () => freshScrollWindowState(initialViewMode, new Date()),
  );
  const freeScroll = viewMode === 'agenda';
  const focusKey = dayKey(focus.date);
  const activeWindowState = React.useMemo(
    () =>
      freeScroll
        ? normalizeScrollWindowState(windowState, viewMode, parseDayKey(focusKey))
        : fixedScrollWindowState(viewMode, parseDayKey(focusKey)),
    [freeScroll, windowState, viewMode, focusKey],
  );
  React.useEffect(() => {
    if (freeScroll && activeWindowState !== windowState) setWindowState(activeWindowState);
  }, [freeScroll, activeWindowState, windowState]);
  const scrollWindow = React.useMemo(
    () => computeScrollWindow(activeWindowState, windowOptions),
    [activeWindowState, windowOptions],
  );
  // Changes whenever a fresh window starts; the views remount on it.
  const windowKey = `${activeWindowState.mode}:${activeWindowState.anchorKey}`;
  const loadRange = React.useMemo(() => {
    const { after, before } = scrollWindowLoadRange(scrollWindow, RANGE_MARGIN_DAYS);
    return { after: after.toISOString(), before: before.toISOString() };
  }, [scrollWindow]);

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
  const refresh = useCalendarStore((s) => s.refresh);
  const createEvent = useCalendarStore((s) => s.createEvent);
  const updateEvent = useCalendarStore((s) => s.updateEvent);
  const deleteEvent = useCalendarStore((s) => s.deleteEvent);
  const getMasterEvent = useCalendarStore((s) => s.getMasterEvent);
  const rsvpEvent = useCalendarStore((s) => s.rsvpEvent);
  const importEvents = useCalendarStore((s) => s.importEvents);
  const tasks = useCalendarStore((s) => s.tasks);
  const createTask = useCalendarStore((s) => s.createTask);
  const toggleTaskComplete = useCalendarStore((s) => s.toggleTaskComplete);
  const updateTask = useCalendarStore((s) => s.updateTask);
  const deleteTask = useCalendarStore((s) => s.deleteTask);
  // Task to open in the tasks sheet when a task chip on the grid is tapped.
  const [tasksInitialId, setTasksInitialId] = React.useState<string | null>(null);
  // A tapped reminder notification opens its event or task here.
  useCalendarReminderOpen({
    onEvent: setDetailEvent,
    onTask: (id) => { setTasksInitialId(id); setTasksVisible(true); },
  });
  const toggleCalendarVisibility = useCalendarStore((s) => s.toggleCalendarVisibility);
  const setDefaultCalendar = useCalendarStore((s) => s.setDefaultCalendar);
  const createCalendar = useCalendarStore((s) => s.createCalendar);
  const updateCalendar = useCalendarStore((s) => s.updateCalendar);
  const removeCalendar = useCalendarStore((s) => s.removeCalendar);
  const clearCalendarEvents = useCalendarStore((s) => s.clearCalendarEvents);
  const shareCalendar = useCalendarStore((s) => s.shareCalendar);
  // Calendar management sheets (create / edit / share) opened from the drawer.
  const [calendarEditTarget, setCalendarEditTarget] = React.useState<
    { mode: 'create' } | { mode: 'edit'; calendar: Calendar } | null
  >(null);
  const [shareTarget, setShareTarget] = React.useState<Calendar | null>(null);
  const syncDueSubscriptions = useCalendarSubscriptionsStore((s) => s.syncDue);
  const storeCalendars = useCalendarStore((s) => s.calendars);
  const taskOnlyCalendarIds = useCalendarStore((s) => s.taskOnlyCalendarIds);
  const hiddenCalendarIds = useCalendarStore((s) => s.hiddenCalendarIds);
  const loading = useCalendarStore((s) => s.loading);
  const error = useCalendarStore((s) => s.error);
  const storeEvents = useCalendarStore((s) => s.events);
  const loadedRange = useCalendarStore((s) => s.loadedRange);
  // The days of the window whose events are in (the agenda lists no day it
  // hasn't fetched).
  const loadedWindow = React.useMemo(
    () => loadedPartOfWindow(scrollWindow, loadedRange?.after, loadedRange?.before),
    [scrollWindow, loadedRange],
  );

  // The birthday calendar is a client-side virtual calendar: its events are
  // generated from contacts for the visible range and merged in alongside the
  // server calendars. Toggling it on/off is instant (no refetch).
  const birthdayEvents = React.useMemo(() => {
    if (!showBirthdayCalendar) return [];
    return generateBirthdayEvents(contacts, loadRange.after, loadRange.before);
  }, [showBirthdayCalendar, contacts, loadRange]);

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
  // Tasks with a due date are overlaid on the grid as chips (webmail's
  // showTasksOnCalendar); tapping one opens the tasks sheet on that task.
  const taskEvents = React.useMemo<CalendarEvent[]>(() => {
    if (!enableCalendarTasks || !showTasksOnCalendar) return [];
    const out: CalendarEvent[] = [];
    for (const task of tasks) {
      if (!task.due || task.progress === 'completed' || task.progress === 'cancelled') continue;
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(task.due);
      const allDay = !!task.showWithoutTime || dateOnly;
      out.push({
        ...task,
        id: `task:${task.id}`,
        start: dateOnly ? `${task.due}T00:00:00` : task.due,
        showWithoutTime: allDay,
        duration: allDay ? 'P1D' : 'PT30M',
        // The due is wall time in the task's zone; place the chip at the
        // instant, like events.
        utcStart: allDay ? undefined : getTaskDueDate(task)?.toISOString(),
        utcEnd: undefined,
        title: `☐ ${task.title || ''}`.trim(),
        recurrenceRules: undefined,
        recurrenceId: undefined,
      });
    }
    return out;
  }, [tasks, enableCalendarTasks, showTasksOnCalendar]);
  const allEvents = React.useMemo(
    () => (birthdayEvents.length > 0 || taskEvents.length > 0
      ? [...storeEvents, ...birthdayEvents, ...taskEvents]
      : storeEvents),
    [storeEvents, birthdayEvents, taskEvents],
  );

  // VTODO-only task lists (Todoist imports, per-project Thunderbird task
  // lists) are sibling CalDAV collections that Calendar/get returns alongside
  // event calendars. Their contents surface in the Tasks sheet, so keep them
  // out of the calendar drawer and out of the event/import calendar pickers —
  // listing them as calendars just produces duplicate/confusing entries. (#28)
  const eventCalendars = React.useMemo(() => {
    if (taskOnlyCalendarIds.length === 0) return allCalendars;
    const taskOnly = new Set(taskOnlyCalendarIds);
    return allCalendars.filter((cal) => !taskOnly.has(cal.id));
  }, [allCalendars, taskOnlyCalendarIds]);

  // The Tasks sheet keeps the full list but with task lists sorted first, so
  // its create-picker (which defaults to the first writable calendar) targets
  // a dedicated task list when the account has one.
  const taskSheetCalendars = React.useMemo(() => {
    if (taskOnlyCalendarIds.length === 0) return allCalendars;
    const taskOnly = new Set(taskOnlyCalendarIds);
    return [...allCalendars].sort(
      (a, b) => Number(taskOnly.has(b.id)) - Number(taskOnly.has(a.id)),
    );
  }, [allCalendars, taskOnlyCalendarIds]);

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
    // Reminders already sync from launch; opening the calendar may also ask
    // for notification permission.
    startCalendarNotificationSync({ askPermission: true });
  }, [hydrate, fetchCalendarsAction]);

  // Refresh iCal subscriptions whose interval elapsed: on mount and whenever
  // the app returns to the foreground (like the webmail's periodic refresh).
  React.useEffect(() => {
    void syncDueSubscriptions();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncDueSubscriptions();
    });
    return () => sub.remove();
  }, [syncDueSubscriptions]);

  // Load the window's events: one fetch at a time, and only the days not
  // loaded yet (calendar-store extendRange). `loadingEdge` is the side an
  // extension asked for, until the wider window is in.
  const [rangeLoading, setRangeLoading] = React.useState(false);
  const [loadingEdge, setLoadingEdge] = React.useState<'start' | 'end' | null>(null);
  const loadingEdgeRef = React.useRef<'start' | 'end' | null>(null);
  const [rangeLoader] = React.useState(() =>
    createRangeLoader(
      (range) => useCalendarStore.getState().extendRange(range.after, range.before),
      (busy) => {
        setRangeLoading(busy);
        if (!busy) {
          loadingEdgeRef.current = null;
          setLoadingEdge(null);
        }
      },
    ),
  );
  // Ask again whenever the loaded range changes without covering the
  // window: a refresh that started before an extension landed writes the
  // smaller range back. A failed extension is retried by the next refresh
  // (pull, push, reconnect) or when calendars arrive after sign-in. A
  // covered window costs nothing (extendRange returns at once).
  React.useEffect(() => {
    if (coversRange(useCalendarStore.getState().loadedRange, loadRange) && !rangeLoader.isBusy()) return;
    void rangeLoader.request(loadRange);
  }, [rangeLoader, loadRange, loadedRange, storeCalendars]);

  const jumpTo = React.useCallback(
    (date: Date) => {
      setSelectedDate(date);
      setVisibleDate(null);
      setFocus((prev) => ({ date, nonce: prev.nonce + 1 }));
      setWindowState((prev) => windowStateForJump(prev, viewMode, date, windowOptions));
    },
    [viewMode, windowOptions],
  );

  const extendWindow = React.useCallback(
    (side: 'before' | 'after') => {
      if (loadingEdgeRef.current) return;
      const edge = side === 'before' ? 'start' : 'end';
      loadingEdgeRef.current = edge;
      setLoadingEdge(edge);
      setWindowState((prev) =>
        growScrollWindow(normalizeScrollWindowState(prev, viewMode, focus.date), side),
      );
    },
    [viewMode, focus.date],
  );
  const extendWindowStart = React.useCallback(() => extendWindow('before'), [extendWindow]);
  const extendWindowEnd = React.useCallback(() => extendWindow('after'), [extendWindow]);

  // The arrows step from what is on screen, which may have been scrolled
  // away from the focused day.
  const goPrev = React.useCallback(() => {
    const base = visibleDate ?? focus.date;
    jumpTo(viewMode === 'week' ? subWeeks(base, 1) : subMonths(base, 1));
  }, [viewMode, visibleDate, focus.date, jumpTo]);

  const goNext = React.useCallback(() => {
    const base = visibleDate ?? focus.date;
    jumpTo(viewMode === 'week' ? addWeeks(base, 1) : addMonths(base, 1));
  }, [viewMode, visibleDate, focus.date, jumpTo]);

  const goToday = React.useCallback(() => {
    jumpTo(new Date());
  }, [jumpTo]);

  // Switching views keeps the period on screen in view.
  const changeViewMode = React.useCallback(
    (mode: ViewMode) => {
      if (mode === viewMode) return;
      const date = visibleDate ?? focus.date;
      setViewMode(mode);
      setVisibleDate(null);
      setFocus((prev) => ({ date, nonce: prev.nonce + 1 }));
      setWindowState(freshScrollWindowState(mode, date));
    },
    [viewMode, visibleDate, focus.date],
  );

  // Picking a day only moves the selection; the view stays where it is.
  const handleSelectDate = React.useCallback((date: Date) => {
    setSelectedDate(date);
  }, []);

  const openCreate = React.useCallback((date?: Date) => {
    setModalEvent(null);
    setModalDate(date);
    setModalVisible(true);
  }, []);

  // Task chips route to the tasks sheet; everything else opens the detail sheet.
  const handleSelectEvent = React.useCallback((event: CalendarEvent) => {
    if (event.id.startsWith('task:')) {
      setTasksInitialId(event.id.slice('task:'.length));
      setTasksVisible(true);
      return;
    }
    setDetailEvent(event);
  }, []);

  const openEditDirect = React.useCallback((event: CalendarEvent) => {
    setModalEvent(event);
    setModalDate(undefined);
    setModalVisible(true);
  }, []);

  // Client-side iCal subscriptions mirror a remote feed into a local
  // calendar; edits there would be wiped by the next sync, so they're
  // read-only targets everywhere (#762).
  const subscriptions = useCalendarSubscriptionsStore((s) => s.subscriptions);
  const isSubscriptionCalendar = React.useCallback(
    (calendarId: string) => subscriptions.some((s) => s.calendarId === calendarId),
    [subscriptions],
  );

  const isReadOnlyEvent = React.useCallback(
    (event: CalendarEvent) =>
      !!event.calendarIds?.[BIRTHDAY_CALENDAR_ID] ||
      Object.keys(event.calendarIds ?? {}).some(isSubscriptionCalendar),
    [isSubscriptionCalendar],
  );

  // Editing a series member opens the editor directly; the this/future/all
  // scope question is asked on save (like webmail), once we know the edits.
  const handleEditFromDetail = React.useCallback((event: CalendarEvent) => {
    if (isReadOnlyEvent(event)) { setDetailEvent(null); return; }
    setDetailEvent(null);
    openEditDirect(event);
  }, [openEditDirect, isReadOnlyEvent]);

  const reportError = React.useCallback(
    (err: unknown) => {
      Alert.alert(
        t('calendar.notifications.event_error', 'Something went wrong'),
        err instanceof Error ? err.message : undefined,
      );
    },
    [t],
  );

  const handleDeleteFromDetail = React.useCallback((event: CalendarEvent) => {
    if (isReadOnlyEvent(event)) { setDetailEvent(null); return; }
    setDetailEvent(null);
    if (isRecurringSeriesMember(event)) {
      setPendingAction({ kind: 'delete', event });
    } else {
      deleteEvent(event.id).catch(reportError);
    }
  }, [deleteEvent, isReadOnlyEvent, reportError]);

  // "This and following": end the master at the occurrence and hand back the
  // master plus its untouched rules so the caller can start a new series (or
  // roll back). Port of webmail's truncateRecurrenceAtEvent.
  const truncateRecurrenceAtEvent = React.useCallback(
    async (event: CalendarEvent) => {
      const master = await getMasterEvent(event);
      if (!master) return null;
      const originalRules = master.recurrenceRules
        ? (JSON.parse(JSON.stringify(master.recurrenceRules)) as RecurrenceRule[])
        : null;
      await updateEvent(master.id, {
        recurrenceRules: truncateRecurrenceRules(master.recurrenceRules, event),
      });
      return { master, originalRules };
    },
    [getMasterEvent, updateEvent],
  );

  // Send an answer and show it in the open detail sheet. 'occurrence'
  // answers just that occurrence of a series.
  const submitRsvp = React.useCallback(
    async (
      ev: CalendarEvent,
      participantId: string,
      status: 'accepted' | 'declined' | 'tentative',
      scope: 'occurrence' | 'series',
    ) => {
      await rsvpEvent(ev.id, participantId, status, buildReplyTo(ev), undefined, scope);
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
    },
    [rsvpEvent],
  );

  const handleScopeSelect = React.useCallback(
    async (scope: RecurrenceEditScope) => {
      const action = pendingAction;
      setPendingAction(null);
      if (!action) return;
      const { event } = action;
      if (action.kind === 'rsvp') {
        try {
          await submitRsvp(event, action.participantId, action.status, scope === 'this' ? 'occurrence' : 'series');
        } catch (err) {
          Alert.alert(
            t('calendar.notifications.rsvp_error', 'Failed to update response'),
            err instanceof Error ? err.message : undefined,
          );
        }
        return;
      }
      try {
        if (action.kind === 'edit') {
          const { updates } = action;
          const opts = { sendSchedulingMessages: action.sendScheduling };
          switch (scope) {
            case 'this': {
              // The store keeps the change on this occurrence: through its
              // own (synthetic) id, or as a recurrence override on the event
              // it was expanded from.
              await updateEvent(event.id, updates, opts);
              break;
            }
            case 'this_and_future': {
              const result = await truncateRecurrenceAtEvent(event);
              if (!result) throw new Error('Master event not found');
              const { master, originalRules } = result;
              const newEventData = buildFutureSeriesData(master, originalRules, event, updates);
              delete newEventData.calendarIds;
              const targetCalendarId =
                action.calendarId || getPrimaryCalendarId(master) || '';
              try {
                await createEvent(newEventData, targetCalendarId, opts);
              } catch (createError) {
                // Roll back the truncation so the series isn't left cut short.
                try {
                  await updateEvent(master.id, { recurrenceRules: originalRules ?? [] });
                } catch {
                  // The rollback failing is reported through the original error.
                }
                throw createError;
              }
              break;
            }
            case 'all': {
              const master = await getMasterEvent(event);
              if (!master) throw new Error('Master event not found');
              await updateEvent(master.id, buildAllScopeUpdates(updates, event, master), opts);
              break;
            }
          }
        } else {
          switch (scope) {
            case 'this': {
              // The store destroys a server occurrence, or excludes one the
              // device expanded on its base event.
              await deleteEvent(event.id);
              break;
            }
            case 'this_and_future': {
              const result = await truncateRecurrenceAtEvent(event);
              if (!result) throw new Error('Master event not found');
              break;
            }
            case 'all': {
              const master = await getMasterEvent(event);
              if (!master) throw new Error('Master event not found');
              await deleteEvent(master.id);
              break;
            }
          }
        }
      } catch (err) {
        Alert.alert(
          t('calendar.notifications.event_error', 'Something went wrong'),
          err instanceof Error ? err.message : undefined,
        );
      }
      try {
        await refresh();
      } catch {
        // Best effort — the next navigation refetches anyway.
      }
    },
    [pendingAction, updateEvent, deleteEvent, createEvent, getMasterEvent, truncateRecurrenceAtEvent, refresh, submitRsvp, t],
  );

  const handleSave = React.useCallback(
    async (
      data: Partial<CalendarEvent>,
      calendarId: string,
      options?: { sendSchedulingMessages?: boolean },
    ) => {
      const sendScheduling = options?.sendSchedulingMessages;
      if (modalEvent) {
        const updates: Partial<CalendarEvent> = { ...data };
        // Moving the event to another calendar: the store remaps the store id
        // onto the owning account's raw calendar id.
        if (calendarId && calendarId !== getPrimaryCalendarId(modalEvent)) {
          updates.calendarIds = { [calendarId]: true };
        }
        if (isRecurringSeriesMember(modalEvent)) {
          // Ask which occurrences the edit applies to; the actual write
          // happens in handleScopeSelect.
          setPendingAction({ kind: 'edit', event: modalEvent, updates, calendarId, sendScheduling });
          return;
        }
        await updateEvent(modalEvent.id, updates, { sendSchedulingMessages: sendScheduling });
      } else {
        await createEvent(data, calendarId, { sendSchedulingMessages: sendScheduling });
      }
    },
    [modalEvent, createEvent, updateEvent],
  );

  const handleDeleteFromModal = React.useCallback(
    async (event: CalendarEvent) => {
      setModalVisible(false);
      if (isRecurringSeriesMember(event)) {
        setPendingAction({ kind: 'delete', event });
        return;
      }
      await deleteEvent(event.id).catch(reportError);
    },
    [deleteEvent, reportError],
  );

  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  // The store flips the checkbox optimistically and reverts it when the
  // server refuses; say so instead of leaving the user guessing.
  const handleToggleTask = React.useCallback(
    (id: string) => {
      toggleTaskComplete(id).catch((err: unknown) => {
        Alert.alert(
          t('calendar.tasks.update_error', 'Failed to update task'),
          err instanceof Error ? err.message : undefined,
        );
      });
    },
    [toggleTaskComplete, t],
  );

  const handleDeleteTask = React.useCallback(
    (id: string) => {
      deleteTask(id).catch((err: unknown) => {
        Alert.alert(
          t('calendar.tasks.delete_error', 'Failed to delete task'),
          err instanceof Error ? err.message : undefined,
        );
      });
    },
    [deleteTask, t],
  );

  // Clone the event one day later and open it in the editor (webmail's
  // handleDuplicateFromDetail).
  const handleDuplicateFromDetail = React.useCallback(
    async (event: CalendarEvent) => {
      setDetailEvent(null);
      const newStart = addDays(getEventStartDate(event), 1);
      const data: Partial<CalendarEvent> = {
        title: event.title,
        description: event.description,
        start: event.showWithoutTime
          ? format(newStart, "yyyy-MM-dd'T'00:00:00")
          : format(newStart, "yyyy-MM-dd'T'HH:mm:ss"),
        duration: event.duration,
        timeZone: event.timeZone,
        showWithoutTime: event.showWithoutTime,
        status: 'confirmed',
        freeBusyStatus: event.freeBusyStatus,
      };
      if (event.locations) data.locations = JSON.parse(JSON.stringify(event.locations));
      if (event.virtualLocations) data.virtualLocations = JSON.parse(JSON.stringify(event.virtualLocations));
      if (event.recurrenceRules?.length) data.recurrenceRules = JSON.parse(JSON.stringify(event.recurrenceRules));
      if (event.alerts) data.alerts = JSON.parse(JSON.stringify(event.alerts));
      const calendarId = getPrimaryCalendarId(event) || '';
      try {
        const created = await createEvent(data, calendarId);
        const stored = useCalendarStore.getState().events.find((e) => e.id === created.id) ?? created;
        openEditDirect(stored);
      } catch (err) {
        reportError(err);
      }
    },
    [createEvent, openEditDirect, reportError],
  );

  const handleExportFromDetail = React.useCallback(
    (event: CalendarEvent) => {
      shareEventICS(event).catch(reportError);
    },
    [reportError],
  );

  const handleCopyLink = React.useCallback(
    (_event: CalendarEvent, link: string) => {
      Clipboard.setStringAsync(link).catch(reportError);
    },
    [reportError],
  );

  const handleCalendarEditSave = React.useCallback(
    async (values: CalendarEditValues) => {
      if (!calendarEditTarget) return;
      if (calendarEditTarget.mode === 'create') {
        await createCalendar(values.name, values.color, values.description);
      } else {
        await updateCalendar(calendarEditTarget.calendar.id, {
          name: values.name,
          color: values.color,
          description: values.description || null,
        });
      }
    },
    [calendarEditTarget, createCalendar, updateCalendar],
  );

  const handleSetCalendarColor = React.useCallback(
    (cal: Calendar, color: string) => {
      if (cal.isShared) {
        // Per-viewer recolor (#345): the owner's colour is left alone.
        setSharedCalendarColor(sharedCalendarColorKey(cal), color);
        return;
      }
      updateCalendar(cal.id, { color }).catch(reportError);
    },
    [setSharedCalendarColor, updateCalendar, reportError],
  );

  const handleClearCalendar = React.useCallback(
    (cal: Calendar) => {
      Alert.alert(
        t('calendar.management.clear_title', 'Remove all events?'),
        t(
          'calendar.management.clear_description',
          'Every event in this calendar will be deleted. Events that also belong to another calendar are only unlinked.',
        ),
        [
          { text: t('common.cancel', 'Cancel'), style: 'cancel' },
          {
            text: t('calendar.management.clear_confirm', 'Remove all'),
            style: 'destructive',
            onPress: () => { clearCalendarEvents(cal.id).catch(reportError); },
          },
        ],
      );
    },
    [t, clearCalendarEvents, reportError],
  );

  const handleDeleteCalendar = React.useCallback(
    (cal: Calendar) => {
      Alert.alert(
        t('calendar.management.delete_title', 'Delete calendar?'),
        t(
          'calendar.management.delete_description',
          'The calendar and all of its events will be deleted. This cannot be undone.',
        ),
        [
          { text: t('common.cancel', 'Cancel'), style: 'cancel' },
          {
            text: t('common.delete', 'Delete'),
            style: 'destructive',
            onPress: () => { removeCalendar(cal.id).catch(reportError); },
          },
        ],
      );
    },
    [t, removeCalendar, reportError],
  );

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
          <Text style={styles.headerTitle}>
            {headerTitle(viewMode, visibleDate ?? focus.date, calendarFirstDayOfWeek, locale)}
          </Text>
          <Text style={styles.headerSubtitle}>
            {isSelectedToday
              ? t('calendar.views.today', 'Today')
              : format(selectedDate, 'EEE, MMM d', { locale })}
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
                  onPress={() => changeViewMode(mode)}
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
          {t('calendar.views.today', 'Today')}
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
            currentDate={focus.date}
            selectedDate={selectedDate}
            events={events}
            eventsByDay={eventsByDay}
            calendars={calendars}
            weekStartsOn={calendarFirstDayOfWeek}
            showWeekNumbers={calendarShowWeekNumbers}
            showTimeInMonthView={calendarShowTimeInMonth}
            timeFormat={calendarTimeFormat}
            onSelectDate={handleSelectDate}
            onLongPressDate={openCreate}
          />
        )}
        {viewMode === 'week' && (
          <WeekView
            weekDate={focus.date}
            selectedDate={selectedDate}
            events={events}
            eventsByDay={eventsByDay}
            calendars={calendars}
            weekStartsOn={calendarFirstDayOfWeek}
            timeFormat={calendarTimeFormat}
            onSelectDate={handleSelectDate}
            onSelectEvent={handleSelectEvent}
            onCreateAtTime={openCreate}
          />
        )}
        {viewMode === 'agenda' && (
          <AgendaView
            key={windowKey}
            focus={focus}
            window={scrollWindow}
            loaded={loadedWindow}
            onExtendStart={scrollWindow.canExtendStart && freeScroll ? extendWindowStart : undefined}
            onExtendEnd={scrollWindow.canExtendEnd && freeScroll ? extendWindowEnd : undefined}
            loadingEdge={loadingEdge}
            isLoading={rangeLoading}
            onVisibleDateChange={setVisibleDate}
            events={events}
            eventsByDay={eventsByDay}
            calendars={calendars}
            timeFormat={calendarTimeFormat}
            onSelectEvent={handleSelectEvent}
          />
        )}

        {viewMode === 'month' && (
          <View style={styles.dayDetail}>
            <View style={styles.dayDetailHeader}>
              <Text style={styles.dayDetailTitle}>
                {isSelectedToday
                  ? t('calendar.events.today_header', 'Today')
                  : format(selectedDate, 'EEEE, MMMM d', { locale })}
              </Text>
              {loading && <ActivityIndicator size="small" color={c.textMuted} />}
            </View>
            <DayEventList
              date={selectedDate}
              eventsByDay={eventsByDay}
              calendars={calendars}
              timeFormat={calendarTimeFormat}
              onSelectEvent={handleSelectEvent}
              refreshing={refreshing}
              onRefresh={onRefresh}
            />
          </View>
        )}
      </View>

      <EventDetailSheet
        event={detailEvent}
        calendars={calendars}
        timeFormat={calendarTimeFormat}
        currentUserEmails={currentUserEmails}
        isSubscriptionCalendar={isSubscriptionCalendar}
        onClose={() => setDetailEvent(null)}
        onEdit={handleEditFromDetail}
        onDelete={handleDeleteFromDetail}
        onDuplicate={(ev) => { if (!isReadOnlyEvent(ev)) void handleDuplicateFromDetail(ev); }}
        onExport={handleExportFromDetail}
        onCopyLink={handleCopyLink}
        onRsvp={async (ev, participantId, status) => {
          // An answer on one occurrence of a series asks whether it covers
          // just that occurrence or the whole series (webmail #1086).
          if (ev.recurrenceId) {
            setPendingAction({ kind: 'rsvp', event: ev, participantId, status });
            return;
          }
          await submitRsvp(ev, participantId, status, 'series');
        }}
      />

      <EventModal
        visible={modalVisible}
        event={modalEvent}
        calendars={eventCalendars}
        defaultDate={modalDate}
        currentUserEmails={currentUserEmails}
        isSubscriptionCalendar={isSubscriptionCalendar}
        onSave={handleSave}
        onDelete={handleDeleteFromModal}
        onClose={() => setModalVisible(false)}
      />

      <RecurrenceScopeDialog
        visible={!!pendingAction}
        actionType={pendingAction?.kind ?? 'edit'}
        onSelect={handleScopeSelect}
        onClose={() => setPendingAction(null)}
      />

      <CalendarSidebarDrawer
        visible={sidebarVisible}
        calendars={eventCalendars}
        hiddenCalendarIds={hiddenCalendarIds}
        onToggle={toggleCalendarVisibility}
        onClose={() => setSidebarVisible(false)}
        onImport={() => { setSidebarVisible(false); setImportVisible(true); }}
        onManageSubscriptions={() => { setSidebarVisible(false); setSubscriptionsVisible(true); }}
        onCreate={() => { setSidebarVisible(false); setCalendarEditTarget({ mode: 'create' }); }}
        onSetDefault={(cal) => { setDefaultCalendar(cal.id).catch(reportError); }}
        onSetColor={handleSetCalendarColor}
        onResetColor={(cal) => {
          // Drop the local override; the auto-assign effect picks a fresh
          // unused color (so it never reverts to a collision).
          removeSharedCalendarColor(sharedCalendarColorKey(cal));
        }}
        onRename={(cal) => { setSidebarVisible(false); setCalendarEditTarget({ mode: 'edit', calendar: cal }); }}
        onShare={(cal) => { setSidebarVisible(false); setShareTarget(cal); }}
        onClear={handleClearCalendar}
        onDelete={handleDeleteCalendar}
        isSubscriptionCalendar={isSubscriptionCalendar}
      />

      <TasksSheet
        visible={tasksVisible}
        tasks={tasks}
        calendars={taskSheetCalendars}
        timeFormat={calendarTimeFormat}
        initialTaskId={tasksInitialId}
        onClose={() => { setTasksVisible(false); setTasksInitialId(null); }}
        onCreate={createTask}
        onUpdate={updateTask}
        onToggle={handleToggleTask}
        onDelete={handleDeleteTask}
      />

      <ICalImportSheet
        visible={importVisible}
        // Import batch-creates against the primary account, so only offer the
        // user's own event calendars (no shared calendars, no task lists) as
        // targets.
        calendars={eventCalendars.filter(
          (cal) => !cal.isShared && cal.id !== BIRTHDAY_CALENDAR_ID,
        )}
        onClose={() => setImportVisible(false)}
        onImport={importEvents}
      />

      <ICalSubscriptionSheet
        visible={subscriptionsVisible}
        onClose={() => setSubscriptionsVisible(false)}
      />

      <CalendarEditSheet
        visible={!!calendarEditTarget}
        calendar={calendarEditTarget?.mode === 'edit' ? calendarEditTarget.calendar : null}
        onSave={handleCalendarEditSave}
        onClose={() => setCalendarEditTarget(null)}
      />

      <CalendarShareSheet
        calendar={shareTarget}
        onShare={shareCalendar}
        onClose={() => setShareTarget(null)}
      />
    </SafeAreaView>
  );
}

function DayEventList({
  date,
  eventsByDay,
  calendars,
  timeFormat,
  onSelectEvent,
  refreshing,
  onRefresh,
}: {
  date: Date;
  eventsByDay: EventDayIndex;
  calendars: Calendar[];
  timeFormat?: TimeFormat;
  onSelectEvent?: (event: CalendarEvent) => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
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
        <Text style={styles.emptyTitle}>{t('calendar.events.no_events', 'No events')}</Text>
        <Text style={styles.emptySubtitle}>{t('calendar.events.tap_to_create', 'Tap + to create one')}</Text>
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
          timeFormat={timeFormat}
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
