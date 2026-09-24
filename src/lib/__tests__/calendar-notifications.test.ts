import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Listener = (state: Record<string, unknown>, prev: Record<string, unknown>) => void;

const h = vi.hoisted(() => ({
  pending: [] as Array<{ identifier: string; content: { data: Record<string, unknown> } }>,
  permission: { granted: true, canAskAgain: true },
  auth: { hasRestoredSession: true, isAuthenticated: true, session: null as unknown },
  settings: { hydrated: true, calendarNotificationsEnabled: true, enableCalendarTasks: false },
  calendar: {
    calendars: [{ id: 'cal-1', name: 'Personal' }],
    events: [] as unknown[],
    tasks: [] as unknown[],
    taskOnlyCalendarIds: [] as string[],
    loadedRange: null as unknown,
    fetchCalendars: vi.fn(async () => undefined),
    fetchTasks: vi.fn(async () => undefined),
  },
  client: { isConnected: true, accountId: 'acc-1' },
  loadEventsInRange: vi.fn(),
  calendarListener: null as Listener | null,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { addEventListener: vi.fn(() => ({ remove: () => undefined })) },
}));

vi.mock('expo-notifications', () => ({
  getPermissionsAsync: vi.fn(async () => ({ ...h.permission })),
  requestPermissionsAsync: vi.fn(async () => ({ granted: true })),
  setNotificationChannelAsync: vi.fn(async () => undefined),
  getAllScheduledNotificationsAsync: vi.fn(async () => h.pending),
  cancelScheduledNotificationAsync: vi.fn(async () => undefined),
  scheduleNotificationAsync: vi.fn(async () => 'id'),
  setNotificationHandler: vi.fn(),
  AndroidImportance: { HIGH: 4 },
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  SchedulableTriggerInputTypes: { DATE: 'date' },
}));

vi.mock('../../api/jmap-client', () => ({ jmapClient: h.client }));
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: { getState: () => h.auth, subscribe: vi.fn() },
}));
vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: { getState: () => h.settings, subscribe: vi.fn() },
}));
vi.mock('../../stores/calendar-store', () => ({
  useCalendarStore: {
    getState: () => h.calendar,
    subscribe: vi.fn((listener: Listener) => { h.calendarListener = listener; }),
  },
  loadEventsInRange: h.loadEventsInRange,
}));
vi.mock('../capabilities', () => ({ hasCalendarCapability: () => true }));

const NOW = new Date('2026-09-24T08:00:00Z').getTime();
const TAG = 'bulwark-calendar-alert';

const upcoming = {
  id: 'ev1',
  title: 'Standup',
  calendarIds: { 'cal-1': true },
  start: '2026-09-24T12:00:00',
  timeZone: 'Europe/Berlin',
  utcStart: '2026-09-24T10:00:00Z',
  utcEnd: '2026-09-24T10:30:00Z',
  duration: 'PT30M',
  alerts: { a1: { trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' }, action: 'display' } },
};
const upcomingKey = `ev1:a1:${new Date('2026-09-24T09:45:00Z').getTime()}`;

function reminder(identifier: string, key: string) {
  return { identifier, content: { data: { tag: TAG, key } } };
}

let mod: typeof import('../calendar-notifications');
let N: typeof import('expo-notifications');
let bus: typeof import('../state-change-bus');

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW });
  vi.resetModules();
  vi.clearAllMocks();
  h.pending = [];
  h.permission = { granted: true, canAskAgain: true };
  h.auth = { hasRestoredSession: true, isAuthenticated: true, session: null };
  h.settings = { hydrated: true, calendarNotificationsEnabled: true, enableCalendarTasks: false };
  h.calendar.events = [];
  h.calendar.tasks = [];
  h.calendar.loadedRange = null;
  h.client.isConnected = true;
  h.calendarListener = null;
  h.loadEventsInRange.mockResolvedValue([upcoming]);
  mod = await import('../calendar-notifications');
  N = await import('expo-notifications');
  bus = await import('../state-change-bus');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('calendar reminders (B17)', () => {
  it('schedules from an upcoming window of its own, whatever month the calendar shows', async () => {
    // The calendar shows another month: nothing upcoming is in the store.
    h.calendar.events = [{ id: 'old', start: '2026-03-02T09:00:00' }];

    await mod.rescheduleCalendarNotifications();

    expect(h.loadEventsInRange).toHaveBeenCalledTimes(1);
    const [calendars, ids, after, before] = h.loadEventsInRange.mock.calls[0];
    expect(calendars).toBe(h.calendar.calendars);
    expect(ids).toEqual(['cal-1']);
    expect(new Date(after).getTime()).toBeLessThanOrEqual(NOW);
    expect(new Date(before).getTime()).toBeGreaterThanOrEqual(NOW + 7 * 24 * 3600_000);
    expect(N.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    const request = vi.mocked(N.scheduleNotificationAsync).mock.calls[0][0];
    expect(request.content.data).toMatchObject({ tag: TAG, key: upcomingKey });
  });

  it('cancels only its own reminders that are no longer wanted', async () => {
    h.pending = [
      reminder('keep', upcomingKey),
      reminder('stale', 'gone:a1:1'),
      { identifier: 'other', content: { data: { kind: 'something-else' } } },
    ];

    await mod.rescheduleCalendarNotifications();

    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(1);
    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledWith('stale');
    // Already pending: not scheduled twice.
    expect(N.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('keeps the scheduled reminders when the upcoming events cannot be loaded', async () => {
    h.pending = [reminder('keep', upcomingKey)];
    h.loadEventsInRange.mockRejectedValue(new Error('offline'));

    await mod.rescheduleCalendarNotifications();
    h.client.isConnected = false;
    await mod.rescheduleCalendarNotifications();

    expect(N.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
    expect(h.loadEventsInRange).toHaveBeenCalledTimes(1);
  });

  it('cancels its reminders after sign-out or when switched off', async () => {
    h.pending = [
      reminder('r1', upcomingKey),
      { identifier: 'other', content: { data: {} } },
    ];
    h.auth = { hasRestoredSession: true, isAuthenticated: false, session: null };

    await mod.rescheduleCalendarNotifications();
    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(1);
    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledWith('r1');

    vi.mocked(N.cancelScheduledNotificationAsync).mockClear();
    h.auth = { hasRestoredSession: true, isAuthenticated: true, session: null };
    h.settings.calendarNotificationsEnabled = false;
    await mod.rescheduleCalendarNotifications();
    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledWith('r1');
    expect(h.loadEventsInRange).not.toHaveBeenCalled();
  });

  it('asks for permission only once the calendar allows it', async () => {
    h.permission = { granted: false, canAskAgain: true };

    await mod.rescheduleCalendarNotifications();
    expect(N.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(N.scheduleNotificationAsync).not.toHaveBeenCalled();

    mod.startCalendarNotificationSync({ askPermission: true });
    await mod.rescheduleCalendarNotifications();
    expect(N.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(N.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('shows its reminders in the foreground and leaves other notifications alone', async () => {
    mod.startCalendarNotificationSync();

    expect(N.setNotificationHandler).toHaveBeenCalledTimes(1);
    const handler = vi.mocked(N.setNotificationHandler).mock.calls[0][0]!;
    const ours = await handler.handleNotification({
      request: { content: { data: { tag: TAG, key: upcomingKey } } },
    } as never);
    const other = await handler.handleNotification({
      request: { content: { data: {} } },
    } as never);
    expect(ours).toMatchObject({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true });
    expect(other).toMatchObject({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false });
  });

  it('runs at launch and after calendar changes on the server, not when the view moves', async () => {
    mod.startCalendarNotificationSync();
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.loadEventsInRange).toHaveBeenCalledTimes(1);

    bus.dispatchStateChange({ '@type': 'StateChange', changed: { 'acc-1': { CalendarEvent: 's2' } } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.loadEventsInRange).toHaveBeenCalledTimes(2);

    // Navigating the calendar loads another window: no reminder changes.
    const prev = { events: [], tasks: h.calendar.tasks, loadedRange: { after: 'a', before: 'b' } };
    h.calendarListener!({ ...prev, events: [{}], loadedRange: { after: 'c', before: 'd' } }, prev);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.loadEventsInRange).toHaveBeenCalledTimes(2);

    // An edit in the same window does.
    h.calendarListener!({ ...prev, events: [{}], loadedRange: { after: 'a', before: 'b' } }, prev);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.loadEventsInRange).toHaveBeenCalledTimes(3);
  });
});
