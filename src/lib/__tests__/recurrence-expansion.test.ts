import { describe, it, expect } from 'vitest';
import { expandRecurringEvents } from '../recurrence-expansion';
import type { CalendarEvent, RecurrenceRule } from '../../api/types';

function ev(partial: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'master',
    uid: 'uid-1',
    title: 'Recurring',
    start: '2026-04-06T09:00:00',
    duration: 'PT1H',
    calendarIds: { 'cal-1': true },
    ...partial,
  } as CalendarEvent;
}

describe('expandRecurringEvents — daily', () => {
  it('expands a daily rule with count', () => {
    const rule: RecurrenceRule = { frequency: 'daily', count: 3 };
    const result = expandRecurringEvents(
      [ev({ recurrenceRules: [rule] })],
      '2026-04-01T00:00:00',
      '2026-04-30T00:00:00',
    );
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.start)).toEqual([
      '2026-04-06T09:00:00',
      '2026-04-07T09:00:00',
      '2026-04-08T09:00:00',
    ]);
    // synthetic id includes recurrenceId
    expect(result[1].id).toBe('master:2026-04-07T09:00:00');
    // originalId points back to master event id
    expect(result[1].originalId).toBe('master');
  });

  it('respects until and stays within range', () => {
    const rule: RecurrenceRule = {
      frequency: 'daily',
      until: '2026-04-08T09:00:00',
    };
    const result = expandRecurringEvents(
      [ev({ recurrenceRules: [rule] })],
      '2026-04-01T00:00:00',
      '2026-04-30T00:00:00',
    );
    expect(result.map((e) => e.start)).toEqual([
      '2026-04-06T09:00:00',
      '2026-04-07T09:00:00',
      '2026-04-08T09:00:00',
    ]);
  });
});

describe('expandRecurringEvents — weekly', () => {
  it('expands a weekly rule on specific byDay values', () => {
    // April 6, 2026 is a Monday — expand Mon/Wed for two weeks.
    const rule: RecurrenceRule = {
      frequency: 'weekly',
      byDay: [{ day: 'mo' }, { day: 'we' }],
      count: 4,
    };
    const result = expandRecurringEvents(
      [ev({ recurrenceRules: [rule] })],
      '2026-04-01T00:00:00',
      '2026-04-30T00:00:00',
    );
    expect(result.map((e) => e.start)).toEqual([
      '2026-04-06T09:00:00', // Mon
      '2026-04-08T09:00:00', // Wed
      '2026-04-13T09:00:00', // Mon
      '2026-04-15T09:00:00', // Wed
    ]);
  });
});

describe('expandRecurringEvents — monthly', () => {
  it('expands monthly on the 6th', () => {
    const rule: RecurrenceRule = { frequency: 'monthly', count: 3 };
    const result = expandRecurringEvents(
      [ev({ recurrenceRules: [rule] })],
      '2026-04-01T00:00:00',
      '2026-12-31T00:00:00',
    );
    expect(result.map((e) => e.start)).toEqual([
      '2026-04-06T09:00:00',
      '2026-05-06T09:00:00',
      '2026-06-06T09:00:00',
    ]);
  });

  it('expands monthly second Wednesday using byDay nthOfPeriod', () => {
    const rule: RecurrenceRule = {
      frequency: 'monthly',
      byDay: [{ day: 'we', nthOfPeriod: 2 }],
      count: 2,
    };
    const result = expandRecurringEvents(
      [ev({ start: '2026-04-08T09:00:00', recurrenceRules: [rule] })],
      '2026-04-01T00:00:00',
      '2026-12-31T00:00:00',
    );
    // 2nd Wednesday of April is the 8th, May is the 13th
    expect(result.map((e) => e.start)).toEqual([
      '2026-04-08T09:00:00',
      '2026-05-13T09:00:00',
    ]);
  });
});

describe('expandRecurringEvents — overrides', () => {
  it('skips occurrences marked excluded', () => {
    const rule: RecurrenceRule = { frequency: 'daily', count: 3 };
    const event = ev({
      recurrenceRules: [rule],
      recurrenceOverrides: {
        '2026-04-07T09:00:00': { excluded: true } as any,
      },
    });
    const result = expandRecurringEvents(
      [event],
      '2026-04-01T00:00:00',
      '2026-04-30T00:00:00',
    );
    expect(result.map((e) => e.start)).toEqual([
      '2026-04-06T09:00:00',
      '2026-04-08T09:00:00',
    ]);
  });

  it('applies field overrides to a specific occurrence', () => {
    const rule: RecurrenceRule = { frequency: 'daily', count: 2 };
    const event = ev({
      recurrenceRules: [rule],
      recurrenceOverrides: {
        '2026-04-07T09:00:00': { title: 'Special' } as any,
      },
    });
    const result = expandRecurringEvents(
      [event],
      '2026-04-01T00:00:00',
      '2026-04-30T00:00:00',
    );
    expect(result[0].title).toBe('Recurring');
    expect(result[1].title).toBe('Special');
  });
});

describe('expandRecurringEvents — non-recurring passthrough', () => {
  it('returns non-recurring events unchanged', () => {
    const single = ev({ id: 'one', recurrenceRules: undefined });
    const result = expandRecurringEvents(
      [single],
      '2026-04-01T00:00:00',
      '2026-04-30T00:00:00',
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('one');
  });
});

describe('expandRecurringEvents — range filtering', () => {
  it('returns occurrences only within the requested window', () => {
    const rule: RecurrenceRule = { frequency: 'daily', count: 30 };
    const result = expandRecurringEvents(
      [ev({ recurrenceRules: [rule] })],
      '2026-04-10T00:00:00',
      '2026-04-13T00:00:00',
    );
    expect(result.map((e) => e.start)).toEqual([
      '2026-04-10T09:00:00',
      '2026-04-11T09:00:00',
      '2026-04-12T09:00:00',
    ]);
  });
});
