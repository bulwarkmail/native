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
