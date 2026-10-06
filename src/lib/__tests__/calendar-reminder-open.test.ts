import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  store: {
    calendars: [{ id: 'cal-1' }, { id: 'acc-2:cal-9', originalId: 'cal-9', accountId: 'acc-2' }] as unknown[],
    events: [] as unknown[],
    tasks: [] as unknown[],
    fetchCalendars: vi.fn(async () => undefined),
    fetchTasks: vi.fn(async () => undefined),
  },
  loadEventsInRange: vi.fn(),
  getEvents: vi.fn(),
  addToast: vi.fn(),
  shown: 'app-a' as string | null,
}));

vi.mock('../../stores/calendar-store', () => ({
  useCalendarStore: { getState: () => h.store },
  loadEventsInRange: h.loadEventsInRange,
  mapServerEventToStoreEvent: (event: Record<string, unknown>, _cals: unknown, accountId?: string) =>
    accountId ? { ...event, id: `${accountId}:${event.id}`, originalId: event.id, accountId } : event,
}));
vi.mock('../../api/calendar', () => ({ getEvents: h.getEvents }));
vi.mock('../../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: h.addToast }) },
}));
vi.mock('../../stores/email-store', () => ({
  isShownAccount: (id: string | null | undefined) => !!id && id === h.shown,
  requireShownAccountScope: () => ({ gen: 7, accountId: 'acc-1' }),
}));
vi.mock('../served-account', () => ({
  useServedAccount: () => ({ appAccountId: h.shown, jmapAccountId: 'acc-1' }),
}));
vi.mock('../../stores/locale-store', () => ({
  useLocaleStore: { getState: () => ({ t: (_key: string, fallback: string) => fallback }) },
}));

import {
  openReminderTarget,
  resolveReminderEvent,
  resolveReminderTask,
} from '../calendar-reminder-open';

const START = new Date('2026-09-24T10:00:00Z').getTime();
/** Taken when the target was consumed: app account A on connection 7. */
const ACCOUNT = { appAccountId: 'app-a', scope: { gen: 7, accountId: 'acc-1' } };

beforeEach(() => {
  vi.clearAllMocks();
  h.shown = 'app-a';
  h.store.events = [];
  h.store.tasks = [];
  h.loadEventsInRange.mockResolvedValue([]);
  h.getEvents.mockResolvedValue([]);
});

describe('resolveReminderEvent', () => {
  it('takes the event from the loaded window', async () => {
    const ev = { id: 'ev1', title: 'Standup' };
    h.store.events = [ev];

    expect(await resolveReminderEvent({ kind: 'event', eventId: 'ev1', serverId: 'ev1', startMs: START }, ACCOUNT)).toBe(ev);
    expect(h.loadEventsInRange).not.toHaveBeenCalled();
  });

  it('loads the day around the occurrence when the calendar shows another window', async () => {
    const occurrence = {
      id: 'acc-2:ev1:2026-09-24T10:00:00Z', originalId: 'ev1', accountId: 'acc-2',
      recurrenceId: '2026-09-24T10:00:00Z',
    };
    const other = { ...occurrence, id: 'acc-2:ev1:2026-09-25T10:00:00Z', recurrenceId: '2026-09-25T10:00:00Z' };
    h.loadEventsInRange.mockResolvedValue([other, occurrence]);

    const found = await resolveReminderEvent({
      kind: 'event', eventId: 'stale-id', serverId: 'ev1', accountId: 'acc-2',
      recurrenceId: '2026-09-24T10:00:00Z', startMs: START,
    }, ACCOUNT);

    expect(found).toBe(occurrence);
    const [, ids, after, before, at] = h.loadEventsInRange.mock.calls[0];
    expect(ids).toEqual(['cal-1', 'acc-2:cal-9']);
    // On the connection the target was consumed on.
    expect(at).toEqual({ gen: 7, accountId: 'acc-1' });
    expect(new Date(after).getTime()).toBeLessThan(START);
    expect(new Date(before).getTime()).toBeGreaterThan(START);
  });

  it('falls back to the stored event when the occurrence is not around its old start', async () => {
    h.getEvents.mockResolvedValue([{ id: 'ev1', title: 'Moved' }]);

    const found = await resolveReminderEvent({
      kind: 'event', eventId: 'acc-2:ev1', serverId: 'ev1', accountId: 'acc-2', startMs: START,
    }, ACCOUNT);

    expect(h.getEvents).toHaveBeenCalledWith(['ev1'], { gen: 7, accountId: 'acc-2' });
    expect(found).toMatchObject({ id: 'acc-2:ev1', title: 'Moved' });
  });

  it('returns null for a deleted event', async () => {
    expect(await resolveReminderEvent({ kind: 'event', eventId: 'gone', serverId: 'gone', startMs: START }, ACCOUNT)).toBeNull();
  });

  it('reads nothing more once the calendars it waited for belong to another account', async () => {
    const saved = h.store.calendars;
    h.store.calendars = [];
    h.store.fetchCalendars.mockImplementationOnce(async () => {
      h.shown = 'app-b';
      h.store.calendars = saved;
    });
    try {
      expect(await resolveReminderEvent({ kind: 'event', eventId: 'ev1', serverId: 'ev1', startMs: START }, ACCOUNT))
        .toBeNull();
      expect(h.loadEventsInRange).not.toHaveBeenCalled();
      expect(h.getEvents).not.toHaveBeenCalled();
    } finally {
      h.store.calendars = saved;
    }
  });
});

describe('resolveReminderTask', () => {
  it('loads the tasks when the Calendar tab has not yet', async () => {
    h.store.fetchTasks.mockImplementationOnce(async () => {
      h.store.tasks = [{ id: 't1', title: 'Pay rent' }];
    });

    expect(await resolveReminderTask({ kind: 'task', eventId: 't1', serverId: 't1' }, ACCOUNT))
      .toMatchObject({ id: 't1' });
    expect(h.store.fetchTasks).toHaveBeenCalledTimes(1);
  });
});

describe('openReminderTarget', () => {
  it('opens the event in the detail sheet and a task in the tasks sheet', async () => {
    h.store.events = [{ id: 'ev1' }];
    h.store.tasks = [{ id: 't1' }];
    const onEvent = vi.fn();
    const onTask = vi.fn();

    expect(await openReminderTarget({ kind: 'event', eventId: 'ev1' }, { onEvent, onTask }, ACCOUNT)).toBe(true);
    expect(await openReminderTarget({ kind: 'task', eventId: 't1' }, { onEvent, onTask }, ACCOUNT)).toBe(true);

    // With the account the target was consumed in, for the sheet to open with.
    expect(onEvent).toHaveBeenCalledWith({ id: 'ev1' }, ACCOUNT);
    expect(onTask).toHaveBeenCalledWith('t1', ACCOUNT);
    expect(h.addToast).not.toHaveBeenCalled();
  });

  it('says so when the event is gone or cannot be loaded', async () => {
    h.getEvents.mockRejectedValue(new Error('offline'));
    const onEvent = vi.fn();

    expect(await openReminderTarget(
      { kind: 'event', eventId: 'ev1', serverId: 'ev1' },
      { onEvent, onTask: vi.fn() },
      ACCOUNT,
    )).toBe(false);

    expect(onEvent).not.toHaveBeenCalled();
    expect(h.addToast).toHaveBeenCalledWith({ type: 'error', title: 'This event is no longer available.' });
  });

  it('opens nothing once another account is shown, and says nothing', async () => {
    h.getEvents.mockImplementation(async () => {
      h.shown = 'app-b';
      return [{ id: 'ev1', title: 'A\'s event' }];
    });
    const onEvent = vi.fn();
    const onTask = vi.fn();

    expect(await openReminderTarget({ kind: 'event', eventId: 'ev1', serverId: 'ev1' }, { onEvent, onTask }, ACCOUNT))
      .toBe(false);
    h.store.tasks = [{ id: 't1' }];
    expect(await openReminderTarget({ kind: 'task', eventId: 't1' }, { onEvent, onTask }, ACCOUNT)).toBe(false);

    expect(onEvent).not.toHaveBeenCalled();
    expect(onTask).not.toHaveBeenCalled();
    expect(h.addToast).not.toHaveBeenCalled();
  });

  it('says nothing when the read was dropped for a connection that is gone', async () => {
    h.getEvents.mockRejectedValue(Object.assign(new Error('stale'), { name: 'StaleLoadError' }));
    const onEvent = vi.fn();
    expect(await openReminderTarget(
      { kind: 'event', eventId: 'ev1', serverId: 'ev1' },
      { onEvent, onTask: vi.fn() },
      ACCOUNT,
    )).toBe(false);
    expect(onEvent).not.toHaveBeenCalled();
    expect(h.addToast).not.toHaveBeenCalled();
  });
});
