import { describe, it, expect, vi, beforeEach } from 'vitest';

// The scope edits (lib/recurrence-scope-edit) on the real calendar store,
// with the JMAP calls mocked: what reaches CalendarEvent/set when "this and
// the following occurrences" cannot create the rest of the series.

vi.hoisted(() => {
  process.env.TZ = 'Europe/Berlin';
});

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
  batchCreateEvents: vi.fn(),
  setDefaultCalendar: vi.fn(),
  rsvpEvent: vi.fn(),
  supportsSyntheticCalendarIds: vi.fn(async () => false),
  queryExpandedEvents: vi.fn(async () => []),
  hydrateExpandedOccurrences: vi.fn(async (events: unknown[]) => events),
  resetSyntheticIdSupport: vi.fn(),
  resetTimeZoneChecks: vi.fn(),
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: { accountId: 'acc-1', isConnected: true },
}));

import * as calendarApi from '../../api/calendar';
import type { CalendarEvent } from '../../api/types';
import { useCalendarStore } from '../calendar-store';
import { saveOccurrenceEdit } from '../../lib/recurrence-scope-edit';
import { editorTimesFromEvent } from '../../lib/event-editor-times';

const mockUpdate = vi.mocked(calendarApi.updateEvent);
const mockCreate = vi.mocked(calendarApi.createEvent);
const mockGetEvents = vi.mocked(calendarApi.getEvents);

const ORGANIZER = 'userc@example.org';
const participants = {
  org: { calendarAddress: `mailto:${ORGANIZER}`, roles: { owner: true }, participationStatus: 'accepted' },
  b: { calendarAddress: 'mailto:userb@example.org', roles: { attendee: true }, participationStatus: 'accepted' },
};

// Five Mondays from 5 October, 10:00 in Berlin; userb declined 19 October
// alone - on 1.0 an override holding just that answer, as a PatchObject.
const master = {
  id: 'b', uid: 'weekly@example.org', title: 'Planning', start: '2026-10-05T10:00:00', duration: 'PT1H',
  timeZone: 'Europe/Berlin', calendarIds: { 'cal-1': true }, organizerCalendarAddress: `mailto:${ORGANIZER}`,
  participants, isOrigin: true,
  recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: 5 }],
  recurrenceOverrides: { '2026-10-19T10:00:00': { 'participants/b/participationStatus': 'declined' } },
} as unknown as CalendarEvent;

const occurrence = {
  ...master, id: 's19', baseEventId: 'b', start: '2026-10-19T10:00:00', recurrenceId: '2026-10-19T10:00:00',
  utcStart: '2026-10-19T08:00:00Z', utcEnd: '2026-10-19T09:00:00Z',
} as CalendarEvent;

beforeEach(() => {
  vi.clearAllMocks();
  useCalendarStore.getState().reset();
  useCalendarStore.setState({ calendars: [{ id: 'cal-1', name: 'Work' }] as never, events: [occurrence], loadedRange: null });
  mockGetEvents.mockImplementation(async (ids: string[]) => (ids[0] === 'b' ? [master] : []));
});

describe('this and the following occurrences on the calendar store (Stalwart 1.0)', () => {
  it('puts the series back as it was when the create fails, and fails the save', async () => {
    mockCreate.mockRejectedValue(new Error('Network request failed'));
    const store = useCalendarStore.getState();

    await expect(saveOccurrenceEdit('this_and_future', {
      event: occurrence,
      updates: { title: 'Planning, room 2', start: occurrence.start, duration: 'PT1H', timeZone: 'Europe/Berlin', participants },
      editor: { attendees: [{ name: '', email: 'userb@example.org' }], when: editorTimesFromEvent(occurrence) },
      calendarId: 'cal-1', sendScheduling: true, userEmails: [ORGANIZER],
    }, { updateEvent: store.updateEvent, createEvent: store.createEvent, getMasterEvent: store.getMasterEvent }))
      .rejects.toThrow('Network request failed');

    expect(mockUpdate.mock.calls.map(([id, patch, schedule]) => [id, patch, schedule])).toEqual([
      ['b', {
        recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: null, until: '2026-10-19T09:59:59' }],
        'recurrenceOverrides/2026-10-19T10:00:00': null,
      }, true],
      // Its rule and the whole overrides map: a pointer fails on a series
      // the truncation left without overrides.
      ['b', { recurrenceRules: master.recurrenceRules, recurrenceOverrides: master.recurrenceOverrides }, true],
    ]);
    const [created, calendarId, schedule] = mockCreate.mock.calls[0];
    expect([calendarId, schedule]).toEqual(['cal-1', true]);
    expect(created).toMatchObject({ start: '2026-10-19T10:00:00', recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: 3 }] });
  });
});

// The series itself, opened from a reminder or a link: not in the grid, and
// on a calendar shared with the user (the owner's account 'f'). "This
// occurrence" of it wrote the editor's data to the whole series before; it
// is an override of its first occurrence now, and has to reach the owner's
// account under the raw id - the store knew nothing of the series.
describe('the series itself opened from a reminder on the calendar store', () => {
  const shared = {
    ...master, id: 'f:b', originalId: 'b', accountId: 'f', isShared: true, calendarIds: { 'f:cal': true },
    recurrenceOverrides: null,
  } as CalendarEvent;

  it.each(['0.16.23', '1.0'])('overrides its first occurrence in the owner\'s account on Stalwart %s', async () => {
    useCalendarStore.setState({ events: [] });
    // As the owner's account holds it: no overrides yet.
    mockGetEvents.mockImplementation(async (ids: string[]) => (ids[0] === 'b' ? [{ ...master, recurrenceOverrides: null }] : []));
    const store = useCalendarStore.getState();

    await saveOccurrenceEdit('this', {
      event: shared,
      updates: { title: 'Kick-off', start: shared.start, duration: 'PT1H', timeZone: 'Europe/Berlin' },
      sendScheduling: false, userEmails: [ORGANIZER],
    }, { updateEvent: store.updateEvent, createEvent: store.createEvent, getMasterEvent: store.getMasterEvent });

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const [id, patch, schedule, accountId] = mockUpdate.mock.calls[0];
    expect([id, schedule, accountId]).toEqual(['b', false, 'f']);
    expect(Object.keys(patch)).toEqual(['recurrenceOverrides']);
    expect((patch as { recurrenceOverrides: Record<string, unknown> }).recurrenceOverrides['2026-10-05T10:00:00'])
      .toMatchObject({ start: '2026-10-05T10:00:00', title: 'Kick-off' });
  });
});

// A change that makes an event a series (or a single event again) changes
// which occurrences the grid shows, and only a range load expands a series:
// until then the grid had the series itself, once (0.16 before 0.16.20,
// where nothing else reloads the range).
describe('an event an edit makes recurring (Stalwart 0.16.19)', () => {
  it('loads the range again, and not for a single event that stays one', async () => {
    const single = (id: string) => ({
      id, uid: `${id}@example.org`, title: 'Once', start: '2026-10-05T10:00:00', duration: 'PT1H', calendarIds: { 'cal-1': true },
    }) as CalendarEvent;
    const refresh = vi.fn(async () => undefined);
    useCalendarStore.setState({ events: [single('x'), single('y')], refresh });

    await useCalendarStore.getState().updateEvent('y', { title: 'Once, renamed' });
    expect(refresh).not.toHaveBeenCalled();

    await useCalendarStore.getState().updateEvent('x', { recurrenceRules: [{ frequency: 'weekly' }] });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

// The raised SEQUENCE of an "all" change (0.16.6 to 0.16.23 keep no raise of
// a single occurrence's change) goes out as it is: the app's update strips
// no `sequence`, so nothing has to keep it.
describe.each(['0.16.23', '1.0'])('an announced change of every occurrence through the store on Stalwart %s', () => {
  it('sends the raised SEQUENCE of the series and of its changed occurrence', async () => {
    mockGetEvents.mockImplementation(async (ids: string[]) => (ids[0] === 'b' ? [{ ...master, sequence: 4 }] : []));
    const store = useCalendarStore.getState();

    await saveOccurrenceEdit('all', {
      event: occurrence,
      updates: { title: 'Planning, room 2', start: occurrence.start, duration: 'PT1H', timeZone: 'Europe/Berlin', participants },
      editor: { attendees: [{ name: '', email: 'userb@example.org' }], when: editorTimesFromEvent(occurrence) },
      sendScheduling: true, userEmails: [ORGANIZER],
    }, { updateEvent: store.updateEvent, createEvent: store.createEvent, getMasterEvent: store.getMasterEvent });

    expect(mockUpdate.mock.calls.map(([id, patch, schedule]) => [id, patch, schedule])).toEqual([
      ['b', { title: 'Planning, room 2', sequence: 5, 'recurrenceOverrides/2026-10-19T10:00:00/sequence': 5 }, true],
    ]);
  });
});

// An override written on the base event by an older save, without the
// organizer: 0.16.19 refuses an answer to such an occurrence, so a change of
// it writes the series' organizer back (0.16 before 0.16.20: the device
// expands the series).
describe('a change of an occurrence whose override has no organizer (Stalwart 0.16.19)', () => {
  it('writes the series\' organizer into the override', async () => {
    const deviceOccurrence = {
      ...master, id: 'b:2026-10-19T10:00:00', originalId: 'b', start: '2026-10-19T10:00:00', recurrenceId: '2026-10-19T10:00:00',
      recurrenceOverrides: { '2026-10-19T10:00:00': { title: 'Planning, special', start: '2026-10-19T10:00:00', duration: 'PT1H' } },
    } as CalendarEvent;
    useCalendarStore.setState({ events: [deviceOccurrence] });

    await useCalendarStore.getState().updateEvent(deviceOccurrence.id, { title: 'Planning, room 2' }, { sendSchedulingMessages: true });

    const [id, patch] = mockUpdate.mock.calls[0];
    expect(id).toBe('b');
    expect((patch as Record<string, Record<string, unknown>>)['recurrenceOverrides/2026-10-19T10:00:00']).toMatchObject({
      title: 'Planning, room 2', organizerCalendarAddress: `mailto:${ORGANIZER}`,
    });
  });
});

// The SEQUENCE a change of every occurrence raises is the server's: a series
// opened from a reminder a while ago - or shown as itself in the grid - is
// an older copy, and a raise from its number goes out lower than what the
// attendees hold, which 0.16 (0.16.6 to 0.16.23) refuses.
describe.each(['0.16.23', '1.0'])('a change of every occurrence from a series opened a while ago on Stalwart %s', (version) => {
  it('raises the SEQUENCE the server holds, not the stale copy\'s', async () => {
    const overrides = version === '1.0'
      ? { '2026-10-19T10:00:00': { title: 'Planning, special' } }
      : { '2026-10-19T10:00:00': { title: 'Planning, special', start: '2026-10-19T10:00:00', duration: 'PT1H', sequence: 2 } };
    const stale = { ...master, sequence: 2, recurrenceOverrides: overrides } as unknown as CalendarEvent;
    const current = {
      ...master, sequence: 5,
      recurrenceOverrides: version === '1.0' ? overrides : { '2026-10-19T10:00:00': { ...overrides['2026-10-19T10:00:00'], sequence: 5 } },
    } as unknown as CalendarEvent;
    mockGetEvents.mockImplementation(async (ids: string[]) => (ids[0] === 'b' ? [current] : []));
    useCalendarStore.setState({ events: [] });
    const store = useCalendarStore.getState();

    await saveOccurrenceEdit('all', {
      event: stale,
      updates: { title: 'Planning, room 2', start: stale.start, duration: 'PT1H', timeZone: 'Europe/Berlin', participants },
      editor: { attendees: [{ name: '', email: 'userb@example.org' }], when: editorTimesFromEvent(stale) },
      sendScheduling: true, userEmails: [ORGANIZER],
    }, { updateEvent: store.updateEvent, createEvent: store.createEvent, getMasterEvent: store.getMasterEvent });

    expect(mockUpdate.mock.calls.map(([id, patch, schedule]) => [id, patch, schedule])).toEqual([
      ['b', { title: 'Planning, room 2', sequence: 6, 'recurrenceOverrides/2026-10-19T10:00:00/sequence': 6 }, true],
    ]);
  });
});
