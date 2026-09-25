import { describe, it, expect, vi, beforeEach } from 'vitest';

// Changing one occurrence of a meeting the user organizes. Stalwart 0.16.6
// to 1.0 send a new occurrence override - the first change to an occurrence
// - only to attendees who have not answered (no PARTSTAT or NEEDS-ACTION,
// crates/groupware scheduling/organizer.rs), so a change that keeps the
// answers goes out in two writes: the override as the occurrence stands,
// quietly, then the change as an update of it, which reaches everyone.
// And while a series uses its calendar's default alerts, 1.0 shows the
// defaults in place of an occurrence's own and refuses useDefaultAlerts on
// one occurrence: the series stops using them first.

vi.mock('../../api/calendar', () => ({
  getCalendars: vi.fn(),
  queryEvents: vi.fn(async () => []),
  getEvents: vi.fn(),
  getEventIdentities: vi.fn(async () => []),
  scanCalendarObjects: vi.fn(async () => []),
  isCalendarAccessDenied: vi.fn(() => false),
  noteCalendarAccessError: vi.fn(() => false),
  resetCalendarAccessDenied: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(async () => undefined),
  deleteEvents: vi.fn(),
  batchCreateEvents: vi.fn(),
  setDefaultCalendar: vi.fn(),
  rsvpEvent: vi.fn(),
  supportsSyntheticCalendarIds: vi.fn(async () => false),
  queryExpandedEvents: vi.fn(),
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

import * as calendarApi from '../../api/calendar';
import type { CalendarEvent } from '../../api/types';
import { useCalendarStore } from '../calendar-store';

const mockUpdate = vi.mocked(calendarApi.updateEvent);
const mockGetEvents = vi.mocked(calendarApi.getEvents);
const mockQueryExpanded = vi.mocked(calendarApi.queryExpandedEvents);

const RID = '2026-03-02T09:00:00';
const alert15 = { '@type': 'Alert' as const, trigger: { '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' }, action: 'display' };
const alert30 = { '@type': 'Alert' as const, trigger: { '@type': 'OffsetTrigger', offset: '-PT30M', relativeTo: 'start' }, action: 'display' };

// Organized by the user; Bob accepted the series.
const participants = {
  p0: { calendarAddress: 'mailto:me@example.com', roles: { owner: true }, participationStatus: 'accepted' },
  p1: { calendarAddress: 'mailto:bob@example.com', roles: { attendee: true }, participationStatus: 'accepted' },
};
const askedAgain = { ...participants, p1: { ...participants.p1, participationStatus: 'needs-action' } };

// Expanded by the server (a synthetic id), its series' overrides hydrated: none yet.
const serverOccurrence = (partial: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 's1', baseEventId: 'base', uid: 'series@example.com', recurrenceId: RID, start: RID, duration: 'PT1H',
  title: 'Standup', recurrenceRules: [{ frequency: 'weekly' }], recurrenceOverrides: null,
  calendarIds: { 'cal-1': true }, organizerCalendarAddress: 'mailto:me@example.com', participants, sequence: 1,
  utcStart: '2026-03-02T08:00:00Z',
  ...partial,
} as unknown as CalendarEvent);

// Expanded on the device (0.16 without synthetic ids): changes become
// overrides on the base event.
const deviceOccurrence = (partial: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: `base:${RID}`, originalId: 'base', uid: 'series@example.com', recurrenceId: RID, start: RID, duration: 'PT1H',
  title: 'Standup', recurrenceRules: [{ frequency: 'weekly' }], recurrenceOverrides: null,
  calendarIds: { 'cal-1': true }, organizerCalendarAddress: 'mailto:me@example.com', participants, sequence: 1,
  ...partial,
} as unknown as CalendarEvent);

beforeEach(() => {
  vi.clearAllMocks();
  useCalendarStore.getState().reset();
  useCalendarStore.setState({ calendars: [{ id: 'cal-1', name: 'Work' }] as never, loadedRange: null });
  mockGetEvents.mockResolvedValue([]);
  mockQueryExpanded.mockResolvedValue([]);
});

describe.each(['0.16.23', '1.0'])('a first change to one server occurrence on Stalwart %s', () => {
  it('writes the override as it stands, then sends the change to its re-read id', async () => {
    useCalendarStore.setState({ events: [serverOccurrence()] });
    // The new override gives the occurrence another synthetic id.
    mockQueryExpanded.mockResolvedValue(['s9', 'other']);
    mockGetEvents.mockImplementation(async (ids: string[]) => (ids.includes('s9')
      ? [
        { id: 'other', baseEventId: 'else', recurrenceId: RID, start: RID } as CalendarEvent,
        { id: 's9', baseEventId: 'base', recurrenceId: RID, start: RID, duration: 'PT1H' } as CalendarEvent,
      ]
      : []));

    await useCalendarStore.getState().updateEvent('s1', { title: 'Standup, room 2', participants } as Partial<CalendarEvent>, {
      sendSchedulingMessages: true,
    });

    expect(mockUpdate.mock.calls.map(([id, patch, schedule]) => [id, patch, schedule])).toEqual([
      ['s1', { title: 'Standup', participants, sequence: 1 }, false],
      ['s9', { title: 'Standup, room 2', participants }, true],
    ]);
    // Looked up around the occurrence, expanded.
    expect(mockGetEvents).toHaveBeenCalledWith(['s9', 'other'], undefined, { expanded: true });
  });

  it('sends the change once when it asks the attendees again (a move)', async () => {
    useCalendarStore.setState({ events: [serverOccurrence()] });

    await useCalendarStore.getState().updateEvent('s1', {
      start: '2026-03-02T10:00:00', participants: askedAgain,
    } as Partial<CalendarEvent>, { sendSchedulingMessages: true });

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0]).toEqual(['s1', expect.objectContaining({ participants: askedAgain }), true, undefined]);
  });

  it('sends the change once to an occurrence that has its override already', async () => {
    useCalendarStore.setState({ events: [serverOccurrence({ recurrenceOverrides: { [RID]: { title: 'Standup' } } })] });

    await useCalendarStore.getState().updateEvent('s1', { title: 'Standup, room 2', participants } as Partial<CalendarEvent>, {
      sendSchedulingMessages: true,
    });

    expect(mockUpdate.mock.calls.map(([id, , schedule]) => [id, schedule])).toEqual([['s1', true]]);
  });

  it('writes once without scheduling', async () => {
    useCalendarStore.setState({ events: [serverOccurrence()] });

    await useCalendarStore.getState().updateEvent('s1', { title: 'My note' }, { sendSchedulingMessages: false });

    expect(mockUpdate.mock.calls.map(([id, , schedule]) => [id, schedule])).toEqual([['s1', false]]);
  });

  it('sends the change to the old id when the occurrence cannot be found again', async () => {
    useCalendarStore.setState({ events: [serverOccurrence()] });
    mockQueryExpanded.mockResolvedValue(null);

    await useCalendarStore.getState().updateEvent('s1', { title: 'Standup, room 2', participants } as Partial<CalendarEvent>, {
      sendSchedulingMessages: true,
    });

    expect(mockUpdate.mock.calls.map(([id, , schedule]) => [id, schedule])).toEqual([['s1', false], ['s1', true]]);
  });
});

describe('a first change to one occurrence expanded on the device (Stalwart 0.16.23)', () => {
  it('writes the override on the base event as it stands, then rewrites it with the change', async () => {
    useCalendarStore.setState({ events: [deviceOccurrence()] });

    await useCalendarStore.getState().updateEvent(`base:${RID}`, {
      title: 'Standup, room 2', participants,
    } as Partial<CalendarEvent>, { sendSchedulingMessages: true });

    const entry = {
      start: RID, duration: 'PT1H', title: 'Standup', participants, sequence: 1,
      organizerCalendarAddress: 'mailto:me@example.com',
    };
    expect(mockUpdate.mock.calls.map(([id, patch, schedule]) => [id, patch, schedule])).toEqual([
      ['base', { recurrenceOverrides: { [RID]: entry } }, false],
      ['base', { [`recurrenceOverrides/${RID}`]: { ...entry, title: 'Standup, room 2' } }, true],
    ]);
  });

  it('writes one override when the attendees are asked again', async () => {
    useCalendarStore.setState({ events: [deviceOccurrence()] });

    await useCalendarStore.getState().updateEvent(`base:${RID}`, {
      start: '2026-03-02T10:00:00', participants: askedAgain,
    } as Partial<CalendarEvent>, { sendSchedulingMessages: true });

    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('an occurrence\'s alerts on a series that uses the calendar\'s default alerts', () => {
  const edit = { alerts: { 'reminder-1': alert30 }, useDefaultAlerts: false } as Partial<CalendarEvent>;

  it('turns the defaults off for the series first, keeping what it shows under ids of its own (Stalwart 1.0)', async () => {
    useCalendarStore.setState({ events: [serverOccurrence({ participants: undefined })] });
    // 1.0 fills the defaults into `alerts` under the default alerts' ids.
    mockGetEvents.mockImplementation(async (ids: string[]) => (ids[0] === 'base'
      ? [{ id: 'base', useDefaultAlerts: true, alerts: { 'default-1': alert15 } } as unknown as CalendarEvent]
      : []));

    await useCalendarStore.getState().updateEvent('s1', edit);

    expect(mockUpdate.mock.calls.map(([id, patch, schedule]) => [id, patch, schedule])).toEqual([
      ['base', { useDefaultAlerts: false, alerts: { 'reminder-1': alert15 } }, false],
      ['s1', expect.objectContaining({ alerts: { 'reminder-1': alert30 } }), undefined],
    ]);
    expect(mockUpdate.mock.calls[1][1]).not.toHaveProperty('useDefaultAlerts');
  });

  it('turns the defaults off on the base event of an occurrence expanded on the device (Stalwart 0.16.23)', async () => {
    useCalendarStore.setState({ events: [deviceOccurrence({ participants: undefined, organizerCalendarAddress: undefined })] });
    mockGetEvents.mockImplementation(async (ids: string[]) => (ids[0] === 'base'
      ? [{ id: 'base', useDefaultAlerts: true, alerts: {} } as unknown as CalendarEvent]
      : []));

    await useCalendarStore.getState().updateEvent(`base:${RID}`, edit);

    expect(mockUpdate.mock.calls[0]).toEqual(['base', { useDefaultAlerts: false, alerts: null }, false, undefined]);
    expect(mockUpdate.mock.calls[1][0]).toBe('base');
    expect(mockUpdate.mock.calls[1][1]).toHaveProperty('recurrenceOverrides');
  });

  it('leaves a series without default alerts alone', async () => {
    useCalendarStore.setState({ events: [serverOccurrence({ participants: undefined })] });
    mockGetEvents.mockResolvedValue([{ id: 'base', useDefaultAlerts: false, alerts: {} } as unknown as CalendarEvent]);

    await useCalendarStore.getState().updateEvent('s1', edit);

    expect(mockUpdate.mock.calls.map(([id]) => id)).toEqual(['s1']);
  });
});
