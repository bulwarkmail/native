import { describe, it, expect, vi, beforeEach } from 'vitest';

// Writes still under way when the account changes. Event and calendar ids
// repeat across accounts (two accounts can both have calendar "b" with event
// "c"), so a write that finishes after the switch must not send its next
// step, which would reach the next account, nor change the store, which
// shows that account by then.

vi.mock('../../api/calendar', () => ({
  getCalendars: vi.fn(),
  queryEvents: vi.fn(async () => []),
  getEvents: vi.fn(async () => []),
  getEventIdentities: vi.fn(async () => []),
  scanCalendarObjects: vi.fn(async () => []),
  isCalendarAccessDenied: vi.fn(() => false),
  noteCalendarAccessError: vi.fn(() => false),
  resetCalendarAccessDenied: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(async () => undefined),
  deleteEvents: vi.fn(async () => undefined),
  batchCreateEvents: vi.fn(async (events: unknown[]) => ({ created: events.length, refused: [] })),
  rsvpEvent: vi.fn(async () => undefined),
  createCalendar: vi.fn(),
  updateCalendar: vi.fn(async () => undefined),
  deleteCalendar: vi.fn(async () => undefined),
  setDefaultCalendar: vi.fn(async () => undefined),
  supportsSyntheticCalendarIds: vi.fn(async () => false),
  queryExpandedEvents: vi.fn(async () => []),
  searchEventIds: vi.fn(async () => []),
  hydrateExpandedOccurrences: vi.fn(async (events: unknown[]) => events),
  resetSyntheticIdSupport: vi.fn(),
  resetTimeZoneChecks: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: { accountId: 'acc-1', isConnected: true },
}));

vi.mock('../../device-sync/app/request', () => ({ requestDeviceSync: vi.fn() }));

import * as calendarApi from '../../api/calendar';
import type { CalendarEvent } from '../../api/types';
import { CalendarAccountChangedError, searchCalendarEvents, useCalendarStore } from '../calendar-store';

const mockUpdate = vi.mocked(calendarApi.updateEvent);
const mockDelete = vi.mocked(calendarApi.deleteEvents);
const mockCreate = vi.mocked(calendarApi.createEvent);
const mockGetEvents = vi.mocked(calendarApi.getEvents);
const mockQueryEvents = vi.mocked(calendarApi.queryEvents);
const mockQueryExpanded = vi.mocked(calendarApi.queryExpandedEvents);
const mockBatchCreate = vi.mocked(calendarApi.batchCreateEvents);
const mockUpdateCalendar = vi.mocked(calendarApi.updateCalendar);
const mockCreateCalendar = vi.mocked(calendarApi.createCalendar);

const RID = '2026-03-02T09:00:00';
const participants = {
  p0: { calendarAddress: 'mailto:me@example.com', roles: { owner: true }, participationStatus: 'accepted' },
  p1: { calendarAddress: 'mailto:bob@example.com', roles: { attendee: true }, participationStatus: 'accepted' },
};

const event = (id: string, title: string): CalendarEvent => ({
  id, uid: `${id}@example.com`, title, start: '2026-03-03T10:00:00', duration: 'PT1H', calendarIds: { b: true },
} as unknown as CalendarEvent);

// The next account: its calendar "b" holds an event "c" too.
const THEIRS = event('c', 'Their event');

/** What an account switch does to the store while a request is under way. */
function switchAccount(): void {
  useCalendarStore.getState().reset();
  useCalendarStore.setState({
    calendars: [{ id: 'b', name: 'Their calendar', sortOrder: 0 }] as never,
    events: [THEIRS],
    tasks: [{ ...THEIRS, '@type': 'Task', progress: 'needs-action' } as CalendarEvent],
    loadedRange: { after: '2026-03-01T00:00:00Z', before: '2026-04-01T00:00:00Z' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useCalendarStore.getState().reset();
  useCalendarStore.setState({
    calendars: [{ id: 'b', name: 'Mine', sortOrder: 0 }, { id: 'e', name: 'Other', sortOrder: 1 }] as never,
    events: [event('c', 'My event')],
    tasks: [{ ...event('c', 'My task'), '@type': 'Task', progress: 'needs-action' } as CalendarEvent],
    loadedRange: { after: '2026-03-01T00:00:00Z', before: '2026-04-01T00:00:00Z' },
  });
});

describe('a write the account switch overtook', () => {
  it('names the account it started in and leaves the next account\'s event alone (updateEvent)', async () => {
    mockUpdate.mockImplementationOnce(async () => switchAccount());

    // Fails, so that a caller with more steps (lib/recurrence-scope-edit)
    // sends no next one to the next account.
    await expect(useCalendarStore.getState().updateEvent('c', { title: 'Renamed' }))
      .rejects.toBeInstanceOf(CalendarAccountChangedError);

    expect(mockUpdate).toHaveBeenCalledWith('c', { title: 'Renamed' }, undefined, 'acc-1');
    expect(useCalendarStore.getState().events).toEqual([THEIRS]);
  });

  it('leaves the next account\'s event of the same id in the store (deleteEvent)', async () => {
    mockDelete.mockImplementationOnce(async () => switchAccount());

    await expect(useCalendarStore.getState().deleteEvent('c')).rejects.toBeInstanceOf(CalendarAccountChangedError);

    expect(mockDelete).toHaveBeenCalledWith(['c'], undefined, 'acc-1');
    expect(useCalendarStore.getState().events).toEqual([THEIRS]);
  });

  it('neither re-reads nor shows the event it made (createEvent)', async () => {
    mockCreate.mockImplementationOnce(async () => {
      switchAccount();
      return event('n', 'New');
    });

    await expect(useCalendarStore.getState().createEvent({ title: 'New' }, 'b')).rejects.toBeInstanceOf(CalendarAccountChangedError);

    expect(mockCreate).toHaveBeenCalledWith({ title: 'New' }, 'b', undefined, 'acc-1');
    expect(mockGetEvents).not.toHaveBeenCalled();
    expect(useCalendarStore.getState().events).toEqual([THEIRS]);
  });

  it('leaves the answer off the next account\'s event (rsvpEvent)', async () => {
    useCalendarStore.setState({ events: [{ ...event('c', 'Invite'), participants } as unknown as CalendarEvent] });
    const theirs = { ...THEIRS, participants };
    vi.mocked(calendarApi.rsvpEvent).mockImplementationOnce(async () => {
      switchAccount();
      useCalendarStore.setState({ events: [theirs as unknown as CalendarEvent] });
    });

    await useCalendarStore.getState().rsvpEvent('c', 'p1', 'declined');

    expect(calendarApi.rsvpEvent).toHaveBeenCalledWith('c', 'p1', 'declined', undefined, 'acc-1');
    expect(useCalendarStore.getState().events[0].participants?.p1.participationStatus).toBe('accepted');
  });

  it('sends no second step of a first change to one server occurrence', async () => {
    useCalendarStore.setState({
      events: [{
        id: 's1', baseEventId: 'base', uid: 'series@example.com', recurrenceId: RID, start: RID, duration: 'PT1H',
        title: 'Standup', recurrenceRules: [{ frequency: 'weekly' }], recurrenceOverrides: null,
        calendarIds: { b: true }, organizerCalendarAddress: 'mailto:me@example.com', participants, sequence: 1,
      } as unknown as CalendarEvent],
    });
    mockUpdate.mockImplementationOnce(async () => switchAccount());

    await expect(useCalendarStore.getState().updateEvent('s1', { title: 'Standup, room 2', participants } as Partial<CalendarEvent>, {
      sendSchedulingMessages: true,
    })).rejects.toBeInstanceOf(CalendarAccountChangedError);

    // The quiet override only: the change itself would go to the next account.
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][2]).toBe(false);
    expect(mockQueryExpanded).not.toHaveBeenCalled();
  });

  it('sends no second step of a first change to one occurrence expanded on the device', async () => {
    useCalendarStore.setState({
      events: [{
        id: `base:${RID}`, originalId: 'base', uid: 'series@example.com', recurrenceId: RID, start: RID, duration: 'PT1H',
        title: 'Standup', recurrenceRules: [{ frequency: 'weekly' }], recurrenceOverrides: null,
        calendarIds: { b: true }, organizerCalendarAddress: 'mailto:me@example.com', participants, sequence: 1,
      } as unknown as CalendarEvent],
    });
    mockUpdate.mockImplementationOnce(async () => switchAccount());

    await expect(useCalendarStore.getState().updateEvent(`base:${RID}`, { title: 'Standup, room 2', participants } as Partial<CalendarEvent>, {
      sendSchedulingMessages: true,
    })).rejects.toBeInstanceOf(CalendarAccountChangedError);

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][2]).toBe(false);
  });

  it('imports no further batch into the next account\'s calendar of the same id', async () => {
    mockBatchCreate.mockImplementationOnce(async (events: unknown[]) => {
      switchAccount();
      return { created: events.length, refused: [] };
    });
    const events = Array.from({ length: 60 }, (_, i) => ({ uid: `u${i}`, title: `E${i}`, start: '2026-03-03T10:00:00' }));

    await expect(useCalendarStore.getState().importEvents(events, 'b')).rejects.toBeInstanceOf(CalendarAccountChangedError);

    expect(mockQueryEvents).toHaveBeenCalledWith([], '', '', 'acc-1');
    expect(mockBatchCreate).toHaveBeenCalledTimes(1);
    expect(mockBatchCreate.mock.calls[0][2]).toBe('acc-1');
  });

  it('links no further UID once the account changed (importEvents)', async () => {
    vi.mocked(calendarApi.getEventIdentities).mockResolvedValueOnce([
      { id: 'x1', uid: 'u1', calendarIds: { e: true } },
      { id: 'x2', uid: 'u2', calendarIds: { e: true } },
    ] as never);
    mockUpdate.mockImplementationOnce(async () => switchAccount());

    await expect(useCalendarStore.getState().importEvents([{ uid: 'u1' }, { uid: 'u2' }], 'b'))
      .rejects.toBeInstanceOf(CalendarAccountChangedError);

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockBatchCreate).not.toHaveBeenCalled();
  });

  it('renumbers none of the next account\'s calendars (reorderCalendars)', async () => {
    useCalendarStore.setState({ calendars: [{ id: 'b', name: 'Mine', sortOrder: 5 }, { id: 'e', name: 'Other', sortOrder: 6 }] as never });
    mockUpdateCalendar.mockImplementationOnce(async () => switchAccount());

    await expect(useCalendarStore.getState().reorderCalendars(['e', 'b'])).rejects.toBeInstanceOf(CalendarAccountChangedError);

    expect(mockUpdateCalendar).toHaveBeenCalledTimes(1);
    expect(mockUpdateCalendar.mock.calls[0][2]).toBe('acc-1');
    expect(useCalendarStore.getState().calendars).toEqual([{ id: 'b', name: 'Their calendar', sortOrder: 0 }]);
  });

  it('adds the calendar it made to no other account\'s list (createCalendar)', async () => {
    mockCreateCalendar.mockImplementationOnce(async () => {
      switchAccount();
      return { id: 'n', name: 'New' } as never;
    });

    await useCalendarStore.getState().createCalendar('New');

    expect(mockCreateCalendar).toHaveBeenCalledWith('New', undefined, undefined, 'acc-1');
    expect(useCalendarStore.getState().calendars.map((c) => c.id)).toEqual(['b']);
  });

  it('removes none of the next account\'s calendar or events (removeCalendar)', async () => {
    vi.mocked(calendarApi.deleteCalendar).mockImplementationOnce(async () => switchAccount());

    await useCalendarStore.getState().removeCalendar('b');

    expect(calendarApi.deleteCalendar).toHaveBeenCalledWith('b', 'acc-1');
    expect(useCalendarStore.getState().calendars.map((c) => c.id)).toEqual(['b']);
    expect(useCalendarStore.getState().events).toEqual([THEIRS]);
  });

  it('changes none of the next account\'s tasks', async () => {
    mockUpdate.mockImplementationOnce(async () => switchAccount());
    await useCalendarStore.getState().updateTask('c', { title: 'Renamed' });
    expect(useCalendarStore.getState().tasks[0].title).toBe('Their event');

    mockDelete.mockImplementationOnce(async () => switchAccount());
    await useCalendarStore.getState().deleteTask('c');
    expect(useCalendarStore.getState().tasks).toHaveLength(1);

    // A refused tick is put back only on the task it was made on.
    useCalendarStore.setState({ tasks: [{ ...event('c', 'Mine'), '@type': 'Task', progress: 'needs-action' } as CalendarEvent] });
    mockUpdate.mockImplementationOnce(async () => {
      switchAccount();
      useCalendarStore.setState({ tasks: [{ ...THEIRS, '@type': 'Task', progress: 'completed' } as CalendarEvent] });
      throw new Error('Network request failed');
    });
    await expect(useCalendarStore.getState().toggleTaskComplete('c')).rejects.toThrow('Network request failed');
    expect(useCalendarStore.getState().tasks[0].progress).toBe('completed');
  });
});

describe('searchCalendarEvents', () => {
  const mockSearch = vi.mocked(calendarApi.searchEventIds);

  it('searches every account the store shows and edits a find in its own account', async () => {
    useCalendarStore.setState({
      calendars: [{ id: 'b', name: 'Mine' }, { id: 'acc-2:t', originalId: 't', accountId: 'acc-2', name: 'Team', isShared: true }] as never,
      events: [],
    });
    mockSearch.mockImplementation(async (_filter, accountId) => (accountId === 'acc-2' ? ['x'] : ['c']));
    mockGetEvents.mockImplementation(async (ids: string[], accountId?: string) => ids.map((id) => ({
      ...event(id, accountId ? 'Team review' : 'My review'),
      calendarIds: (accountId ? { t: true } : { b: true }) as Record<string, boolean>,
    })));

    const found = await searchCalendarEvents(['review']);

    expect(mockSearch).toHaveBeenCalledWith({ text: 'review' }, undefined);
    expect(mockSearch).toHaveBeenCalledWith({ text: 'review' }, 'acc-2');
    expect(found.map((e) => e.id).sort()).toEqual(['acc-2:x', 'c']);
    // Outside the loaded window, yet a change reaches the owner's account.
    await useCalendarStore.getState().updateEvent('acc-2:x', { title: 'Renamed' });
    expect(mockUpdate).toHaveBeenCalledWith('x', { title: 'Renamed' }, undefined, 'acc-2');
  });

  it('hands nothing found before an account switch to the next account', async () => {
    mockSearch.mockImplementationOnce(async () => {
      switchAccount();
      return ['c'];
    });
    await expect(searchCalendarEvents(['review'])).rejects.toBeInstanceOf(CalendarAccountChangedError);
    expect(mockGetEvents).not.toHaveBeenCalled();
  });
});
