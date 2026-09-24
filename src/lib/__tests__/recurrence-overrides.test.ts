import { describe, it, expect } from 'vitest';
import type { CalendarEvent } from '../../api/types';
import {
  buildAllScopeUpdates,
  buildFutureSeriesData,
  isRecurringSeriesMember,
  truncateRecurrenceRules,
} from '../recurrence-overrides';

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
