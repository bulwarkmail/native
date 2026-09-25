import { describe, it, expect } from 'vitest';
import type { CalendarEvent } from '../../api/types';
import {
  buildAllScopeEdit,
  buildAllScopeUpdates,
  buildFutureSeriesData,
  buildFutureSeriesEdit,
  isRecurringSeriesMember,
  truncateRecurrenceRules,
} from '../recurrence-overrides';
import { seedAttendees } from '../calendar-participants';

const master: CalendarEvent = {
  id: 'ev-1',
  uid: 'uid-1',
  calendarIds: { 'cal-1': true },
  title: 'Standup',
  start: '2026-03-02T09:00:00',
  duration: 'PT30M',
  timeZone: 'Europe/Berlin',
  recurrenceRules: [{ frequency: 'daily', interval: 1, count: 10 }],
};

const occurrence: CalendarEvent = {
  ...master,
  id: 'ev-1:2026-03-04T08:00:00.000Z',
  originalId: 'ev-1',
  start: '2026-03-04T09:00:00',
  recurrenceId: '2026-03-04T08:00:00.000Z',
};

describe('isRecurringSeriesMember', () => {
  it('detects masters and expanded occurrences but not plain shared events', () => {
    expect(isRecurringSeriesMember(master)).toBe(true);
    expect(isRecurringSeriesMember(occurrence)).toBe(true);
    expect(isRecurringSeriesMember({ recurrenceRules: [] })).toBe(false);
    expect(isRecurringSeriesMember({ originalId: 'raw' } as CalendarEvent)).toBe(false);
  });
});

describe('truncateRecurrenceRules', () => {
  it('ends the rule one second before the occurrence slot and drops count', () => {
    const rules = truncateRecurrenceRules(master.recurrenceRules, occurrence);
    expect(rules).toHaveLength(1);
    expect(rules[0].count).toBeUndefined();
    // recurrenceId is the UTC instant; until is local wall-clock, one second earlier.
    const expected = new Date('2026-03-04T08:00:00.000Z');
    expected.setSeconds(expected.getSeconds() - 1);
    const pad = (n: number) => String(n).padStart(2, '0');
    const local =
      `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())}` +
      `T${pad(expected.getHours())}:${pad(expected.getMinutes())}:${pad(expected.getSeconds())}`;
    expect(rules[0].until).toBe(local);
    expect(rules[0].frequency).toBe('daily');
  });

  it('treats an all-day recurrenceId as a local date', () => {
    const rules = truncateRecurrenceRules(
      [{ frequency: 'weekly' }],
      { recurrenceId: '2026-03-04', start: '2026-03-04T00:00:00' },
    );
    expect(rules[0].until).toBe('2026-03-03T23:59:59');
  });
});

describe('buildAllScopeUpdates', () => {
  it('drops an unchanged occurrence start so the master is not moved', () => {
    const out = buildAllScopeUpdates(
      { title: 'Renamed', start: '2026-03-04T09:00:00', recurrenceId: 'x' },
      occurrence,
      master,
    );
    expect(out).toEqual({ title: 'Renamed' });
  });

  it('applies the delta of a moved occurrence to the master start', () => {
    const out = buildAllScopeUpdates(
      { start: '2026-03-04T10:30:00' },
      occurrence,
      master,
    );
    expect(out.start).toBe('2026-03-02T10:30:00');
  });

  it('keeps start when editing the master itself', () => {
    const out = buildAllScopeUpdates({ start: '2026-03-05T09:00:00' }, master, master);
    expect(out.start).toBe('2026-03-05T09:00:00');
  });
});

describe('buildFutureSeriesData', () => {
  it('clones the master with the original rules, edits on top and the occurrence start', () => {
    const data = buildFutureSeriesData(
      master,
      master.recurrenceRules ?? null,
      occurrence,
      { title: 'New title' },
    );
    expect(data.title).toBe('New title');
    expect(data.start).toBe('2026-03-04T09:00:00');
    expect(data.recurrenceRules).toEqual(master.recurrenceRules);
    expect(data.duration).toBe('PT30M');
    expect(data.timeZone).toBe('Europe/Berlin');
    expect('id' in data).toBe(false);
    expect('uid' in data).toBe(false);
    expect('recurrenceId' in data).toBe(false);
  });

  it('prefers a start the user moved', () => {
    const data = buildFutureSeriesData(master, null, occurrence, { start: '2026-03-04T11:00:00' });
    expect(data.start).toBe('2026-03-04T11:00:00');
    expect('recurrenceRules' in data).toBe(false);
  });
});

describe('series edits from an occurrence the user organizes', () => {
  const participants = {
    p0: { calendarAddress: 'mailto:me@example.com', roles: { owner: true }, participationStatus: 'accepted' },
    p1: { calendarAddress: 'mailto:bob@example.com', roles: { attendee: true }, participationStatus: 'accepted' },
  } as CalendarEvent['participants'];
  const series: CalendarEvent = { ...master, organizerCalendarAddress: 'mailto:me@example.com', participants };
  // The fourth occurrence, stretched to an hour, which Bob declined.
  const fourth: CalendarEvent = {
    ...series,
    id: 'ev-1:2026-03-05T09:00:00',
    start: '2026-03-05T09:00:00',
    duration: 'PT1H',
    recurrenceId: '2026-03-05T09:00:00',
    participants: { ...participants, p1: { ...participants!.p1, participationStatus: 'declined' } },
  };
  const me = { userEmail: 'me@example.com', userEmails: ['me@example.com'] };
  // What the editor saves for an unchanged form: the occurrence's own times,
  // the rule written back and the occurrence's participants.
  const formSave = {
    title: 'Standup (moved room)',
    start: fourth.start,
    duration: fourth.duration,
    timeZone: fourth.timeZone,
    showWithoutTime: false,
    recurrenceRules: [{ frequency: 'daily', interval: 1, count: 10 }],
    participants: fourth.participants,
  } as Partial<CalendarEvent>;
  const attendees = seedAttendees(fourth, ['me@example.com']);

  it('changes only what the user changed when nothing moved (all occurrences)', () => {
    const update = buildAllScopeEdit(formSave, fourth, series, { attendees, timesMoved: false, ruleChanged: false }, me);

    // Not the fourth's length, rule rewrite or participants (Bob's decline).
    expect(update).toEqual({ title: 'Standup (moved room)' });
  });

  it('moves the series by the occurrence\'s delta and asks its attendees again (all occurrences)', () => {
    const moved = { ...formSave, start: '2026-03-05T10:00:00' };

    const update = buildAllScopeEdit(moved, fourth, series, { attendees, timesMoved: true, ruleChanged: false }, me);

    expect(update.start).toBe('2026-03-02T10:00:00');
    const statuses = Object.values(update.participants ?? {}).map((p) => [p.calendarAddress, p.participationStatus]);
    expect(statuses).toEqual([['mailto:me@example.com', 'accepted'], ['mailto:bob@example.com', 'needs-action']]);
  });

  it('asks every attendee of the new series again (this and following)', () => {
    const data = buildFutureSeriesEdit(series, series.recurrenceRules!, fourth, formSave, ['me@example.com']);

    const statuses = Object.values(data.participants ?? {}).map((p) => p.participationStatus);
    expect(statuses).toEqual(['accepted', 'needs-action']);
  });

  it('leaves the answers of a series someone else organizes alone (this and following)', () => {
    const invitation = { ...series, organizerCalendarAddress: 'mailto:boss@example.com', participants: {
      ...participants, p0: { ...participants!.p0, calendarAddress: 'mailto:boss@example.com' },
    } } as CalendarEvent;

    const data = buildFutureSeriesEdit(invitation, invitation.recurrenceRules!, fourth, {}, ['me@example.com']);

    expect(Object.values(data.participants ?? {}).map((p) => p.participationStatus)).toEqual(['accepted', 'accepted']);
  });

  it('keeps writing the times when the flags are not given', () => {
    expect(buildAllScopeUpdates({ start: '2026-03-05T09:00:00', duration: 'PT1H' }, fourth, series))
      .toEqual({ duration: 'PT1H' });
  });
});
