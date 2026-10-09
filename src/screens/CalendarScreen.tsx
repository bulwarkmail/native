import React from 'react';
import {
  Alert,
  AppState,
  I18nManager,
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
  Calendar1,
  CalendarDays,
  LayoutGrid,
  List as ListIcon,
  ListChecks,
  Menu,
} from 'lucide-react-native';
import {
  addDays,
  subDays,
  addWeeks,
  subWeeks,
} from 'date-fns';
import { useCalendarLocale } from '../lib/calendar-locale';
import { dayLabelFor, headerTitleFor } from '../lib/calendar-system';
import { displayNow, isDisplayToday } from '../lib/calendar-timezone';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { Button } from '../components';
import { useCalendarStore, type EventAccount } from '../stores/calendar-store';
import { useSettingsStore } from '../stores/settings-store';
import { MonthView } from '../components/calendar/MonthView';
import { MonthScrollView } from '../components/calendar/MonthScrollView';
import { WeekView } from '../components/calendar/WeekView';
import { TimeGridScrollView } from '../components/calendar/TimeGridScrollView';
import { AgendaView } from '../components/calendar/AgendaView';
import { EventCard } from '../components/calendar/EventCard';
import { EventDetailSheet } from '../components/calendar/EventDetailSheet';
import { EventModal } from '../components/calendar/EventModal';
import {
  RecurrenceScopeDialog,
  type RecurrenceEditScope,
} from '../components/calendar/RecurrenceScopeDialog';
import { CalendarSidebarDrawer } from '../components/calendar/CalendarSidebarDrawer';
import { calendarTaskEvents, isTaskEvent, runUnlessInFlight, taskIdOfEvent, withoutDoneTasks, withoutTasks } from '../lib/calendar-tasks';
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
  addDaysToLocalDateTime,
  applySharedCalendarColors,
  buildEventDayIndex,
  dayKey,
  eventsOnDayFromIndex,
  getEventStartDate,
  getPrimaryCalendarId,
  legacySharedCalendarColorKey,
  pickUnusedCalendarColor,
  sharedCalendarColorFor,
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
import { useAccountSubscriptions, useCalendarSubscriptionsStore } from '../stores/calendar-subscriptions-store';
import { startCalendarNotificationSync } from '../lib/calendar-notifications';
import { useCalendarReminderOpen } from '../lib/calendar-reminder-open';
import { usePendingCalendarOpen } from '../navigation/pending-calendar-open';
import { writeFollowingSeries } from '../lib/following-series';
import { saveWithSchedulingFallback } from '../lib/scheduling-denied';
import { createAccountCapture } from '../lib/captured-account';
import { buildNoteUpdate, noteSaveOptions } from '../lib/event-note';
import { toast } from '../stores/toast-store';
import { useEmailStore, requireShownAccountScope, isShownAccount, AccountNotServedError } from '../stores/email-store';
import { shareEventICS } from '../lib/calendar-ics-export';
import * as Clipboard from 'expo-clipboard';
import type { Calendar, CalendarEvent, RecurrenceRule } from '../api/types';

const withCapturedAccount = createAccountCapture(isShownAccount, () => new AccountNotServedError('switched'));

type ViewMode = 'month' | 'week' | 'day' | 'agenda';
type PendingAction =
  | {
      kind: 'edit';
      event: CalendarEvent;
      updates: Partial<CalendarEvent>;
      calendarId: string;
      sendScheduling?: boolean;
      account: EventAccount;
    }
  | { kind: 'delete'; event: CalendarEvent; account: EventAccount }
  | {
      kind: 'rsvp';
      account: EventAccount;
      event: CalendarEvent;
      participantId: string;
      status: 'accepted' | 'declined' | 'tentative';
    }
  | null;

// Events are loaded this many days past either end of the visible window, so
// the next arrow press or edge usually finds them there already.
const RANGE_MARGIN_DAYS = 14;

type WeekStart = 0 | 1 | 6;

// `firstDay`: the scrolled week grid reports the first column in view; the
// title then spans the seven days from there instead of the focused week.
/** Ask whether to save an event without the invitations the server refused to send. */
function confirmSaveWithoutInvitations(
  reason: string,
  t: ReturnType<typeof useLocaleStore.getState>['t'],
): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      t('calendar.notifications.invitations_denied_title', "Invitations can't be sent"),
      t(
        'calendar.notifications.invitations_denied',
        'The server refused to send the invitations: {reason}. Save the event without sending them?',
        { reason },
      ),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel', onPress: () => resolve(false) },
        {
          text: t('calendar.notifications.save_without_invitations', 'Save without invitations'),
          onPress: () => resolve(true),
        },
      ],
      { onDismiss: () => resolve(false) },
    );
  });
}

export default function CalendarScreen() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const currentUserEmails = useUserCalendarAddresses();
  const { locale, calendar } = useCalendarLocale();
  const calendarDefaultView = useSettingsStore((s) => s.calendarDefaultView);
  const calendarShowTimeInMonth = useSettingsStore((s) => s.calendarShowTimeInMonth);
  const showTasksOnCalendar = useSettingsStore((s) => s.showTasksOnCalendar);
  const calendarFirstDayOfWeek = useSettingsStore((s) => s.calendarFirstDayOfWeek);
  const calendarShowWeekNumbers = useSettingsStore((s) => s.calendarShowWeekNumbers);
  const calendarFreeScroll = useSettingsStore((s) => s.calendarFreeScroll);
  const calendarTimeFormat = useSettingsStore((s) => s.calendarTimeFormat);
  const showBirthdayCalendar = useSettingsStore((s) => s.showBirthdayCalendar);
  const birthdayCalendarColor = useSettingsStore((s) => s.birthdayCalendarColor);
  const enableCalendarTasks = useSettingsStore((s) => s.enableCalendarTasks);
  const sharedCalendarColors = useSettingsStore((s) => s.sharedCalendarColors);
  const setSharedCalendarColor = useSettingsStore((s) => s.setSharedCalendarColor);
  const removeSharedCalendarColor = useSettingsStore((s) => s.removeSharedCalendarColor);
  const contacts = useContactsStore((s) => s.contacts);
  const calendarTimeZone = useSettingsStore((s) => s.calendarTimeZone);

  // "Today" is the day on a clock in the calendar's time zone.
  const [selectedDate, setSelectedDate] = React.useState(displayNow);
  const initialViewMode: ViewMode =
    calendarDefaultView === 'week' || calendarDefaultView === 'day' || calendarDefaultView === 'agenda'
      ? calendarDefaultView
      : 'month';
  const [viewMode, setViewMode] = React.useState<ViewMode>(initialViewMode);

  // Scroll window (#759, webmail calendar-app): every view shows a window of
  // days around the day the user navigated to (the "focus"). With free
  // scrolling (the default) the views scroll continuously: reaching an edge
  // widens that side and only the new days are fetched. Otherwise a view
  // shows exactly one period. Navigation moves the focus and, when that
  // leaves the window, starts a fresh window there.
  const windowOptions = React.useMemo<ScrollWindowOptions>(
    () => ({ weekStartsOn: calendarFirstDayOfWeek, calendar }),
    [calendarFirstDayOfWeek, calendar],
  );
  const [focus, setFocus] = React.useState<CalendarFocus>(() => ({ date: displayNow(), nonce: 0 }));
  // The day the scrolled view shows at its top, while it differs from the focus.
  const [visibleDate, setVisibleDate] = React.useState<Date | null>(null);
  const [windowState, setWindowState] = React.useState<ScrollWindowState>(
    () => freshScrollWindowState(initialViewMode, displayNow()),
  );
  // The sideways-scrolling week and day grids assume a left-to-right strip;
  // right-to-left layouts keep them paged.
  const freeScroll =
    calendarFreeScroll && ((viewMode !== 'week' && viewMode !== 'day') || !I18nManager.isRTL);
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

  const [detailEvent, setDetailEventState] = React.useState<CalendarEvent | null>(null);
  // The app account the open event sheet / editor / scope question belongs to,
  // taken when it opened. Ids repeat across accounts (Stalwart numbers them
  // per account), so every write names it and the store refuses once another
  // account is shown (see `EventAccount`); the sheets close on a switch below.
  const eventAppAccountId = React.useRef<string | null>(useEmailStore.getState().activeAccountId);
  const captureEventAccount = React.useCallback(() => {
    eventAppAccountId.current = useEmailStore.getState().activeAccountId;
  }, []);
  const setDetailEvent = React.useCallback<React.Dispatch<React.SetStateAction<CalendarEvent | null>>>(
    (next) => {
      // Opening an event (not updating the open one) binds it to the shown account.
      if (next && typeof next !== 'function') captureEventAccount();
      setDetailEventState(next);
    },
    [captureEventAccount],
  );
  /** The account the open sheets belong to, for a write that isn't about one event. */
  const screenAccount = React.useCallback(
    (): EventAccount => {
      eventAppAccountId.current ??= useEmailStore.getState().activeAccountId;
      return { appAccountId: eventAppAccountId.current };
    },
    [],
  );
  /** The account pair a write on `event` names, from the account its sheet opened in. */
  const accountOf = React.useCallback(
    (event: CalendarEvent): EventAccount => ({
      appAccountId: screenAccount().appAccountId,
      jmapAccountId: event.accountId || undefined,
    }),
    [screenAccount],
  );
  const [modalEvent, setModalEvent] = React.useState<CalendarEvent | null>(null);
  const [modalDate, setModalDate] = React.useState<Date | undefined>(undefined);
  const [modalVisible, setModalVisible] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<PendingAction>(null);
  const [sidebarVisible, setSidebarVisible] = React.useState(false);
  const [tasksVisible, setTasksVisible] = React.useState(false);
  const [importVisible, setImportVisible] = React.useState(false);
  const [subscriptionsVisible, setSubscriptionsVisible] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  // Another account is shown: whatever was open belongs to the one before.
  // Close it, so a Delete, Edit or answer can't land on the other account's
  // event with the same id.
  const shownAccountId = useEmailStore((st) => st.activeAccountId);
  const lastShownAccountId = React.useRef(shownAccountId);
  React.useEffect(() => {
    if (lastShownAccountId.current === shownAccountId) return;
    lastShownAccountId.current = shownAccountId;
    // Not rewritten to the new account: a flow that decided its account before
    // the switch carries that value; the next sheet captures the new one.
    eventAppAccountId.current = null;
    setDetailEventState(null);
    setModalVisible(false);
    setPendingAction(null);
    setTasksVisible(false);
    setTasksInitialId(null);
    setSidebarVisible(false);
    setImportVisible(false);
    setSubscriptionsVisible(false);
    setCalendarEditTarget(null);
    setShareTarget(null);
  }, [shownAccountId]);

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
  // Set to jumpTo below; a reminder resolves asynchronously.
  const jumpToRef = React.useRef<(date: Date) => void>(() => {});
  // The sheet opens bound to the account the target was opened in (not
  // whichever is shown when it resolves), and not at all once that one isn't.
  useCalendarReminderOpen({
    onEvent: (event, account) => {
      if (!isShownAccount(account.appAccountId)) return;
      eventAppAccountId.current = account.appAccountId;
      setDetailEventState(event);
      // Its day comes into view behind the sheet.
      const start = getEventStartDate(event);
      if (!isNaN(start.getTime())) jumpToRef.current(start);
    },
    onTask: (id, account) => {
      if (!isShownAccount(account.appAccountId)) return;
      eventAppAccountId.current = account.appAccountId;
      setTasksInitialId(id);
      setTasksVisible(true);
    },
  });
  // A date link (`/calendar/<view>/<date>`) shows that day, in that view
  // when it names one. Only the visible date and view change.
  const pendingView = usePendingCalendarOpen((s) => s.view);
  React.useEffect(() => {
    if (!pendingView) return;
    const link = usePendingCalendarOpen.getState().consumeView();
    if (!link) return;
    const date = link.date ? parseDayKey(link.date) : displayNow();
    if (isNaN(date.getTime())) return;
    const mode = link.view ?? viewMode;
    setViewMode(mode);
    setSelectedDate(date);
    setVisibleDate(null);
    setFocus((prev) => ({ date, nonce: prev.nonce + 1 }));
    setWindowState(freshScrollWindowState(mode, date));
  }, [pendingView, viewMode]);
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
    // No account shown: no per-account override applies.
    () => applySharedCalendarColors(storeCalendars, sharedCalendarColors, shownAccountId ?? ''),
    [storeCalendars, sharedCalendarColors, shownAccountId],
  );

  // Auto-assign a random, not-yet-used palette color to any freshly shared
  // calendar so multiple shared calendars don't collide on one color. Runs
  // once per calendar (guarded by the presence of an existing key), and the
  // user can still overwrite it from the sidebar.
  React.useEffect(() => {
    // Keyed by the app account the sheets belong to (ids repeat across
    // accounts). An override under the old key counts as assigned.
    const appAccountId = screenAccount().appAccountId;
    if (!appAccountId) return;
    const missing = storeCalendars.filter(
      (cal) => cal.isShared && !sharedCalendarColorFor(sharedCalendarColors, appAccountId, cal),
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
      setSharedCalendarColor(sharedCalendarColorKey(appAccountId, cal), color);
    }
  }, [storeCalendars, sharedCalendarColors, setSharedCalendarColor, screenAccount]);

  const allCalendars = React.useMemo(
    () => (showBirthdayCalendar ? [...displayCalendars, createBirthdayCalendar(undefined, birthdayCalendarColor)] : displayCalendars),
    [displayCalendars, showBirthdayCalendar, birthdayCalendarColor],
  );
  // Tasks with a due date are overlaid on the grid (webmail's
  // showTasksOnCalendar, #1107): in a month cell, the week view's all-day
  // strip or the time grid, with a completion circle; completed ones struck
  // through. Only tasks of calendars the drawer shows; tapping one opens the
  // tasks sheet on that task.
  const taskEvents = React.useMemo<CalendarEvent[]>(() => {
    if (!enableCalendarTasks || !showTasksOnCalendar) return [];
    const shown = allCalendars.filter((c) => !hiddenCalendarIds.includes(c.id)).map((c) => c.id);
    return calendarTaskEvents(tasks, shown);
  }, [tasks, enableCalendarTasks, showTasksOnCalendar, allCalendars, hiddenCalendarIds]);
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
  // The days events fall on depend on the calendar's time zone too.
  const eventsByDay = React.useMemo(
    () => buildEventDayIndex(events),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, calendarTimeZone],
  );

  // The agenda lists no tasks (webmail); the month's day list shows open ones.
  const agendaEvents = React.useMemo(() => withoutTasks(events), [events]);
  const agendaEventsByDay = React.useMemo(
    () => (agendaEvents === events ? eventsByDay : buildEventDayIndex(agendaEvents)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agendaEvents, events, eventsByDay, calendarTimeZone],
  );
  const listEvents = React.useMemo(() => withoutDoneTasks(events), [events]);
  const listEventsByDay = React.useMemo(
    () => (listEvents === events ? eventsByDay : buildEventDayIndex(listEvents)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listEvents, events, eventsByDay, calendarTimeZone],
  );

  // A new calendar time zone also changes how the server reads floating
  // times and the range bounds: reload what is loaded.
  const loadedTimeZoneRef = React.useRef(calendarTimeZone);
  React.useEffect(() => {
    if (loadedTimeZoneRef.current === calendarTimeZone) return;
    loadedTimeZoneRef.current = calendarTimeZone;
    void refresh();
  }, [calendarTimeZone, refresh]);

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
  // loaded yet (calendar-store extendRange). `loadingEdge` is the side the
  // last extension asked for, until the wider window is in.
  const [rangeLoading, setRangeLoading] = React.useState(false);
  const [loadingEdge, setLoadingEdge] = React.useState<'start' | 'end' | null>(null);
  const [rangeLoader] = React.useState(() =>
    createRangeLoader(
      (range) => useCalendarStore.getState().extendRange(range.after, range.before),
      (busy) => {
        setRangeLoading(busy);
        if (!busy) setLoadingEdge(null);
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
  jumpToRef.current = jumpTo;

  // The grids add their rows for the wider window right away (the events
  // follow); the agenda waits for one extension to load before the next.
  const extendWindow = React.useCallback(
    (side: 'before' | 'after') => {
      setLoadingEdge(side === 'before' ? 'start' : 'end');
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
    jumpTo(
      viewMode === 'week' ? subWeeks(base, 1)
      : viewMode === 'day' ? subDays(base, 1)
      : calendar.addMonths(base, -1),
    );
  }, [viewMode, visibleDate, focus.date, jumpTo, calendar]);

  const goNext = React.useCallback(() => {
    const base = visibleDate ?? focus.date;
    jumpTo(
      viewMode === 'week' ? addWeeks(base, 1)
      : viewMode === 'day' ? addDays(base, 1)
      : calendar.addMonths(base, 1),
    );
  }, [viewMode, visibleDate, focus.date, jumpTo, calendar]);

  const goToday = React.useCallback(() => {
    jumpTo(displayNow());
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
    captureEventAccount();
    setModalEvent(null);
    setModalDate(date);
    setModalVisible(true);
  }, [captureEventAccount]);

  // Task chips route to the tasks sheet; everything else opens the detail sheet.
  const handleSelectEvent = React.useCallback((event: CalendarEvent) => {
    if (isTaskEvent(event)) {
      setTasksInitialId(taskIdOfEvent(event));
      setTasksVisible(true);
      return;
    }
    setDetailEvent(event);
  }, []);

  const openEditDirect = React.useCallback((event: CalendarEvent) => {
    // The account is the one the sheet that led here was opened in, never the
    // one shown now (it may differ after a switch during a duplicate).
    setModalEvent(event);
    setModalDate(undefined);
    setModalVisible(true);
  }, []);

  // Client-side iCal subscriptions mirror a remote feed into a local
  // calendar; edits there would be wiped by the next sync, so they're
  // read-only targets everywhere (#762).
  const subscriptions = useAccountSubscriptions();
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
    const account = accountOf(event);
    setDetailEvent(null);
    if (isRecurringSeriesMember(event)) {
      setPendingAction({ kind: 'delete', event, account });
    } else {
      deleteEvent(event.id, { account }).catch(reportError);
    }
  }, [deleteEvent, isReadOnlyEvent, reportError, accountOf]);

  // "This and following": end the master at the occurrence and hand back the
  // master plus its untouched rules so the caller can start a new series (or
  // roll back). Port of webmail's truncateRecurrenceAtEvent.
  const truncateRecurrenceAtEvent = React.useCallback(
    async (event: CalendarEvent, account: EventAccount) => {
      const master = await getMasterEvent(event);
      if (!master) return null;
      const originalRules = master.recurrenceRules
        ? (JSON.parse(JSON.stringify(master.recurrenceRules)) as RecurrenceRule[])
        : null;
      await updateEvent(master.id, {
        recurrenceRules: truncateRecurrenceRules(master.recurrenceRules, event),
      }, { account });
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
      account: EventAccount,
    ) => {
      await rsvpEvent(ev.id, participantId, status, buildReplyTo(ev), undefined, scope, account);
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
      // Decided when the question was asked, before any wait.
      const { event, account } = action;
      if (action.kind === 'rsvp') {
        try {
          await submitRsvp(event, action.participantId, action.status, scope === 'this' ? 'occurrence' : 'series', account);
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
          // The master is read once: a retry after a truncation would see the
          // truncated rules.
          let following: { master: CalendarEvent; originalRules: RecurrenceRule[] | null } | null = null;
          if (scope === 'this_and_future') {
            const master = await getMasterEvent(event);
            if (!master) throw new Error('Master event not found');
            following = {
              master,
              originalRules: master.recurrenceRules
                ? (JSON.parse(JSON.stringify(master.recurrenceRules)) as RecurrenceRule[])
                : null,
            };
          }
          // One connection for the whole "this and following" sequence.
          const series: EventAccount = {
            ...account,
            ...(scope === 'this_and_future'
              ? { scope: requireShownAccountScope(account.appAccountId, account.jmapAccountId) }
              : {}),
          };
          const write = async (send: boolean | undefined) => {
            const opts = { sendSchedulingMessages: send, account };
            switch (scope) {
              case 'this': {
                // The store keeps the change on this occurrence: through its
                // own (synthetic) id, or as a recurrence override on the event
                // it was expanded from.
                await updateEvent(event.id, updates, opts);
                break;
              }
              case 'this_and_future': {
                const { master, originalRules } = following!;
                const newEventData = buildFutureSeriesData(master, originalRules, event, updates);
                delete newEventData.calendarIds;
                await writeFollowingSeries({
                  master,
                  originalRules,
                  occurrence: event,
                  newSeries: newEventData,
                  calendarId: action.calendarId || getPrimaryCalendarId(master) || '',
                  send,
                  // The truncation, the new series and a rollback all go out on
                  // one connection, taken now; if it is gone each refuses.
                  api: {
                    updateEvent: (id, changes, o) => updateEvent(id, changes, { ...o, account: series }),
                    createEvent: (data, calId, o) => createEvent(data, calId, { ...o, account: series }),
                  },
                });
                break;
              }
              case 'all': {
                const master = await getMasterEvent(event);
                if (!master) throw new Error('Master event not found');
                await updateEvent(master.id, buildAllScopeUpdates(updates, event, master), opts);
                break;
              }
            }
          };
          // A declined retry drops the edit; the editor has already closed.
          await saveWithSchedulingFallback(
            write,
            action.sendScheduling,
            (reason) => confirmSaveWithoutInvitations(reason, t),
          );
        } else {
          switch (scope) {
            case 'this': {
              // The store destroys a server occurrence, or excludes one the
              // device expanded on its base event.
              await deleteEvent(event.id, { account });
              break;
            }
            case 'this_and_future': {
              const result = await truncateRecurrenceAtEvent(event, account);
              if (!result) throw new Error('Master event not found');
              break;
            }
            case 'all': {
              const master = await getMasterEvent(event);
              if (!master) throw new Error('Master event not found');
              await deleteEvent(master.id, { account });
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
      // Decided now, before the scheduling prompt (an Alert outlives a switch),
      // and checked again at each write.
      return withCapturedAccount(() => (modalEvent ? accountOf(modalEvent) : screenAccount()), async (account, check) => {
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
          setPendingAction({ kind: 'edit', event: modalEvent, updates, calendarId, sendScheduling, account });
          return true;
        }
        const outcome = await saveWithSchedulingFallback(
          async (send) => {
            check();
            await updateEvent(modalEvent.id, updates, { sendSchedulingMessages: send, account });
          },
          sendScheduling,
          (reason) => confirmSaveWithoutInvitations(reason, t),
        );
        return outcome !== 'cancelled';
      } else {
        const outcome = await saveWithSchedulingFallback(
          async (send) => {
            check();
            await createEvent(data, calendarId, { sendSchedulingMessages: send, account });
          },
          sendScheduling,
          (reason) => confirmSaveWithoutInvitations(reason, t),
        );
        return outcome !== 'cancelled';
      }
      });
    },
    [modalEvent, createEvent, updateEvent, accountOf, screenAccount, t],
  );

  const handleDeleteFromModal = React.useCallback(
    async (event: CalendarEvent) => {
      const account = accountOf(event);
      setModalVisible(false);
      if (isRecurringSeriesMember(event)) {
        setPendingAction({ kind: 'delete', event, account });
        return;
      }
      await deleteEvent(event.id, { account }).catch(reportError);
    },
    [deleteEvent, reportError, accountOf],
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
  // A task whose toggle is still going ignores further taps.
  const toggleInFlightRef = React.useRef(new Set<string>());
  const handleToggleTask = React.useCallback(
    (id: string) => {
      const account = screenAccount();
      runUnlessInFlight(toggleInFlightRef.current, id, () =>
        toggleTaskComplete(id, account).catch((err: unknown) => {
          Alert.alert(
            t('calendar.tasks.update_error', 'Failed to update task'),
            err instanceof Error ? err.message : undefined,
          );
        }),
      );
    },
    [toggleTaskComplete, screenAccount, t],
  );

  const handleDeleteTask = React.useCallback(
    (id: string) => {
      deleteTask(id, screenAccount()).catch((err: unknown) => {
        Alert.alert(
          t('calendar.tasks.delete_error', 'Failed to delete task'),
          err instanceof Error ? err.message : undefined,
        );
      });
    },
    [deleteTask, screenAccount, t],
  );

  // Clone the event one day later and open it in the editor (webmail's
  // handleDuplicateFromDetail).
  const handleDuplicateFromDetail = React.useCallback(
    async (event: CalendarEvent) => {
      setDetailEvent(null);
      const account = accountOf(event);
      const data: Partial<CalendarEvent> = {
        title: event.title,
        description: event.description,
        // A day later at the same wall clock in the event's own zone.
        start: addDaysToLocalDateTime(event.start, 1),
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
        const created = await createEvent(data, calendarId, { account });
        // Switched during the create: the id names another account's event now.
        if (!isShownAccount(account.appAccountId)) return;
        const stored = useCalendarStore.getState().events.find((e) => e.id === created.id) ?? created;
        openEditDirect(stored);
      } catch (err) {
        reportError(err);
      }
    },
    [createEvent, openEditDirect, reportError, accountOf],
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

  // Append a timestamped note to the description (webmail's quick note). Only
  // the description is written. A series member asks "this occurrence / all"
  // through the same dialog an edit does; the write happens in handleScopeSelect.
  const handleAddNote = React.useCallback(
    async (event: CalendarEvent, note: string): Promise<boolean> => {
      const updates = buildNoteUpdate(event, note, displayNow());
      if (!updates) return false;
      const options = noteSaveOptions(accountOf(event));
      if (isRecurringSeriesMember(event)) {
        setDetailEvent(null);
        setPendingAction({
          kind: 'edit',
          event,
          updates,
          calendarId: getPrimaryCalendarId(event) ?? '',
          sendScheduling: options.sendSchedulingMessages,
          account: options.account,
        });
        return true;
      }
      try {
        await updateEvent(event.id, updates, options);
        setDetailEvent((cur) => (cur && cur.id === event.id ? { ...cur, ...updates } : cur));
        toast.success(t('calendar.detail.note_saved', 'Note added'));
        return true;
      } catch (err) {
        reportError(err);
        return false;
      }
    },
    [updateEvent, reportError, accountOf, t],
  );

  const handleCalendarEditSave = React.useCallback(
    async (values: CalendarEditValues) => {
      if (!calendarEditTarget) return;
      const account = screenAccount();
      if (calendarEditTarget.mode === 'create') {
        await createCalendar(values.name, values.color, values.description, account);
      } else {
        await updateCalendar(calendarEditTarget.calendar.id, {
          name: values.name,
          color: values.color,
          description: values.description || null,
        }, account);
      }
    },
    [calendarEditTarget, createCalendar, updateCalendar, screenAccount],
  );

  const handleSetCalendarColor = React.useCallback(
    (cal: Calendar, color: string) => {
      if (cal.isShared) {
        // Per-viewer recolor (#345): the owner's colour is left alone.
        const { appAccountId } = screenAccount();
        if (appAccountId) setSharedCalendarColor(sharedCalendarColorKey(appAccountId, cal), color);
        return;
      }
      updateCalendar(cal.id, { color }, screenAccount()).catch(reportError);
    },
    [setSharedCalendarColor, updateCalendar, screenAccount, reportError],
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
            onPress: () => { clearCalendarEvents(cal.id, screenAccount()).catch(reportError); },
          },
        ],
      );
    },
    [t, clearCalendarEvents, screenAccount, reportError],
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
            onPress: () => { removeCalendar(cal.id, screenAccount()).catch(reportError); },
          },
        ],
      );
    },
    [t, removeCalendar, screenAccount, reportError],
  );

  const isSelectedToday = isDisplayToday(selectedDate);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => setSidebarVisible(true)}
          hitSlop={8}
          style={styles.headerBtn}
          accessibilityRole="button"
          accessibilityLabel={t('calendar.nav_open_menu', 'Open menu')}
        >
          <Menu size={20} color={c.text} />
        </Pressable>
        <View style={styles.headerLeft}>
          {/* Four view buttons leave less room: shrink a long title instead of wrapping it. */}
          <Text style={styles.headerTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
            {headerTitleFor(
              viewMode,
              visibleDate ?? focus.date,
              calendarFirstDayOfWeek,
              locale,
              calendar,
              viewMode === 'week' && freeScroll ? visibleDate : null,
            )}
          </Text>
          <Text style={styles.headerSubtitle}>
            {isSelectedToday
              ? t('calendar.views.today', 'Today')
              : dayLabelFor(selectedDate, locale, calendar, 'short')}
          </Text>
        </View>
        <View style={styles.headerActions}>
          {enableCalendarTasks && (
            <Pressable
              style={styles.headerBtn}
              onPress={() => setTasksVisible(true)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={t('calendar.views.tasks', 'Tasks')}
            >
              <ListChecks size={20} color={c.text} />
            </Pressable>
          )}
          <View style={styles.viewToggle}>
            {(['month', 'week', 'day', 'agenda'] as ViewMode[]).map((mode) => {
              const Icon =
                mode === 'month' ? LayoutGrid
                : mode === 'week' ? CalendarDays
                : mode === 'day' ? Calendar1
                : ListIcon;
              const active = viewMode === mode;
              const label =
                mode === 'month' ? t('calendar.views.month', 'Month')
                : mode === 'week' ? t('calendar.views.week', 'Week')
                : mode === 'day' ? t('calendar.views.day', 'Day')
                : t('calendar.views.agenda', 'Agenda');
              return (
                <Pressable
                  key={mode}
                  style={[styles.viewToggleBtn, active && styles.viewToggleBtnActive]}
                  onPress={() => changeViewMode(mode)}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  accessibilityState={{ selected: active }}
                >
                  <Icon size={16} color={active ? c.primary : c.textMuted} />
                </Pressable>
              );
            })}
          </View>
          <Pressable
            style={styles.fab}
            onPress={() => openCreate(selectedDate)}
            accessibilityRole="button"
            accessibilityLabel={t('calendar.events.new_event', 'New event')}
          >
            <Plus size={18} color={c.primaryForeground} />
          </Pressable>
        </View>
      </View>

      <View style={styles.nav}>
        <Pressable
          onPress={goPrev}
          style={styles.navBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('calendar.nav_prev', 'Previous')}
        >
          <ChevronLeft size={20} color={c.text} />
        </Pressable>
        <Button variant="outline" size="sm" onPress={goToday}>
          {t('calendar.views.today', 'Today')}
        </Button>
        <Pressable
          onPress={goNext}
          style={styles.navBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('calendar.nav_next', 'Next')}
        >
          <ChevronRight size={20} color={c.text} />
        </Pressable>
      </View>

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View style={styles.content}>
        {viewMode === 'month' && freeScroll && (
          <MonthScrollView
            key={windowKey}
            focus={focus}
            window={scrollWindow}
            onExtendStart={scrollWindow.canExtendStart ? extendWindowStart : undefined}
            onExtendEnd={scrollWindow.canExtendEnd ? extendWindowEnd : undefined}
            onVisibleDateChange={setVisibleDate}
            selectedDate={selectedDate}
            events={events}
            eventsByDay={eventsByDay}
            calendars={calendars}
            weekStartsOn={calendarFirstDayOfWeek}
            showWeekNumbers={calendarShowWeekNumbers}
            showTimeInMonthView={calendarShowTimeInMonth}
            timeFormat={calendarTimeFormat}
            currentUserEmails={currentUserEmails}
            onSelectDate={handleSelectDate}
            onToggleTask={handleToggleTask}
            onLongPressDate={openCreate}
          />
        )}
        {viewMode === 'month' && !freeScroll && (
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
            currentUserEmails={currentUserEmails}
            onSelectDate={handleSelectDate}
            onToggleTask={handleToggleTask}
            onLongPressDate={openCreate}
          />
        )}
        {(viewMode === 'day' || (viewMode === 'week' && freeScroll)) && (
          <TimeGridScrollView
            key={windowKey}
            mode={viewMode === 'day' ? 'day' : 'week'}
            focus={focus}
            window={scrollWindow}
            onExtendStart={freeScroll && scrollWindow.canExtendStart ? extendWindowStart : undefined}
            onExtendEnd={freeScroll && scrollWindow.canExtendEnd ? extendWindowEnd : undefined}
            onVisibleDateChange={freeScroll ? setVisibleDate : undefined}
            selectedDate={selectedDate}
            events={events}
            eventsByDay={eventsByDay}
            calendars={calendars}
            weekStartsOn={calendarFirstDayOfWeek}
            timeFormat={calendarTimeFormat}
            currentUserEmails={currentUserEmails}
            onSelectDate={handleSelectDate}
            onToggleTask={handleToggleTask}
            onSelectEvent={handleSelectEvent}
            onCreateAtTime={openCreate}
          />
        )}
        {viewMode === 'week' && !freeScroll && (
          <WeekView
            weekDate={focus.date}
            selectedDate={selectedDate}
            events={events}
            eventsByDay={eventsByDay}
            calendars={calendars}
            weekStartsOn={calendarFirstDayOfWeek}
            timeFormat={calendarTimeFormat}
            currentUserEmails={currentUserEmails}
            onSelectDate={handleSelectDate}
            onToggleTask={handleToggleTask}
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
            events={agendaEvents}
            eventsByDay={agendaEventsByDay}
            calendars={calendars}
            timeFormat={calendarTimeFormat}
            currentUserEmails={currentUserEmails}
            onSelectEvent={handleSelectEvent}
          />
        )}

        {viewMode === 'month' && (
          <View style={styles.dayDetail}>
            <View style={styles.dayDetailHeader}>
              <Text style={styles.dayDetailTitle}>
                {isSelectedToday
                  ? t('calendar.events.today_header', 'Today')
                  : dayLabelFor(selectedDate, locale, calendar, 'long')}
              </Text>
              {loading && <ActivityIndicator size="small" color={c.textMuted} />}
            </View>
            <DayEventList
              date={selectedDate}
              eventsByDay={listEventsByDay}
              onToggleTask={handleToggleTask}
              calendars={calendars}
              timeFormat={calendarTimeFormat}
              currentUserEmails={currentUserEmails}
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
        onAddNote={(ev, note) => (isReadOnlyEvent(ev) ? false : handleAddNote(ev, note))}
        onRsvp={async (ev, participantId, status) => {
          // An answer on one occurrence of a series asks whether it covers
          // just that occurrence or the whole series (webmail #1086).
          const account = accountOf(ev);
          if (ev.recurrenceId) {
            setPendingAction({ kind: 'rsvp', event: ev, participantId, status, account });
            return;
          }
          await submitRsvp(ev, participantId, status, 'series', account);
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
        onSetDefault={(cal) => { setDefaultCalendar(cal.id, screenAccount()).catch(reportError); }}
        onSetColor={handleSetCalendarColor}
        onResetColor={(cal) => {
          // Drop the local override; the auto-assign effect picks a fresh
          // unused color (so it never reverts to a collision). The old
          // key goes too, or it would show again as the fallback.
          const { appAccountId } = screenAccount();
          if (appAccountId) removeSharedCalendarColor(sharedCalendarColorKey(appAccountId, cal));
          removeSharedCalendarColor(legacySharedCalendarColorKey(cal));
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
        onCreate={(task, calId) => createTask(task, calId, screenAccount())}
        onUpdate={(id, changes) => updateTask(id, changes, screenAccount())}
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
        onImport={(events, calId) => importEvents(events, calId, undefined, screenAccount())}
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
        onShare={(id, principalId, rights) => shareCalendar(id, principalId, rights, screenAccount())}
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
  currentUserEmails,
  onToggleTask,
  onSelectEvent,
  refreshing,
  onRefresh,
}: {
  date: Date;
  eventsByDay: EventDayIndex;
  calendars: Calendar[];
  timeFormat?: TimeFormat;
  currentUserEmails?: string[];
  onToggleTask?: (taskId: string) => void;
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
          currentUserEmails={currentUserEmails}
          onToggleTask={onToggleTask}
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
    width: 30,
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
