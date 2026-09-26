import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The device and the calendar are in Berlin unless a test says otherwise.
vi.hoisted(() => {
  process.env.TZ = 'Europe/Berlin';
});

import { addDays, addHours, addMinutes, startOfDay } from 'date-fns';
import {
  deleteOccurrence,
  followingSeriesData,
  saveOccurrenceEdit,
  seriesUpdatesFromOccurrence,
  type OccurrenceEditActions,
  type SeriesEdit,
} from '../recurrence-scope-edit';
import { expandRecurringEvents } from '../recurrence-expansion';
import { getEventStartDate } from '../calendar-utils';
import { editorTimesFromEvent } from '../event-editor-times';
import { useSettingsStore } from '../../stores/settings-store';
import type { CalendarEvent, Participant } from '../../api/types';

// "All occurrences" from the editor opened on one occurrence: the editor's
// dates and participants are that occurrence's. Written to the series as
// they were, a rename from the third occurrence moved the series' start to
// it (the first two occurrences gone) and gave every occurrence the third
// one's answers - here userb's "declined" for that day only.

type Version = '0.16' | '1.0';
const ORGANIZER = 'userc@example.org';
const ATTENDEE = 'userb@example.org';
// Someone userc shares the calendar with, read & write; not invited.
const SHAREE = 'usera@example.org';

// Participants as each version stores them: 0.16.23 drops an attendee's
// roles, 1.0 keeps them.
function participant(version: Version, address: string, owner: boolean, status: string): Participant {
  return {
    '@type': 'Participant', calendarAddress: `mailto:${address}`, email: address,
    ...(owner ? { roles: { owner: true } } : version === '1.0' ? { roles: { attendee: true } } : {}),
    participationStatus: status, scheduleAgent: 'server', expectReply: !owner, kind: 'individual',
  } as unknown as Participant;
}

const statusOf = (participants: CalendarEvent['participants'] | undefined, address: string) =>
  Object.values(participants ?? {}).find((p) => p.calendarAddress === `mailto:${address}`)?.participationStatus;

// Weekly on Mondays from 5 October, 10:00 in Berlin, five times. userb
// accepted the series and declined 19 October alone: 1.0 returns that
// override as a PatchObject, 0.16 as the whole participants map.
function series(version: Version): CalendarEvent {
  const participants = {
    org: participant(version, ORGANIZER, true, 'accepted'),
    b: participant(version, ATTENDEE, false, 'accepted'),
  };
  return {
    id: 'b', uid: 'weekly@example.org', '@type': 'Event', title: 'Planning',
    start: '2026-10-05T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin', showWithoutTime: false,
    utcStart: '2026-10-05T08:00:00Z', utcEnd: '2026-10-05T09:00:00Z',
    calendarIds: { cal: true }, organizerCalendarAddress: `mailto:${ORGANIZER}`, participants, isOrigin: true,
    recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: 5 }],
    recurrenceOverrides: version === '1.0'
      ? { '2026-10-19T10:00:00': { 'participants/b/participationStatus': 'declined' } }
      : { '2026-10-19T10:00:00': { participants: { ...participants, b: participant(version, ATTENDEE, false, 'declined') } } },
    excludedRecurrenceRules: null, alerts: null,
  } as unknown as CalendarEvent;
}

// 19 October as the server expands it (0.16.20 on, and 1.0): a synthetic id
// naming its base event, hydrated from it.
function serverOccurrence(version: Version): CalendarEvent {
  const base = series(version);
  return {
    ...base,
    id: 'maaaaac', baseEventId: 'b',
    start: '2026-10-19T10:00:00', utcStart: '2026-10-19T08:00:00Z', utcEnd: '2026-10-19T09:00:00Z',
    recurrenceId: '2026-10-19T10:00:00', recurrenceIdTimeZone: 'Europe/Berlin',
    participants: { ...base.participants, b: participant(version, ATTENDEE, false, 'declined') },
  } as CalendarEvent;
}

// 19 October as the device expands it (0.16 before 0.16.20).
function deviceOccurrence(): CalendarEvent {
  const occurrences = expandRecurringEvents([series('0.16')], '2026-10-01T00:00:00', '2026-11-30T00:00:00');
  return occurrences.find((o) => o.recurrenceId === '2026-10-19T10:00:00')!;
}

const occurrences: Array<[string, Version, () => CalendarEvent]> = [
  ['1.0', '1.0', () => serverOccurrence('1.0')],
  ['0.16.20+', '0.16', () => serverOccurrence('0.16')],
  ['0.16 before 0.16.20', '0.16', deviceOccurrence],
];

/** What the editor had, opened on `occurrence` and saved as it came unless changed. */
function editorOn(occurrence: CalendarEvent, change: Partial<SeriesEdit> = {}): SeriesEdit {
  return {
    attendees: [{ name: '', email: ATTENDEE }],
    when: editorTimesFromEvent(occurrence),
    ...change,
  };
}

/** What the editor writes for `occurrence` (EventModal handleSave) with `change`. */
function editorUpdates(occurrence: CalendarEvent, change: Partial<CalendarEvent> = {}): Partial<CalendarEvent> {
  return {
    title: occurrence.title, start: occurrence.start, duration: occurrence.duration,
    timeZone: occurrence.timeZone, showWithoutTime: false, recurrenceRules: occurrence.recurrenceRules,
    // The occurrence's participants, rebuilt with its answers.
    participants: occurrence.participants,
    ...change,
  };
}

const context = { userEmail: ORGANIZER, userEmails: [ORGANIZER] };

/** The calendar store's actions as the scope code uses them. */
function actions(master: CalendarEvent | null) {
  return {
    updateEvent: vi.fn(async (_id: string, _changes: Partial<CalendarEvent> | Record<string, unknown>, _options?: { sendSchedulingMessages?: boolean }) => undefined),
    // The created event, or nothing when a store answers a failure so.
    createEvent: vi.fn(async (event: Partial<CalendarEvent>, _calendarId: string, _options?: { sendSchedulingMessages?: boolean }) =>
      ({ ...event, id: 'n1' }) as CalendarEvent | null),
    getMasterEvent: vi.fn(async (_occurrence: CalendarEvent) => master),
    deleteEvent: vi.fn(async (_id: string) => undefined),
  } satisfies OccurrenceEditActions & { deleteEvent: (id: string) => Promise<void> };
}

beforeEach(() => useSettingsStore.setState({ calendarTimeZone: 'Europe/Berlin' }));
afterEach(() => useSettingsStore.setState({ calendarTimeZone: 'auto' }));

describe.each(occurrences)('changing every occurrence from one of them on Stalwart %s', (_label, version, make) => {
  it('renames the series and keeps when it happens and its answers', () => {
    const occurrence = make();
    const updates = seriesUpdatesFromOccurrence(
      occurrence, series(version), editorUpdates(occurrence, { title: 'Planning, room 2' }), editorOn(occurrence), context,
    );

    expect(updates.title).toBe('Planning, room 2');
    for (const key of ['start', 'duration', 'timeZone', 'showWithoutTime', 'recurrenceId', 'participants', 'organizerCalendarAddress', 'recurrenceRules']) {
      expect(updates).not.toHaveProperty(key);
    }
  });

  it('moves the series from its own start by as much as the occurrence moved, and asks again', () => {
    const occurrence = make();
    const { start, end } = editorTimesFromEvent(occurrence);
    const updates = seriesUpdatesFromOccurrence(
      occurrence, series(version),
      editorUpdates(occurrence, { start: '2026-10-19T11:30:00' }),
      editorOn(occurrence, { when: { allDay: false, start: addMinutes(start, 90), end: addMinutes(end, 90) } }),
      context,
    );

    expect(updates.start).toBe('2026-10-05T11:30:00');
    expect(updates).not.toHaveProperty('duration');
    expect(updates).not.toHaveProperty('timeZone');
    // Asked again as the series' organizer: the series' answer, not the
    // occurrence's "declined", goes back to needs-action.
    expect(statusOf(updates.participants, ORGANIZER)).toBe('accepted');
    expect(statusOf(updates.participants, ATTENDEE)).toBe('needs-action');
  });

  it('moves the series to another weekday by the days the occurrence moved', () => {
    const occurrence = make();
    const { start, end } = editorTimesFromEvent(occurrence);
    const updates = seriesUpdatesFromOccurrence(
      occurrence, series(version), editorUpdates(occurrence),
      editorOn(occurrence, { when: { allDay: false, start: addDays(start, 1), end: addDays(end, 1) } }),
      context,
    );

    expect(updates.start).toBe('2026-10-06T10:00:00');
  });

  it('changes only the length when only the end moved', () => {
    const occurrence = make();
    const { start, end } = editorTimesFromEvent(occurrence);
    const updates = seriesUpdatesFromOccurrence(
      occurrence, series(version), editorUpdates(occurrence, { duration: 'PT1H30M' }),
      editorOn(occurrence, { when: { allDay: false, start, end: addMinutes(end, 30) } }),
      context,
    );

    expect(updates.duration).toBe('PT1H30M');
    expect(updates).not.toHaveProperty('start');
    expect(statusOf(updates.participants, ATTENDEE)).toBe('needs-action');
  });

  it('turns the series all-day on its own first day', () => {
    const occurrence = make();
    const day = startOfDay(getEventStartDate(occurrence));
    const updates = seriesUpdatesFromOccurrence(
      occurrence, series(version),
      editorUpdates(occurrence, { start: '2026-10-19T00:00:00', duration: 'P1D', timeZone: null, showWithoutTime: true }),
      editorOn(occurrence, { when: { allDay: true, start: day, end: day } }),
      context,
    );

    expect(updates).toMatchObject({ start: '2026-10-05T00:00:00', duration: 'P1D', timeZone: null, showWithoutTime: true });
  });

  it('adds the attendee the user added to the series\' own participants', () => {
    const occurrence = make();
    const attendees = [{ name: '', email: ATTENDEE }, { name: 'Anna', email: 'usera@example.org' }];
    const updates = seriesUpdatesFromOccurrence(
      occurrence, series(version), editorUpdates(occurrence), editorOn(occurrence, { attendees }), context,
    );

    const participants = updates.participants as Record<string, Participant>;
    // The series' ids and answers: userb accepted the series.
    expect(participants.org.calendarAddress).toBe(`mailto:${ORGANIZER}`);
    expect(participants.b.participationStatus).toBe('accepted');
    expect(statusOf(participants, 'usera@example.org')).toBe('needs-action');
    expect(Object.keys(participants)).toHaveLength(3);
    expect(updates).not.toHaveProperty('organizerCalendarAddress');
  });

  it('removes the attendee the user removed, and the participants with the last one', () => {
    const occurrence = make();
    const updates = seriesUpdatesFromOccurrence(
      occurrence, series(version), editorUpdates(occurrence, { participants: null }), editorOn(occurrence, { attendees: [] }), context,
    );

    expect(updates.participants).toBeNull();
    expect(updates.organizerCalendarAddress).toBeNull();
  });

  it('asks the attendees again when the series gets another rule', () => {
    const occurrence = make();
    const updates = seriesUpdatesFromOccurrence(
      occurrence, series(version),
      editorUpdates(occurrence, { recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'daily', count: 5 }] }),
      editorOn(occurrence, { ruleChanged: true }), context,
    );

    expect(updates).not.toHaveProperty('start');
    expect(updates.recurrenceRules).toEqual([{ '@type': 'RecurrenceRule', frequency: 'daily', count: 5 }]);
    expect(statusOf(updates.participants, ATTENDEE)).toBe('needs-action');
  });

  it('moves an attendee\'s own copy of the series and leaves its participants alone', () => {
    const occurrence = make();
    const { start, end } = editorTimesFromEvent(occurrence);
    const updates = seriesUpdatesFromOccurrence(
      occurrence, { ...series(version), isOrigin: false }, editorUpdates(occurrence, { participants: undefined }),
      editorOn(occurrence, { when: { allDay: false, start: addHours(start, 1), end: addHours(end, 1) } }),
      { userEmail: ATTENDEE, userEmails: [ATTENDEE] },
    );

    expect(updates.start).toBe('2026-10-05T11:00:00');
    expect(updates).not.toHaveProperty('participants');
  });

  // The series in userc's calendar, shared with usera read & write: Stalwart
  // sends usera's change from userc (isOrigin: true).
  it('asks again when the user moves the owner\'s series in a calendar shared with them', () => {
    const occurrence = make();
    const { start, end } = editorTimesFromEvent(occurrence);
    const updates = seriesUpdatesFromOccurrence(
      occurrence, { ...series(version), isOrigin: true, isShared: true, accountId: 'f' }, editorUpdates(occurrence),
      editorOn(occurrence, { when: { allDay: false, start: addHours(start, 1), end: addHours(end, 1) } }),
      { userEmail: SHAREE, userEmails: [SHAREE] },
    );

    expect(updates.start).toBe('2026-10-05T11:00:00');
    expect(statusOf(updates.participants, ORGANIZER)).toBe('accepted');
    expect(statusOf(updates.participants, ATTENDEE)).toBe('needs-action');
    expect(statusOf(updates.participants, SHAREE)).toBeUndefined();
  });
});

describe('changing every occurrence of a series in another time zone', () => {
  it('moves the series on its own wall clock, whatever zone the calendar shows it in', () => {
    useSettingsStore.setState({ calendarTimeZone: 'Asia/Tokyo' });
    // 08:00 in New York is 21:00 in Tokyo; the user moves it to 22:00.
    const base = {
      ...series('1.0'), start: '2026-10-05T08:00:00', timeZone: 'America/New_York',
      utcStart: '2026-10-05T12:00:00Z', utcEnd: '2026-10-05T13:00:00Z',
    } as CalendarEvent;
    const occurrence = {
      ...base, id: 'maaaaac', baseEventId: 'b', start: '2026-10-19T08:00:00',
      utcStart: '2026-10-19T12:00:00Z', utcEnd: '2026-10-19T13:00:00Z', recurrenceId: '2026-10-19T08:00:00',
    } as CalendarEvent;
    const { start, end } = editorTimesFromEvent(occurrence);
    expect(start.getHours()).toBe(21);

    const updates = seriesUpdatesFromOccurrence(
      occurrence, base,
      editorUpdates(occurrence, { start: '2026-10-19T09:00:00' }),
      editorOn(occurrence, { when: { allDay: false, start: addHours(start, 1), end: addHours(end, 1) } }),
      context,
    );

    expect(updates.start).toBe('2026-10-05T09:00:00');
    expect(updates).not.toHaveProperty('timeZone');
  });
});

// Weekly on Wednesdays from 9 December, 10:00 in Berlin, five times; userb
// accepted. 16 December is excluded, 30 December retitled, and 6 January
// moved to 14:00 on its own. 1.0 returns the overrides as PatchObjects; 0.16
// as the app wrote them on the base event: the occurrence's time pinned, its
// participants copied, and the server's `updated`.
function seriesWithOverrides(version: Version): CalendarEvent {
  const participants = { org: participant(version, ORGANIZER, true, 'accepted'), b: participant(version, ATTENDEE, false, 'accepted') };
  const written = (start: string, extra: Record<string, unknown> = {}) => ({
    updated: '2026-11-20T09:00:00Z', start, duration: 'PT1H', participants, ...extra,
  });
  return {
    ...series(version),
    start: '2026-12-09T10:00:00', utcStart: '2026-12-09T09:00:00Z', utcEnd: '2026-12-09T10:00:00Z',
    participants,
    recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: 5 }],
    recurrenceOverrides: version === '1.0'
      ? {
        '2026-12-16T10:00:00': { excluded: true },
        '2026-12-30T10:00:00': { title: 'Planning, special' },
        '2027-01-06T10:00:00': { start: '2027-01-06T14:00:00' },
      }
      : {
        '2026-12-16T10:00:00': { excluded: true },
        '2026-12-30T10:00:00': written('2026-12-30T10:00:00', { title: 'Planning, special' }),
        '2027-01-06T10:00:00': written('2027-01-06T14:00:00'),
      },
  } as unknown as CalendarEvent;
}

/** A Berlin wall clock in winter (UTC+1), `hours` later, as the UTC instant the server reports. */
const berlinUtc = (wall: string, hours = 0) => `${new Date(Date.parse(`${wall}+01:00`) + hours * 3_600_000).toISOString().slice(0, 19)}Z`;

/** An occurrence of seriesWithOverrides as the server expands it, on its (own) day and time. */
function overriddenOccurrence(version: Version, recurrenceId: string, start = recurrenceId): CalendarEvent {
  return {
    ...seriesWithOverrides(version), id: 'maaaaad', baseEventId: 'b', start, recurrenceId, recurrenceIdTimeZone: 'Europe/Berlin',
    utcStart: berlinUtc(start), utcEnd: berlinUtc(start, 1),
  } as CalendarEvent;
}

const moveBy = (occurrence: CalendarEvent, hours: number): Partial<SeriesEdit> => {
  const { start, end } = editorTimesFromEvent(occurrence);
  return { when: { allDay: false, start: addHours(start, hours), end: addHours(end, hours) } };
};

// A series moved for every occurrence kept its overrides under the old
// recurrence ids: 16 December came back at 11:00, 30 December showed twice
// (10:00 "special" and 11:00), in the attendee's copy too (live on 1.0 and
// 0.16.23). Each override now goes with its occurrence.
describe.each<[string, Version]>([['1.0', '1.0'], ['0.16', '0.16']])('overrides of a series moved for every occurrence on Stalwart %s', (_label, version) => {
  const pinned = (start: string, extra: Record<string, unknown> = {}) => ({ start, duration: 'PT1H', ...extra });

  it('moves every override with its occurrence; one moved on its own keeps its time', () => {
    const occurrence = overriddenOccurrence(version, '2026-12-23T10:00:00');
    const updates = seriesUpdatesFromOccurrence(
      occurrence, seriesWithOverrides(version), editorUpdates(occurrence), editorOn(occurrence, moveBy(occurrence, 1)), context,
    );

    expect(updates.start).toBe('2026-12-09T11:00:00');
    const overrides = updates.recurrenceOverrides as Record<string, Record<string, unknown>>;
    expect(Object.keys(overrides).sort()).toEqual(['2026-12-16T11:00:00', '2026-12-30T11:00:00', '2027-01-06T11:00:00']);
    expect(overrides['2026-12-16T11:00:00']).toEqual({ excluded: true });
    if (version === '1.0') {
      expect(overrides['2026-12-30T11:00:00']).toEqual({ title: 'Planning, special' });
      expect(overrides['2027-01-06T11:00:00']).toEqual({ start: '2027-01-06T14:00:00' });
    } else {
      // The time the override only held moves; the answers in it are asked
      // again with the series'. 6 January stays at 14:00 and keeps them.
      expect(overrides['2026-12-30T11:00:00']).toMatchObject(pinned('2026-12-30T11:00:00', { title: 'Planning, special' }));
      expect(statusOf(overrides['2026-12-30T11:00:00'].participants as CalendarEvent['participants'], ATTENDEE)).toBe('needs-action');
      expect(overrides['2027-01-06T11:00:00']).toMatchObject(pinned('2027-01-06T14:00:00'));
      expect(statusOf(overrides['2027-01-06T11:00:00'].participants as CalendarEvent['participants'], ATTENDEE)).toBe('accepted');
      expect(overrides['2026-12-30T11:00:00']).not.toHaveProperty('updated');
    }
  });

  it('moves the overrides to the day the series moved to', () => {
    const occurrence = overriddenOccurrence(version, '2026-12-23T10:00:00');
    const updates = seriesUpdatesFromOccurrence(
      occurrence, seriesWithOverrides(version), editorUpdates(occurrence), editorOn(occurrence, moveBy(occurrence, 24)), context,
    );

    expect(updates.start).toBe('2026-12-10T10:00:00');
    expect(Object.keys(updates.recurrenceOverrides!).sort()).toEqual(['2026-12-17T10:00:00', '2026-12-31T10:00:00', '2027-01-07T10:00:00']);
    expect(updates.recurrenceOverrides!['2027-01-07T10:00:00']).toMatchObject({ start: '2027-01-06T14:00:00' });
  });

  it('gives the occurrence the editor was opened on the move made there', () => {
    // 6 January, at 14:00 on its own, moved to 15:00 for every occurrence.
    const occurrence = overriddenOccurrence(version, '2027-01-06T10:00:00', '2027-01-06T14:00:00');
    const updates = seriesUpdatesFromOccurrence(
      occurrence, seriesWithOverrides(version), editorUpdates(occurrence), editorOn(occurrence, moveBy(occurrence, 1)), context,
    );

    expect(updates.start).toBe('2026-12-09T11:00:00');
    expect(updates.recurrenceOverrides!['2027-01-06T11:00:00']).toMatchObject({ start: '2027-01-06T15:00:00' });
    expect(updates.recurrenceOverrides!['2026-12-30T11:00:00']).toMatchObject({ title: 'Planning, special' });
  });

  it('takes every occurrence along when the series turns all-day', () => {
    const occurrence = overriddenOccurrence(version, '2026-12-23T10:00:00');
    const day = startOfDay(getEventStartDate(occurrence));
    const updates = seriesUpdatesFromOccurrence(
      occurrence, seriesWithOverrides(version),
      editorUpdates(occurrence, { start: '2026-12-23T00:00:00', duration: 'P1D', timeZone: null, showWithoutTime: true }),
      editorOn(occurrence, { when: { allDay: true, start: day, end: day } }), context,
    );

    expect(updates).toMatchObject({ start: '2026-12-09T00:00:00', showWithoutTime: true });
    const overrides = updates.recurrenceOverrides as Record<string, Record<string, unknown>>;
    expect(overrides['2026-12-16T00:00:00']).toEqual({ excluded: true });
    expect(overrides['2026-12-30T00:00:00']).toMatchObject({ title: 'Planning, special' });
    for (const key of ['start', 'duration', 'timeZone']) expect(overrides['2026-12-30T00:00:00']).not.toHaveProperty(key);
    // 6 January had nothing but its own time (on 1.0): with it gone, so is the override.
    if (version === '1.0') expect(overrides).not.toHaveProperty('2027-01-06T00:00:00');
  });

  it('drops the overrides of occurrences a new rule no longer has', () => {
    const occurrence = overriddenOccurrence(version, '2026-12-23T10:00:00');
    const everyOtherWeek = [{ '@type': 'RecurrenceRule' as const, frequency: 'weekly', interval: 2, count: 5 }];
    const updates = seriesUpdatesFromOccurrence(
      occurrence, seriesWithOverrides(version), editorUpdates(occurrence, { recurrenceRules: everyOtherWeek }),
      editorOn(occurrence, { ruleChanged: true }), context,
    );

    // 9, 23 December and 6 January stay; 16 and 30 December are gone.
    expect(updates).not.toHaveProperty('start');
    expect(Object.keys(updates.recurrenceOverrides!)).toEqual(['2027-01-06T10:00:00']);
  });

  it('leaves the overrides alone when the series only gets a new title', () => {
    const occurrence = overriddenOccurrence(version, '2026-12-23T10:00:00');
    const updates = seriesUpdatesFromOccurrence(
      occurrence, seriesWithOverrides(version), editorUpdates(occurrence, { title: 'Planning, room 2' }), editorOn(occurrence), context,
    );

    expect(updates).not.toHaveProperty('recurrenceOverrides');
  });

  it('moves them the same way for an occurrence the device expanded', () => {
    const master = seriesWithOverrides(version);
    const occurrence = expandRecurringEvents([master], '2026-12-01T00:00:00', '2027-01-31T00:00:00')
      .find((o) => o.recurrenceId === '2026-12-23T10:00:00')!;
    const updates = seriesUpdatesFromOccurrence(
      occurrence, master, editorUpdates(occurrence), editorOn(occurrence, moveBy(occurrence, 1)), context,
    );

    expect(updates.start).toBe('2026-12-09T11:00:00');
    expect(Object.keys(updates.recurrenceOverrides!).sort()).toEqual(['2026-12-16T11:00:00', '2026-12-30T11:00:00', '2027-01-06T11:00:00']);
  });
});

// "This and the following occurrences" left the overrides after the split in
// the old series, whose rule no longer reached them: they showed on as
// occurrences of it, next to the new series. And the new series got the
// whole COUNT again. Six weekly occurrences from 7 December, 4 January
// retitled alone, split from 21 December: the old series showed 7 and 14
// December and 4 January, the new one ran six times to 25 January (live on
// 1.0 and 0.16.23).
describe.each<[string, Version]>([['1.0', '1.0'], ['0.16', '0.16']])('overrides of a series split from one occurrence on Stalwart %s', (_label, version) => {
  function sixWeeks(overrides: CalendarEvent['recurrenceOverrides']): CalendarEvent {
    return {
      ...series(version), start: '2026-12-07T10:00:00', utcStart: '2026-12-07T09:00:00Z', utcEnd: '2026-12-07T10:00:00Z',
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: 6 }], recurrenceOverrides: overrides,
    } as unknown as CalendarEvent;
  }
  const special = version === '1.0'
    ? { title: 'Planning, special' }
    : {
      updated: '2026-11-20T09:00:00Z', start: '2027-01-04T10:00:00', duration: 'PT1H', title: 'Planning, special',
      participants: { org: participant(version, ORGANIZER, true, 'accepted'), b: participant(version, ATTENDEE, false, 'accepted') },
    };
  const occurrenceOf = (master: CalendarEvent, recurrenceId: string) => ({
    ...master, id: 'maaaaae', baseEventId: 'b', start: recurrenceId, recurrenceId, recurrenceIdTimeZone: 'Europe/Berlin',
    utcStart: berlinUtc(recurrenceId), utcEnd: berlinUtc(recurrenceId, 1),
  }) as CalendarEvent;

  it('ends the old series with its overrides, and gives the new one those and what is left of the count', async () => {
    const master = sixWeeks({ '2027-01-04T10:00:00': special } as never);
    const occurrence = occurrenceOf(master, '2026-12-21T10:00:00');
    const deps = actions(master);

    await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence, { title: 'Planning, room 2' }), editor: editorOn(occurrence),
      sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    expect(deps.updateEvent).toHaveBeenCalledWith('b', {
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: null, until: '2026-12-21T09:59:59' }],
      'recurrenceOverrides/2027-01-04T10:00:00': null,
    }, { sendSchedulingMessages: true });
    const [created] = deps.createEvent.mock.calls[0];
    expect(created.start).toBe('2026-12-21T10:00:00');
    expect(created.recurrenceRules).toEqual([{ '@type': 'RecurrenceRule', frequency: 'weekly', count: 4 }]);
    // What the organizer changed goes along, not the answers the old series
    // had. 0.16 keeps an override as an event of its own: it gets the new
    // series' participants, asked again, or the occurrence has none.
    expect(created.recurrenceOverrides).toEqual({
      '2027-01-04T10:00:00': version === '1.0'
        ? { title: 'Planning, special' }
        : { start: '2027-01-04T10:00:00', duration: 'PT1H', title: 'Planning, special', participants: created.participants },
    });
    expect(statusOf(created.participants, ATTENDEE)).toBe('needs-action');
  });

  it('takes an exclusion along, and keeps the overrides before the split', async () => {
    const master = sixWeeks({ '2026-12-14T10:00:00': special, '2026-12-28T10:00:00': { excluded: true } } as never);
    const occurrence = occurrenceOf(master, '2026-12-21T10:00:00');
    const deps = actions(master);

    await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence), editor: editorOn(occurrence), sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    const [, patch] = deps.updateEvent.mock.calls[0];
    expect(Object.keys(patch).sort()).toEqual(['recurrenceOverrides/2026-12-28T10:00:00', 'recurrenceRules']);
    expect(deps.createEvent.mock.calls[0][0].recurrenceOverrides).toEqual({ '2026-12-28T10:00:00': { excluded: true } });
  });

  it('keeps the rule the user gave the new series, count and all', async () => {
    const master = sixWeeks(null);
    const occurrence = occurrenceOf(master, '2026-12-21T10:00:00');
    const deps = actions(master);
    const daily = [{ '@type': 'RecurrenceRule' as const, frequency: 'daily', count: 10 }];

    await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence, { recurrenceRules: daily }), editor: editorOn(occurrence, { ruleChanged: true }),
      sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    expect(deps.createEvent.mock.calls[0][0].recurrenceRules).toEqual(daily);
  });

  it('keeps an UNTIL as it was', async () => {
    const master = { ...sixWeeks(null), recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', until: '2027-01-31T23:59:59' }] } as CalendarEvent;
    const occurrence = occurrenceOf(master, '2026-12-21T10:00:00');
    const deps = actions(master);

    await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence, { title: 'Planning, room 2' }), editor: editorOn(occurrence),
      sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    expect(deps.createEvent.mock.calls[0][0].recurrenceRules).toEqual([{ '@type': 'RecurrenceRule', frequency: 'weekly', until: '2027-01-31T23:59:59' }]);
  });

  // 18 December on, of a weekly series on Fridays: the retitled 1 January
  // stayed as an occurrence of the old series.
  it('deletes the overrides from the occurrence on with the rest of the series', async () => {
    const master = {
      ...sixWeeks({ '2027-01-01T10:00:00': { ...special, ...(version === '1.0' ? {} : { start: '2027-01-01T10:00:00' }) } } as never),
      start: '2026-12-04T10:00:00',
    } as CalendarEvent;
    const deps = actions(master);

    await deleteOccurrence('this_and_future', { event: occurrenceOf(master, '2026-12-18T10:00:00'), userEmails: [ORGANIZER] }, deps);

    expect(deps.updateEvent).toHaveBeenCalledWith('b', {
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: null, until: '2026-12-18T09:59:59' }],
      'recurrenceOverrides/2027-01-01T10:00:00': null,
    }, { sendSchedulingMessages: true });
    expect(deps.deleteEvent).not.toHaveBeenCalled();
  });
});

// The move of an "all" edit was measured on the calendar's clock. In the week
// Berlin leaves summer time and New York does not yet, 16:00 on Saturday and
// 16:00 on Monday in Berlin are 10:00 and 11:00 in New York: the series went
// to Mondays at 10:00 instead of the 11:00 the user picked.
describe('changing every occurrence across a week only one zone changes clocks in', () => {
  it('moves the series by what the move is on its own clock', () => {
    // Saturdays 10:00 in New York from 3 October; the calendar is in Berlin.
    const master = {
      ...series('1.0'), start: '2026-10-03T10:00:00', timeZone: 'America/New_York',
      utcStart: '2026-10-03T14:00:00Z', utcEnd: '2026-10-03T15:00:00Z',
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }], recurrenceOverrides: null,
    } as unknown as CalendarEvent;
    const occurrence = {
      ...master, id: 'maaaaac', baseEventId: 'b', start: '2026-10-24T10:00:00', recurrenceId: '2026-10-24T10:00:00',
      utcStart: '2026-10-24T14:00:00Z', utcEnd: '2026-10-24T15:00:00Z',
    } as CalendarEvent;
    const { start: from } = editorTimesFromEvent(occurrence);
    // 16:00 in Berlin on Saturday 24 October, moved to 16:00 on Monday 26 October.
    expect(from.getHours()).toBe(16);
    const updates = seriesUpdatesFromOccurrence(
      occurrence, master, editorUpdates(occurrence, { start: '2026-10-26T11:00:00' }),
      editorOn(occurrence, { when: { allDay: false, start: addDays(from, 2), end: addHours(addDays(from, 2), 1) } }),
      context,
    );

    expect(updates.start).toBe('2026-10-05T11:00:00');
  });
});

// "All" from an occurrence with an override of its own wrote everything the
// editor showed - the occurrence's own title, copied into its override when
// it got one - to the series: a new room there renamed the series back.
describe.each<[string, Version]>([['1.0', '1.0'], ['0.16', '0.16']])('what "all" writes from an overridden occurrence on Stalwart %s', (_label, version) => {
  const room = (name: string) => ({ loc1: { '@type': 'Location', name } }) as unknown as CalendarEvent['locations'];
  // "Daily sync" weekly from 7 December. 21 December is called "Standup" in
  // room 1; 28 December was moved to 14:00 on its own (0.16 copied the
  // title then, as it was).
  function withOwnTitle(): CalendarEvent {
    const copies = version === '1.0' ? {} : { duration: 'PT1H', title: 'Daily sync' };
    return {
      ...series(version), title: 'Daily sync', start: '2026-12-07T10:00:00', utcStart: '2026-12-07T09:00:00Z', utcEnd: '2026-12-07T10:00:00Z',
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }], locations: room('Room 0'),
      recurrenceOverrides: {
        '2026-12-21T10:00:00': version === '1.0'
          ? { title: 'Standup', locations: room('Room 1') }
          : { start: '2026-12-21T10:00:00', duration: 'PT1H', title: 'Standup', locations: room('Room 1') },
        '2026-12-28T10:00:00': { start: '2026-12-28T14:00:00', ...copies },
      },
    } as unknown as CalendarEvent;
  }
  const on = (master: CalendarEvent, recurrenceId: string, own: Partial<CalendarEvent> = {}) => ({
    ...master, id: 'maaaaac', baseEventId: 'b', start: recurrenceId, recurrenceId,
    utcStart: berlinUtc(recurrenceId), utcEnd: berlinUtc(recurrenceId, 1), ...own,
  }) as CalendarEvent;

  it('writes only the new room to the series, and to that occurrence', () => {
    const master = withOwnTitle();
    const occurrence = on(master, '2026-12-21T10:00:00', { title: 'Standup', locations: room('Room 1') });
    const updates = seriesUpdatesFromOccurrence(
      occurrence, master, editorUpdates(occurrence, { locations: room('Room 2') }), editorOn(occurrence), context,
    );

    expect(updates).not.toHaveProperty('title');
    expect(updates.locations).toEqual(room('Room 2'));
    const own = updates.recurrenceOverrides!['2026-12-21T10:00:00'] as Record<string, unknown>;
    expect(own).toMatchObject({ title: 'Standup', locations: room('Room 2') });
  });

  // 1.0 returns the field as pointers when the occurrence's value came from
  // the editor under another id (live): the room stayed Room 1 there.
  it('replaces pointers into the changed field on that occurrence', () => {
    const master = withOwnTitle();
    master.recurrenceOverrides!['2026-12-21T10:00:00'] = {
      title: 'Standup', 'locations/loc1/name': 'Room 1', 'locations/l': null,
    } as never;
    const occurrence = on(master, '2026-12-21T10:00:00', { title: 'Standup', locations: room('Room 1') });
    const updates = seriesUpdatesFromOccurrence(
      occurrence, master, editorUpdates(occurrence, { locations: room('Room 2') }), editorOn(occurrence), context,
    );

    expect(updates.recurrenceOverrides!['2026-12-21T10:00:00']).toEqual({ title: 'Standup', locations: room('Room 2') });
  });

  it('renames the series and the occurrences that only had its old name, not one with its own', () => {
    const master = withOwnTitle();
    const occurrence = on(master, '2026-12-14T10:00:00');
    const updates = seriesUpdatesFromOccurrence(
      occurrence, master, editorUpdates(occurrence, { title: 'Weekly sync' }), editorOn(occurrence), context,
    );

    expect(updates.title).toBe('Weekly sync');
    if (version === '1.0') {
      // 1.0 keeps an override as a patch: 28 December has no title to change.
      expect(updates).not.toHaveProperty('recurrenceOverrides');
    } else {
      const overrides = updates.recurrenceOverrides as Record<string, Record<string, unknown>>;
      expect(overrides['2026-12-28T10:00:00'].title).toBe('Weekly sync');
      expect(overrides['2026-12-21T10:00:00'].title).toBe('Standup');
    }
  });
});

// "This and following" started the new series at the opened occurrence's own
// time and in the calendar's zone. Mondays 10:00 in New York, 21 December
// moved alone to Tuesday: renamed from there by a user in Berlin, the rest
// became a Tuesday series at 16:00 in Berlin.
describe.each<[string, Version]>([['1.0', '1.0'], ['0.16', '0.16']])('where "this and following" goes on on Stalwart %s', (_label, version) => {
  function mondays(): CalendarEvent {
    return {
      ...series(version), start: '2026-12-07T10:00:00', timeZone: 'America/New_York',
      utcStart: '2026-12-07T15:00:00Z', utcEnd: '2026-12-07T16:00:00Z',
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }],
      recurrenceOverrides: {
        '2026-12-21T10:00:00': version === '1.0'
          ? { start: '2026-12-22T10:00:00', title: 'Planning, Tuesday' }
          : { start: '2026-12-22T10:00:00', duration: 'PT1H', title: 'Planning, Tuesday' },
      },
    } as unknown as CalendarEvent;
  }
  // 21 December as the server hands it out: on Tuesday, 16:00 in Berlin.
  const tuesday = (master: CalendarEvent) => ({
    ...master, id: 'maaaaac', baseEventId: 'b', start: '2026-12-22T10:00:00', recurrenceId: '2026-12-21T10:00:00',
    recurrenceIdTimeZone: 'America/New_York', title: 'Planning, Tuesday',
    utcStart: '2026-12-22T15:00:00Z', utcEnd: '2026-12-22T16:00:00Z',
  }) as CalendarEvent;

  async function split(change: Partial<CalendarEvent>, hours = 0) {
    const master = mondays();
    const occurrence = tuesday(master);
    const deps = actions(master);
    await saveOccurrenceEdit('this_and_future', {
      event: occurrence,
      updates: editorUpdates(occurrence, change),
      editor: editorOn(occurrence, hours ? moveBy(occurrence, hours) : {}),
      sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);
    return deps.createEvent.mock.calls[0][0];
  }

  it('goes on from the occurrence\'s place in the series, in the series\' zone, the moved occurrence staying where it was', async () => {
    const created = await split({ description: 'New agenda' });

    expect(created).toMatchObject({ start: '2026-12-21T10:00:00', timeZone: 'America/New_York', description: 'New agenda' });
    // The series' title, not the occurrence's own; that one stays with it.
    expect(created.title).toBe('Planning');
    expect(created.recurrenceOverrides!['2026-12-21T10:00:00']).toMatchObject({ start: '2026-12-22T10:00:00', title: 'Planning, Tuesday' });
  });

  it('moves the new series and the occurrence by what the editor moved it', async () => {
    const created = await split({}, 1);

    expect(created).toMatchObject({ start: '2026-12-21T11:00:00', timeZone: 'America/New_York' });
    expect(created.recurrenceOverrides!['2026-12-21T11:00:00']).toMatchObject({ start: '2026-12-22T11:00:00' });
  });
});

describe('saveOccurrenceEdit for every occurrence', () => {
  it('writes the series\' own change to its base event on Stalwart 1.0', async () => {
    const occurrence = serverOccurrence('1.0');
    const deps = actions(series('1.0'));

    const saved = await saveOccurrenceEdit('all', {
      event: occurrence,
      updates: editorUpdates(occurrence, { title: 'Planning, room 2' }),
      editor: editorOn(occurrence),
      sendScheduling: true,
      userEmails: [ORGANIZER],
    }, deps);

    expect(saved).toBe(true);
    expect(deps.getMasterEvent).toHaveBeenCalledWith(occurrence);
    // What the user changed, and only that: the rule the editor wrote as it
    // was stays the series' own. The attendees are told, and 19 October has
    // an override: the SEQUENCE goes up (see below).
    expect(deps.updateEvent).toHaveBeenCalledWith('b', {
      title: 'Planning, room 2', sequence: 1, 'recurrenceOverrides/2026-10-19T10:00:00/sequence': 1,
    }, { sendSchedulingMessages: true });
  });

  it('reports a series it cannot find', async () => {
    const occurrence = serverOccurrence('1.0');
    const deps = actions(null);

    const saved = await saveOccurrenceEdit('all', {
      event: occurrence, updates: editorUpdates(occurrence), editor: editorOn(occurrence), userEmails: [ORGANIZER],
    }, deps);

    expect(saved).toBe(false);
    expect(deps.updateEvent).not.toHaveBeenCalled();
  });
});

// "This and the following occurrences" ends the series before the
// occurrence and makes a new series of the rest. The new series kept the
// answers, and Stalwart invites to a new event only attendees without one:
// everyone who had answered lost the following occurrences without a word.
describe.each(occurrences)('saving this and the following occurrences on Stalwart %s', (_label, version, make) => {
  const truncated = [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: null, until: '2026-10-19T09:59:59' }];
  // The series ends before 19 October, and userb's answer to 19 October
  // (an override) goes with it.
  const truncation = { recurrenceRules: truncated, 'recurrenceOverrides/2026-10-19T10:00:00': null };

  it('tells the attendees the series ends there, and asks all of them to the new one', async () => {
    const occurrence = make();
    const deps = actions(series(version));

    const saved = await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence, { title: 'Planning, room 2' }), editor: editorOn(occurrence),
      calendarId: 'cal', sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    expect(saved).toBe(true);
    expect(deps.updateEvent).toHaveBeenCalledTimes(1);
    expect(deps.updateEvent).toHaveBeenCalledWith('b', truncation, { sendSchedulingMessages: true });
    const [created, calendarId, options] = deps.createEvent.mock.calls[0];
    expect([calendarId, options]).toEqual(['cal', { sendSchedulingMessages: true }]);
    // Five occurrences in all, two of them before 19 October.
    expect(created).toMatchObject({
      title: 'Planning, room 2', start: '2026-10-19T10:00:00',
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: 3 }],
    });
    // The new series asks userb again for every occurrence: the old answer
    // to 19 October does not come along. The store puts it in the calendar.
    for (const key of ['id', 'uid', 'recurrenceId', 'recurrenceOverrides', 'calendarIds', 'isOrigin']) expect(created).not.toHaveProperty(key);
    expect(statusOf(created.participants, ORGANIZER)).toBe('accepted');
    expect(statusOf(created.participants, ATTENDEE)).toBe('needs-action');
  });

  // A store that answers a failure with nothing: the series stayed ended,
  // told so to the attendees, and the save said it had worked.
  it('puts the series back, telling the attendees again, when the store could not create the new one', async () => {
    const occurrence = make();
    const deps = actions(series(version));
    deps.createEvent.mockResolvedValue(null);

    await expect(saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence), editor: editorOn(occurrence), sendScheduling: true, userEmails: [ORGANIZER],
    }, deps)).rejects.toThrow('rest of the series');

    expect(deps.updateEvent).toHaveBeenCalledTimes(2);
    // The whole map: the truncation took the series' only override, and a
    // pointer into a series without overrides fails.
    expect(deps.updateEvent).toHaveBeenLastCalledWith('b', {
      recurrenceRules: series(version).recurrenceRules,
      recurrenceOverrides: series(version).recurrenceOverrides,
    }, { sendSchedulingMessages: true });
  });

  it('puts the series back and passes on a refusal the store passes on', async () => {
    const occurrence = make();
    const deps = actions(series(version));
    deps.createEvent.mockRejectedValue(new Error('An event cannot have more than 20 participants.'));

    await expect(saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence), editor: editorOn(occurrence), sendScheduling: true, userEmails: [ORGANIZER],
    }, deps)).rejects.toThrow('more than 20');

    expect(deps.updateEvent).toHaveBeenLastCalledWith('b', expect.objectContaining({
      recurrenceRules: series(version).recurrenceRules,
    }), { sendSchedulingMessages: true });
  });

  it('ends an attendee\'s own copy quietly', async () => {
    const occurrence = make();
    const deps = actions({ ...series(version), isOrigin: false });

    await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence, { participants: undefined }), editor: editorOn(occurrence),
      sendScheduling: false, userEmails: [ATTENDEE],
    }, deps);

    expect(deps.updateEvent).toHaveBeenCalledWith('b', truncation, { sendSchedulingMessages: false });
    expect(deps.createEvent.mock.calls[0][2]).toEqual({ sendSchedulingMessages: false });
  });

  it('ends the series quietly when the user sends no invitations', async () => {
    const occurrence = make();
    const deps = actions(series(version));

    await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence), editor: editorOn(occurrence), sendScheduling: false, userEmails: [ORGANIZER],
    }, deps);

    expect(deps.updateEvent).toHaveBeenCalledWith('b', truncation, { sendSchedulingMessages: false });
  });

  // The series in userc's calendar, shared with usera read & write: the
  // split has to tell the attendees and ask them to the rest.
  it('tells the attendees and asks them to the new series when the user splits the owner\'s series in a shared calendar', async () => {
    const occurrence = make();
    const deps = actions({ ...series(version), isOrigin: true, isShared: true, accountId: 'f' });

    await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence, { title: 'Planning, room 2' }), editor: editorOn(occurrence),
      sendScheduling: true, userEmails: [SHAREE],
    }, deps);

    expect(deps.updateEvent).toHaveBeenCalledWith('b', truncation, { sendSchedulingMessages: true });
    const [created, , options] = deps.createEvent.mock.calls[0];
    expect(options).toEqual({ sendSchedulingMessages: true });
    expect(statusOf(created.participants, ORGANIZER)).toBe('accepted');
    expect(statusOf(created.participants, ATTENDEE)).toBe('needs-action');
  });
});

describe('the new series from this and the following occurrences', () => {
  it('starts at the occurrence and leaves the old series\' identity behind', () => {
    const occurrence = serverOccurrence('1.0');
    const data = followingSeriesData(occurrence, series('1.0'), { title: 'Moved on', recurrenceId: occurrence.recurrenceId }, null);

    expect(data).toMatchObject({ title: 'Moved on', start: '2026-10-19T10:00:00', recurrenceRules: null, timeZone: 'Europe/Berlin' });
    expect(data).not.toHaveProperty('recurrenceId');
    // Without participants in the change there are none to ask.
    expect(data).not.toHaveProperty('participants');
  });

  it('leaves the calendar\'s default reminders to the switch', () => {
    const occurrence = serverOccurrence('1.0');
    const defaults = { ...series('1.0'), useDefaultAlerts: true, alerts: { d1: { '@type': 'Alert' } } } as unknown as CalendarEvent;

    const data = followingSeriesData(occurrence, defaults, {}, defaults.recurrenceRules!);

    expect(data.useDefaultAlerts).toBe(true);
    expect(data).not.toHaveProperty('alerts');
  });
});

describe.each(occurrences)('saving one occurrence on Stalwart %s', (_label, _version, make) => {
  it('hands the change to the store for that occurrence', async () => {
    const occurrence = make();
    const deps = actions(series('1.0'));
    const updates = editorUpdates(occurrence, { title: 'Planning, room 2' });

    await saveOccurrenceEdit('this', { event: occurrence, updates, sendScheduling: true, userEmails: [ORGANIZER] }, deps);

    expect(deps.updateEvent).toHaveBeenCalledWith(occurrence.id, updates, { sendSchedulingMessages: true });
    expect(deps.getMasterEvent).not.toHaveBeenCalled();
  });
});

describe.each(occurrences)('deleting part of a series from one occurrence on Stalwart %s', (_label, version, make) => {
  it('deletes that occurrence alone through the store', async () => {
    const occurrence = make();
    const deps = actions(series(version));

    await deleteOccurrence('this', { event: occurrence, userEmails: [ORGANIZER] }, deps);

    expect(deps.deleteEvent).toHaveBeenCalledWith(occurrence.id);
  });

  it('ends the series before it, telling the attendees', async () => {
    const occurrence = make();
    const deps = actions(series(version));

    await deleteOccurrence('this_and_future', { event: occurrence, userEmails: [ORGANIZER] }, deps);

    expect(deps.updateEvent).toHaveBeenCalledWith('b', {
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: null, until: '2026-10-19T09:59:59' }],
      'recurrenceOverrides/2026-10-19T10:00:00': null,
    }, { sendSchedulingMessages: true });
    expect(deps.deleteEvent).not.toHaveBeenCalled();
  });

  it('ends an attendee\'s copy quietly', async () => {
    const occurrence = make();
    const deps = actions({ ...series(version), isOrigin: false });

    await deleteOccurrence('this_and_future', { event: occurrence, userEmails: [ATTENDEE] }, deps);

    expect(deps.updateEvent.mock.calls[0][2]).toEqual({ sendSchedulingMessages: false });
  });

  it('deletes the series for every occurrence', async () => {
    const deps = actions(series(version));

    await deleteOccurrence('all', { event: make(), userEmails: [ORGANIZER] }, deps);

    expect(deps.deleteEvent).toHaveBeenCalledWith('b');
  });
});

describe('ending an all-day series', () => {
  it('ends it the day before the occurrence', async () => {
    const master = {
      ...series('0.16'), start: '2026-10-05T00:00:00', duration: 'P1D', timeZone: null, showWithoutTime: true,
      utcStart: undefined, utcEnd: undefined, recurrenceOverrides: null,
    } as unknown as CalendarEvent;
    const occurrence = expandRecurringEvents([master], '2026-10-01T00:00:00', '2026-11-30T00:00:00')
      .find((o) => o.recurrenceId === '2026-10-19T00:00:00')!;
    const deps = actions(master);

    await deleteOccurrence('this_and_future', { event: occurrence, userEmails: [ORGANIZER] }, deps);

    expect(deps.updateEvent.mock.calls[0][1]).toEqual({
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: null, until: '2026-10-18T23:59:59' }],
    });
  });
});

// An invitation to one occurrence alone: the server keeps it as an event of
// its own, with a recurrence id and no series to find. The store hands it
// back as its own "series".
describe('one occurrence the server keeps as its own event', () => {
  const lone = () => ({
    ...serverOccurrence('1.0'), id: 'lone', baseEventId: undefined, recurrenceRules: null, recurrenceOverrides: null,
  }) as unknown as CalendarEvent;

  it.each(['this', 'this_and_future', 'all'] as const)('is itself what changes, and what is deleted, for "%s"', async (scope) => {
    const deps = actions(lone());

    await saveOccurrenceEdit(scope, { event: lone(), updates: { title: 'Mine' }, userEmails: [ATTENDEE] }, deps);
    await deleteOccurrence(scope, { event: lone(), userEmails: [ATTENDEE] }, deps);

    expect(deps.updateEvent.mock.calls).toEqual([['lone', { title: 'Mine' }, { sendSchedulingMessages: undefined }]]);
    expect(deps.deleteEvent.mock.calls).toEqual([['lone']]);
    expect(deps.createEvent).not.toHaveBeenCalled();
  });
});

// 0.16 sends the change of one occurrence with its SEQUENCE raised, without
// keeping the raise itself. A later rename of every occurrence carried the
// lower number for it, and the attendee's server refused the whole change:
// the mail arrived, the copy stayed as it was (live on 0.16.23). 1.0 raises
// every occurrence's SEQUENCE the same way itself for a change it sends.
describe.each<[string, Version]>([['1.0', '1.0'], ['0.16', '0.16']])('the SEQUENCE of a changed series on Stalwart %s', (_label, version) => {
  // Five Mondays from 5 October, 19 October with an override: on 0.16 it
  // holds a sequence of its own (copied when it got the override), on 1.0
  // the PatchObject leaves it out while it is the series'.
  const withSequences = (overrides: CalendarEvent['recurrenceOverrides'] = series(version).recurrenceOverrides) => ({
    ...series(version), sequence: 2,
    recurrenceOverrides: version === '1.0'
      ? overrides
      : Object.fromEntries(Object.entries(overrides ?? {}).map(([key, entry]) => [key, { ...entry, sequence: 2 }])),
  }) as CalendarEvent;
  const occurrenceOn26 = () => ({
    ...serverOccurrence(version), id: 'maaaaad', start: '2026-10-26T10:00:00', recurrenceId: '2026-10-26T10:00:00',
    utcStart: '2026-10-26T09:00:00Z', utcEnd: '2026-10-26T10:00:00Z',
  }) as CalendarEvent;
  const save = async (
    master: CalendarEvent,
    change: Partial<CalendarEvent>,
    extra: { sendScheduling?: boolean } = {},
    editor: Partial<SeriesEdit> = {},
  ) => {
    const occurrence = occurrenceOn26();
    const deps = actions(master);
    await saveOccurrenceEdit('all', {
      event: occurrence, updates: editorUpdates(occurrence, change), editor: editorOn(occurrence, editor),
      sendScheduling: true, userEmails: [ORGANIZER], ...extra,
    }, deps);
    return deps.updateEvent.mock.calls[0];
  };

  it('raises the series\' and each changed occurrence\'s by one on a new title', async () => {
    const [id, patch, options] = await save(withSequences(), { title: 'Planning, room 2' });

    expect([id, options]).toEqual(['b', { sendSchedulingMessages: true }]);
    expect(patch).toEqual({ title: 'Planning, room 2', sequence: 3, 'recurrenceOverrides/2026-10-19T10:00:00/sequence': 3 });
  });

  it('raises them inside the overrides when the series moves', async () => {
    const { start, end } = editorTimesFromEvent(occurrenceOn26());
    const retitled = withSequences({ '2026-10-19T10:00:00': { title: 'Planning, special' } } as never);
    const [, patch] = await save(retitled, {}, {}, { when: { allDay: false, start: addHours(start, 1), end: addHours(end, 1) } });

    const raised = patch as Record<string, unknown> & { recurrenceOverrides: Record<string, { sequence?: number }> };
    expect(raised.sequence).toBe(3);
    expect(raised.recurrenceOverrides['2026-10-19T11:00:00'].sequence).toBe(3);
    expect(Object.keys(raised).some((key) => key.startsWith('recurrenceOverrides/'))).toBe(false);
  });

  it('leaves them alone when nothing goes out, nothing the attendees see changes, or no occurrence has an override', async () => {
    const quiet = await save(withSequences(), { title: 'Planning, room 2' }, { sendScheduling: false });
    const alerts = await save(withSequences(), {
      alerts: { a1: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT5M', relativeTo: 'start' }, action: 'display' } } as never,
    });
    const plain = await save({ ...withSequences(), recurrenceOverrides: null } as CalendarEvent, { title: 'Planning, room 2' });

    for (const [, patch] of [quiet, alerts, plain]) {
      expect(patch).not.toHaveProperty('sequence');
      expect(Object.keys(patch).some((key) => key.endsWith('/sequence'))).toBe(false);
    }
  });

  it('leaves them alone on an attendee\'s own copy', async () => {
    const occurrence = occurrenceOn26();
    const deps = actions({ ...withSequences(), isOrigin: false });

    await saveOccurrenceEdit('all', {
      event: occurrence, updates: editorUpdates(occurrence, { title: 'My name for it', participants: undefined }), editor: editorOn(occurrence),
      sendScheduling: false, userEmails: [ATTENDEE],
    }, deps);

    expect(deps.updateEvent.mock.calls[0][1]).toEqual({ title: 'My name for it' });
  });
});

// 0.16 (0.16.23 checked) reads UNTIL as the series' wall clock taken for
// UTC: in New York "until 09:59:59" kept the 10:00 occurrence it was to end
// before (live). Five hours earlier ends the series there on 0.16 and 1.0.
describe.each<[string, Version]>([['1.0', '1.0'], ['0.16', '0.16']])('ending a series in a zone behind UTC on Stalwart %s', (_label, version) => {
  const mondays = (start: string, utc: string) => ({
    ...series(version), start, timeZone: 'America/New_York', utcStart: utc, utcEnd: utc,
    recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }], recurrenceOverrides: null,
  }) as unknown as CalendarEvent;
  const occurrenceOf = (master: CalendarEvent, recurrenceId: string, utc: string) => ({
    ...master, id: 'maaaaac', baseEventId: 'b', start: recurrenceId, recurrenceId, recurrenceIdTimeZone: 'America/New_York',
    utcStart: utc, utcEnd: utc,
  }) as CalendarEvent;
  const untilOf = (patch: unknown) => (patch as { recurrenceRules: { until: string }[] }).recurrenceRules[0].until;

  it('ends it early enough for 0.16', async () => {
    const master = mondays('2026-12-07T10:00:00', '2026-12-07T15:00:00Z');
    const deps = actions(master);

    await deleteOccurrence('this_and_future', { event: occurrenceOf(master, '2026-12-21T10:00:00', '2026-12-21T15:00:00Z'), userEmails: [ORGANIZER] }, deps);

    expect(deps.updateEvent.mock.calls[0][1]).toEqual({
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', until: '2026-12-21T04:59:59', count: null }],
    });
  });

  it('takes the larger offset when the clocks changed the day before', async () => {
    // Sunday 8 March 2026: New York went to summer time that night (UTC-5
    // on Saturday, UTC-4 from Sunday 03:00).
    const master = { ...mondays('2026-03-01T10:00:00', '2026-03-01T15:00:00Z'), recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'daily' }] } as CalendarEvent;
    const deps = actions(master);

    await deleteOccurrence('this_and_future', { event: occurrenceOf(master, '2026-03-08T10:00:00', '2026-03-08T14:00:00Z'), userEmails: [ORGANIZER] }, deps);

    expect(untilOf(deps.updateEvent.mock.calls[0][1])).toBe('2026-03-08T04:59:59');
  });

  it('ends a split the same way', async () => {
    const master = mondays('2026-12-07T10:00:00', '2026-12-07T15:00:00Z');
    const occurrence = occurrenceOf(master, '2026-12-21T10:00:00', '2026-12-21T15:00:00Z');
    const deps = actions(master);

    await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence, { title: 'Planning, room 2' }), editor: editorOn(occurrence),
      sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    expect(untilOf(deps.updateEvent.mock.calls[0][1])).toBe('2026-12-21T04:59:59');
  });

  it('ends a floating or all-day series a second before, as before', async () => {
    const floating = { ...mondays('2026-12-07T10:00:00', '2026-12-07T15:00:00Z'), timeZone: null } as CalendarEvent;
    const deps = actions(floating);

    await deleteOccurrence('this_and_future', { event: occurrenceOf(floating, '2026-12-21T10:00:00', '2026-12-21T15:00:00Z'), userEmails: [ORGANIZER] }, deps);

    expect(untilOf(deps.updateEvent.mock.calls[0][1])).toBe('2026-12-21T09:59:59');
  });
});

// A series the app has not expanded - one opened from a reminder or a
// link, one an edit just made recurring - shows as the series itself, once,
// at its first occurrence. "This occurrence" of it went to the series: the
// editor's data rewrote every occurrence, and deleting it deleted the series.
describe.each<[string, Version]>([['1.0', '1.0'], ['0.16', '0.16']])('the series itself standing for its first occurrence on Stalwart %s', (_label, version) => {
  // As CalendarEvent/get returns the base event.
  const base = (overrides: Partial<CalendarEvent> = {}) => ({
    ...series(version), recurrenceOverrides: null, ...overrides,
  }) as CalendarEvent;
  const kickOff = (master: CalendarEvent) => editorUpdates(master, { title: 'Kick-off' });
  type Call = [string, Record<string, Record<string, Record<string, unknown>>>, unknown];

  // userb accepted the series. Stalwart sends a new override only to
  // attendees who have not answered: the change went out in one write that
  // reached nobody who had. It now takes the store's two steps.
  it('changes only the first occurrence for "this occurrence", in two steps for those who answered', async () => {
    const master = base();
    const deps = actions(master);

    const saved = await saveOccurrenceEdit('this', {
      event: master, updates: kickOff(master), sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    expect(saved).toBe(true);
    expect(deps.updateEvent).toHaveBeenCalledTimes(2);
    // First the occurrence as it is, without messages: the whole map, as the
    // series has no overrides yet; nothing of the series changes.
    const [id, copy, quiet] = deps.updateEvent.mock.calls[0] as unknown as Call;
    expect([id, quiet]).toEqual(['b', { sendSchedulingMessages: false }]);
    expect(Object.keys(copy)).toEqual(['recurrenceOverrides']);
    expect(copy.recurrenceOverrides['2026-10-05T10:00:00']).toMatchObject({ start: '2026-10-05T10:00:00', title: 'Planning' });
    // Then the change of that override, with messages.
    const [again, change, send] = deps.updateEvent.mock.calls[1] as unknown as Call;
    expect([again, send]).toEqual(['b', { sendSchedulingMessages: true }]);
    expect(Object.keys(change)).toEqual(['recurrenceOverrides/2026-10-05T10:00:00']);
    expect(change['recurrenceOverrides/2026-10-05T10:00:00']).toMatchObject({ start: '2026-10-05T10:00:00', title: 'Kick-off' });
    expect(statusOf(change['recurrenceOverrides/2026-10-05T10:00:00'].participants as CalendarEvent['participants'], ATTENDEE)).toBe('accepted');
  });

  it('changes it in one write when nobody has answered, or nothing is sent', async () => {
    const unanswered = base({
      participants: { org: participant(version, ORGANIZER, true, 'accepted'), b: participant(version, ATTENDEE, false, 'needs-action') },
    });
    for (const [master, send] of [[unanswered, true], [base(), false]] as const) {
      const deps = actions(master);

      await saveOccurrenceEdit('this', { event: master, updates: kickOff(master), sendScheduling: send, userEmails: [ORGANIZER] }, deps);

      expect(deps.updateEvent).toHaveBeenCalledTimes(1);
      const [id, patch, options] = deps.updateEvent.mock.calls[0] as unknown as Call;
      expect([id, options]).toEqual(['b', { sendSchedulingMessages: send }]);
      expect(patch.recurrenceOverrides['2026-10-05T10:00:00']).toMatchObject({ title: 'Kick-off' });
    }
  });

  it('adds the override to those the series has', async () => {
    const master = base({ recurrenceOverrides: series(version).recurrenceOverrides });
    const deps = actions(master);

    await saveOccurrenceEdit('this', { event: master, updates: kickOff(master), sendScheduling: true, userEmails: [ORGANIZER] }, deps);

    expect(Object.keys(deps.updateEvent.mock.calls[0][1])).toEqual(['recurrenceOverrides/2026-10-05T10:00:00']);
  });

  it('changes the whole series for "this and following" from its first occurrence', async () => {
    const master = base();
    const deps = actions(master);

    await saveOccurrenceEdit('this_and_future', {
      event: master, updates: kickOff(master), editor: editorOn(master), sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    // Not ended before its first occurrence, no new series: the series itself changes.
    expect(deps.createEvent).not.toHaveBeenCalled();
    expect(deps.updateEvent.mock.calls).toEqual([['b', { title: 'Kick-off' }, { sendSchedulingMessages: true }]]);
  });

  it('changes or deletes the whole series for "this and following" from the first occurrence of an expanded series too', async () => {
    const master = base();
    const first = { ...master, id: 'maaaaab', baseEventId: 'b', recurrenceId: '2026-10-05T10:00:00', recurrenceIdTimeZone: 'Europe/Berlin' } as CalendarEvent;
    const deps = actions(master);

    await saveOccurrenceEdit('this_and_future', {
      event: first, updates: kickOff(first), editor: editorOn(first), sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);
    await deleteOccurrence('this_and_future', { event: first, userEmails: [ORGANIZER] }, deps);

    expect(deps.createEvent).not.toHaveBeenCalled();
    expect(deps.updateEvent.mock.calls).toEqual([['b', { title: 'Kick-off' }, { sendSchedulingMessages: true }]]);
    expect(deps.deleteEvent.mock.calls).toEqual([['b']]);
  });

  it('excludes the first occurrence for "delete this occurrence"', async () => {
    const master = base();
    const deps = actions(master);

    const deleted = await deleteOccurrence('this', { event: master, userEmails: [ORGANIZER] }, deps);

    expect(deleted).toBe(true);
    expect(deps.deleteEvent).not.toHaveBeenCalled();
    expect(deps.updateEvent.mock.calls).toEqual([['b', { recurrenceOverrides: { '2026-10-05T10:00:00': { excluded: true } } }]]);
  });

  it('deletes the whole series for "delete this and following" from its first occurrence', async () => {
    const master = base();
    const deps = actions(master);

    await deleteOccurrence('this_and_future', { event: master, userEmails: [ORGANIZER] }, deps);

    expect(deps.deleteEvent).toHaveBeenCalledWith('b');
    expect(deps.updateEvent).not.toHaveBeenCalled();
  });

  it('refuses rather than touch a series it cannot find', async () => {
    const deps = actions(null);

    expect(await saveOccurrenceEdit('this', { event: base(), updates: { title: 'x' }, userEmails: [ORGANIZER] }, deps)).toBe(false);
    expect(await deleteOccurrence('this', { event: base(), userEmails: [ORGANIZER] }, deps)).toBe(false);
    expect(deps.updateEvent).not.toHaveBeenCalled();
    expect(deps.deleteEvent).not.toHaveBeenCalled();
  });
});

// A rule that names its days keeps its occurrences on them: a Monday and
// Tuesday series moved by a day for every occurrence still meets on Mondays
// and Tuesdays. Moved along, the Monday's override landed on the Tuesday's
// and one overwrote the other: the cancelled Tuesday came back with the
// Monday's title, and the Monday lost its change (live on 1.0 and 0.16.23).
describe.each<[string, Version]>([['1.0', '1.0'], ['0.16', '0.16']])('overrides of a series whose rule names its days on Stalwart %s', (_label, version) => {
  const participants = { org: participant(version, ORGANIZER, true, 'accepted'), b: participant(version, ATTENDEE, false, 'accepted') };
  const special = (start: string, title: string) => (version === '1.0'
    ? { title }
    : { updated: '2026-11-20T09:00:00Z', start, duration: 'PT1H', participants, title });
  function withDays(rule: Record<string, unknown>, overrides: Record<string, unknown>, start = '2026-12-07T10:00:00'): CalendarEvent {
    return {
      ...series(version), start, utcStart: berlinUtc(start), utcEnd: berlinUtc(start, 1),
      participants, recurrenceRules: [{ '@type': 'RecurrenceRule', ...rule }], recurrenceOverrides: overrides,
    } as unknown as CalendarEvent;
  }
  const mondayAndTuesday = () => withDays(
    { frequency: 'weekly', byDay: [{ day: 'mo' }, { day: 'tu' }], count: 8 },
    { '2026-12-14T10:00:00': special('2026-12-14T10:00:00', 'Planning, Monday special'), '2026-12-15T10:00:00': { excluded: true } },
  );
  const allFrom = (master: CalendarEvent, recurrenceId: string, hours: number) => {
    const occurrence = {
      ...master, id: 'maaaaaf', baseEventId: 'b', start: recurrenceId, recurrenceId, recurrenceIdTimeZone: 'Europe/Berlin',
      utcStart: berlinUtc(recurrenceId), utcEnd: berlinUtc(recurrenceId, 1),
    } as CalendarEvent;
    const updates = seriesUpdatesFromOccurrence(occurrence, master, editorUpdates(occurrence), editorOn(occurrence, moveBy(occurrence, hours)), context);
    // Unchanged overrides are not written again.
    return { updates, overrides: (updates.recurrenceOverrides ?? master.recurrenceOverrides) as Record<string, Record<string, unknown>> };
  };

  it('keeps each override on its day when every occurrence moves by a day', () => {
    const master = mondayAndTuesday();
    const { updates, overrides } = allFrom(master, '2026-12-21T10:00:00', 24);

    expect(updates.start).toBe('2026-12-08T10:00:00');
    expect(Object.keys(overrides).sort()).toEqual(['2026-12-14T10:00:00', '2026-12-15T10:00:00']);
    expect(overrides['2026-12-14T10:00:00']).toMatchObject({ title: 'Planning, Monday special' });
    if (version === '0.16') expect(overrides['2026-12-14T10:00:00'].start).toBe('2026-12-14T10:00:00');
    expect(overrides['2026-12-15T10:00:00']).toEqual({ excluded: true });
  });

  it('keeps each override on its day, at the new time, when the series also moves by an hour', () => {
    const master = mondayAndTuesday();
    const { overrides } = allFrom(master, '2026-12-21T10:00:00', 25);

    expect(Object.keys(overrides).sort()).toEqual(['2026-12-14T11:00:00', '2026-12-15T11:00:00']);
    expect(overrides['2026-12-14T11:00:00']).toMatchObject({ title: 'Planning, Monday special' });
    if (version === '0.16') expect(overrides['2026-12-14T11:00:00'].start).toBe('2026-12-14T11:00:00');
    expect(overrides['2026-12-15T11:00:00']).toEqual({ excluded: true });
  });

  it('keeps month days as well', () => {
    // The 5th and the 6th of each month; 5 January retitled, 6 January cancelled.
    const master = withDays(
      { frequency: 'monthly', byMonthDay: [5, 6], count: 6 },
      { '2027-01-05T10:00:00': special('2027-01-05T10:00:00', 'Planning, January'), '2027-01-06T10:00:00': { excluded: true } },
      '2026-12-05T10:00:00',
    );
    const { overrides } = allFrom(master, '2027-02-05T10:00:00', 24);

    expect(Object.keys(overrides).sort()).toEqual(['2027-01-05T10:00:00', '2027-01-06T10:00:00']);
    expect(overrides['2027-01-05T10:00:00']).toMatchObject({ title: 'Planning, January' });
    expect(overrides['2027-01-06T10:00:00']).toEqual({ excluded: true });
  });

  it('keeps them on their days for this and the following occurrences too', async () => {
    const master = mondayAndTuesday();
    const occurrence = {
      ...master, id: 'maaaaaf', baseEventId: 'b', start: '2026-12-08T10:00:00', recurrenceId: '2026-12-08T10:00:00',
      recurrenceIdTimeZone: 'Europe/Berlin', utcStart: berlinUtc('2026-12-08T10:00:00'), utcEnd: berlinUtc('2026-12-08T10:00:00', 1),
    } as CalendarEvent;
    const deps = actions(master);

    // From Tuesday 8 December on, moved by a day to the Wednesday.
    await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence), editor: editorOn(occurrence, moveBy(occurrence, 24)),
      sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    const created = deps.createEvent.mock.calls[0][0];
    expect(created.start).toBe('2026-12-09T10:00:00');
    expect(Object.keys(created.recurrenceOverrides ?? {}).sort()).toEqual(['2026-12-14T10:00:00', '2026-12-15T10:00:00']);
    expect(created.recurrenceOverrides!['2026-12-14T10:00:00']).toMatchObject({ title: 'Planning, Monday special' });
    expect(created.recurrenceOverrides!['2026-12-15T10:00:00']).toEqual({ excluded: true });
  });
});

// Two occurrences can still meet on one key - an hourly series turned
// all-day puts every hour of a day on that day. One override is kept, the
// first; none overwrites another.
describe('overrides that would meet on one occurrence', () => {
  it('keeps the first and leaves out the others instead of overwriting it', () => {
    const master = {
      ...series('1.0'), start: '2026-12-07T10:00:00', utcStart: '2026-12-07T09:00:00Z', utcEnd: '2026-12-07T10:00:00Z',
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'hourly', count: 3 }],
      recurrenceOverrides: {
        '2026-12-07T10:00:00': { title: 'First hour' },
        '2026-12-07T11:00:00': { title: 'Second hour' },
        '2026-12-07T12:00:00': { excluded: true },
      },
    } as unknown as CalendarEvent;
    const occurrence = {
      ...master, id: 'maaaaag', baseEventId: 'b', start: '2026-12-07T11:00:00', recurrenceId: '2026-12-07T11:00:00',
      utcStart: '2026-12-07T10:00:00Z', utcEnd: '2026-12-07T11:00:00Z',
    } as CalendarEvent;
    const day = startOfDay(getEventStartDate(occurrence));

    const updates = seriesUpdatesFromOccurrence(
      occurrence, master,
      editorUpdates(occurrence, { start: '2026-12-07T00:00:00', duration: 'P1D', timeZone: null, showWithoutTime: true }),
      editorOn(occurrence, { when: { allDay: true, start: day, end: day } }), context,
    );

    expect(updates.recurrenceOverrides).toEqual({ '2026-12-07T00:00:00': { title: 'First hour' } });
  });
});

// "Repeat: none" for every occurrence makes the series one event. Its start
// is an occurrence of any rule, so the first occurrence's override stayed on
// the single event: cancelled, 1.0 left the event out of every range query
// (still stored); retitled, 0.16.23 listed it twice (live).
describe.each<[string, Version]>([['1.0', '1.0'], ['0.16', '0.16']])('a series made one event on Stalwart %s', (_label, version) => {
  it('keeps none of its overrides', () => {
    const first = version === '1.0'
      ? { excluded: true }
      : { start: '2026-10-05T10:00:00', duration: 'PT1H', title: 'Kick-off', participants: series(version).participants };
    const master = { ...series(version), recurrenceOverrides: { ...series(version).recurrenceOverrides, '2026-10-05T10:00:00': first } } as CalendarEvent;
    const occurrence = serverOccurrence(version);

    const updates = seriesUpdatesFromOccurrence(
      occurrence, master,
      // What the editor writes for "Does not repeat" on a series.
      editorUpdates(occurrence, { recurrenceRules: null, recurrenceOverrides: null, excludedRecurrenceRules: null }),
      editorOn(occurrence, { ruleChanged: true }), context,
    );

    expect(updates.recurrenceRules).toBeNull();
    expect(updates.recurrenceOverrides).toBeNull();
  });
});
