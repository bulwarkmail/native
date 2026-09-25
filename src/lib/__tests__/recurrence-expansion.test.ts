import { describe, it, expect } from 'vitest';
import { parseISO } from 'date-fns';
import { expandRecurringEvents } from '../recurrence-expansion';
import { computeFireTime } from '../calendar-alert-scheduler';
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

describe('expandRecurringEvents - daily', () => {
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

describe('expandRecurringEvents - weekly', () => {
  it('expands a weekly rule on specific byDay values', () => {
    // April 6, 2026 is a Monday - expand Mon/Wed for two weeks.
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

describe('expandRecurringEvents - interval > 1 (#13)', () => {
  it('expands an every-5-weeks rule', () => {
    const rule: RecurrenceRule = { frequency: 'weekly', interval: 5 };
    const result = expandRecurringEvents(
      [ev({ recurrenceRules: [rule] })], // starts Mon 2026-04-06
      '2026-04-01T00:00:00',
      '2026-08-01T00:00:00',
    );
    expect(result.map((e) => e.start)).toEqual([
      '2026-04-06T09:00:00',
      '2026-05-11T09:00:00',
      '2026-06-15T09:00:00',
      '2026-07-20T09:00:00',
    ]);
  });

  it('expands an every-5-weeks series started long before the visible range', () => {
    const event = ev({
      start: '2025-01-06T09:00:00', // Monday
      recurrenceRules: [{ frequency: 'weekly', interval: 5 }],
    });
    // Occurrences fall every 35 days from 2025-01-06 (…2026-04-06, 05-11,
    // 06-15, 07-20…) — only those inside the window are returned.
    const result = expandRecurringEvents([event], '2026-05-01T00:00:00', '2026-08-01T00:00:00');
    expect(result.map((e) => e.start)).toEqual([
      '2026-05-11T09:00:00',
      '2026-06-15T09:00:00',
      '2026-07-20T09:00:00',
    ]);
  });

  it('expands an every-2-months rule', () => {
    const rule: RecurrenceRule = { frequency: 'monthly', interval: 2 };
    const result = expandRecurringEvents(
      [ev({ recurrenceRules: [rule] })],
      '2026-04-01T00:00:00',
      '2026-12-31T00:00:00',
    );
    expect(result.map((e) => e.start)).toEqual([
      '2026-04-06T09:00:00',
      '2026-06-06T09:00:00',
      '2026-08-06T09:00:00',
      '2026-10-06T09:00:00',
      '2026-12-06T09:00:00',
    ]);
  });
});

describe('expandRecurringEvents - monthly', () => {
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

describe('expandRecurringEvents - overrides', () => {
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

describe('expandRecurringEvents - non-recurring passthrough', () => {
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

describe('expandRecurringEvents - range filtering', () => {
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

describe('expandRecurringEvents - excludedRecurrenceRules', () => {
  it('removes occurrences generated by excluded rules', () => {
    const event = ev({
      start: '2025-01-06T09:00:00',
      recurrenceRules: [{ frequency: 'daily' }],
      excludedRecurrenceRules: [{
        frequency: 'weekly',
        byDay: [{ day: 'tu' }],
      }],
    });
    // Jan 6-12 2025: Mon-Sun, Tuesday Jan 7 excluded
    const result = expandRecurringEvents([event], '2025-01-06T00:00:00', '2025-01-13T00:00:00');
    const days = result.map((e) => e.start.substring(0, 10));
    expect(days).not.toContain('2025-01-07');
    expect(days).toContain('2025-01-06');
    expect(days).toContain('2025-01-08');
    expect(result).toHaveLength(6);
  });
});

describe('expandRecurringEvents - long-running series', () => {
  it('expands a daily series started years before the visible range', () => {
    const event = ev({
      start: '2022-01-03T09:00:00',
      recurrenceRules: [{ frequency: 'daily' }],
    });
    const result = expandRecurringEvents([event], '2025-06-02T00:00:00', '2025-06-05T00:00:00');
    expect(result.map((e) => e.start)).toEqual([
      '2025-06-02T09:00:00',
      '2025-06-03T09:00:00',
      '2025-06-04T09:00:00',
    ]);
  });

  it('expands a weekly series started years before the visible range', () => {
    const event = ev({
      start: '2020-01-06T09:00:00', // Monday
      recurrenceRules: [{ frequency: 'weekly' }],
    });
    const result = expandRecurringEvents([event], '2025-06-01T00:00:00', '2025-06-30T00:00:00');
    const days = result.map((e) => e.start.substring(0, 10));
    expect(days).toEqual(['2025-06-02', '2025-06-09', '2025-06-16', '2025-06-23']);
  });

  it('still respects count for old series (no fast-forward shortcut)', () => {
    const event = ev({
      start: '2025-01-06T09:00:00',
      recurrenceRules: [{ frequency: 'daily', count: 5 }],
    });
    // Range far after the 5 occurrences ran out
    const result = expandRecurringEvents([event], '2025-06-01T00:00:00', '2025-06-30T00:00:00');
    expect(result).toHaveLength(0);
  });
});

describe('expandRecurringEvents - event timezone DST handling', () => {
  it('keeps wall time across a DST transition in the event timezone', () => {
    // America/New_York: EST (UTC-5) until 2025-03-09, EDT (UTC-4) after
    const event = ev({
      start: '2025-03-03T10:00:00',
      timeZone: 'America/New_York',
      utcStart: '2025-03-03T15:00:00Z',
      utcEnd: '2025-03-03T16:00:00Z',
      recurrenceRules: [{ frequency: 'weekly' }],
    });
    const result = expandRecurringEvents([event], '2025-03-03T00:00:00', '2025-03-17T00:00:00');
    const utcStarts = result.map((e) => e.utcStart);
    expect(utcStarts[0]).toBe('2025-03-03T15:00:00.000Z'); // EST: 10:00 -5
    expect(utcStarts[1]).toBe('2025-03-10T14:00:00.000Z'); // EDT: 10:00 -4
    const utcEnds = result.map((e) => e.utcEnd);
    expect(utcEnds[1]).toBe('2025-03-10T15:00:00.000Z');
  });
});

// Overrides as Stalwart 1.0 returns them - RFC 8984 PatchObjects with keys
// like participants/<id>/participationStatus and nulls that remove - and
// moved or resized occurrences. The expansion used to spread an override
// onto the occurrence, so pointer keys became junk properties, a declined
// occurrence stayed accepted, and a moved one kept the time, length and
// place in the range the rule gave it.
describe('expandRecurringEvents - override patches', () => {
  // A daily 09:00-10:00 in Berlin (UTC+1 in January).
  const berlinDaily = (recurrenceOverrides: CalendarEvent['recurrenceOverrides']) => ev({
    start: '2025-01-06T09:00:00',
    timeZone: 'Europe/Berlin',
    utcStart: '2025-01-06T08:00:00Z',
    utcEnd: '2025-01-06T09:00:00Z',
    recurrenceRules: [{ frequency: 'daily' }],
    recurrenceOverrides,
  });

  it('places a moved occurrence at its own start, in its time zone', () => {
    const result = expandRecurringEvents(
      [berlinDaily({ '2025-01-07T09:00:00': { start: '2025-01-07T14:30:00' } })],
      '2025-01-06T00:00:00', '2025-01-09T00:00:00',
    );
    const moved = result.find((e) => e.recurrenceId === '2025-01-07T09:00:00')!;
    expect(moved.start).toBe('2025-01-07T14:30:00');
    expect(moved.utcStart).toBe('2025-01-07T13:30:00.000Z');
    expect(moved.utcEnd).toBe('2025-01-07T14:30:00.000Z');
  });

  it('gives a resized occurrence its own length', () => {
    const result = expandRecurringEvents(
      [berlinDaily({ '2025-01-07T09:00:00': { duration: 'PT2H30M' } })],
      '2025-01-06T00:00:00', '2025-01-09T00:00:00',
    );
    const resized = result.find((e) => e.recurrenceId === '2025-01-07T09:00:00')!;
    expect(resized.utcStart).toBe('2025-01-07T08:00:00.000Z');
    expect(resized.utcEnd).toBe('2025-01-07T10:30:00.000Z');
  });

  it('shows an occurrence moved into the range from outside it', () => {
    const result = expandRecurringEvents(
      [berlinDaily({ '2025-01-12T09:00:00': { start: '2025-01-08T15:00:00' } })],
      '2025-01-06T00:00:00', '2025-01-10T00:00:00',
    );
    expect(result.map((e) => e.recurrenceId)).toEqual([
      '2025-01-06T09:00:00', '2025-01-07T09:00:00', '2025-01-08T09:00:00', '2025-01-09T09:00:00',
      '2025-01-12T09:00:00',
    ]);
    expect(result[4]).toMatchObject({ start: '2025-01-08T15:00:00', utcStart: '2025-01-08T14:00:00.000Z' });
  });

  it('times occurrences from the duration when the master\'s instants do not parse (seen on 0.16.23)', () => {
    // 0.16.23 answered utcStart/utcEnd of a counted daily series' master with
    // the year 32548.
    const master = berlinDaily({ '2025-01-07T09:00:00': { start: '2025-01-07T14:30:00' } });
    master.utcStart = '32548-12-04T15:30:07Z';
    master.utcEnd = '32548-12-04T15:30:07Z';

    const result = expandRecurringEvents([master], '2025-01-06T00:00:00', '2025-01-09T00:00:00');

    expect(result.map((e) => [e.recurrenceId, e.utcStart, e.utcEnd])).toEqual([
      ['2025-01-06T09:00:00', '2025-01-06T08:00:00.000Z', '2025-01-06T09:00:00.000Z'],
      ['2025-01-07T09:00:00', '2025-01-07T13:30:00.000Z', '2025-01-07T14:30:00.000Z'],
      ['2025-01-08T09:00:00', '2025-01-08T08:00:00.000Z', '2025-01-08T09:00:00.000Z'],
    ]);
  });

  it('leaves out an occurrence moved out of the range', () => {
    const result = expandRecurringEvents(
      [berlinDaily({ '2025-01-07T09:00:00': { start: '2025-01-20T09:00:00' } })],
      '2025-01-06T00:00:00', '2025-01-09T00:00:00',
    );
    expect(result.map((e) => e.recurrenceId)).toEqual(['2025-01-06T09:00:00', '2025-01-08T09:00:00']);
  });

  it('applies an override returned as a PatchObject on Stalwart 1.0', () => {
    const event = berlinDaily({
      '2025-01-07T09:00:00': {
        'participants/att/participationStatus': 'declined',
        'locations/l1/name': 'Room B',
        description: null,
      } as unknown as Partial<CalendarEvent>,
    });
    event.description = 'Agenda';
    event.locations = { l1: { '@type': 'Location', name: 'Room A' } } as CalendarEvent['locations'];
    event.participants = {
      org: { '@type': 'Participant', calendarAddress: 'mailto:a@example.org', participationStatus: 'accepted' },
      att: { '@type': 'Participant', calendarAddress: 'mailto:b@example.org', participationStatus: 'needs-action' },
    } as unknown as CalendarEvent['participants'];

    const result = expandRecurringEvents([event], '2025-01-06T00:00:00', '2025-01-09T00:00:00');

    const answered = result.find((e) => e.recurrenceId === '2025-01-07T09:00:00')!;
    expect(answered.participants?.att.participationStatus).toBe('declined');
    expect(answered.participants?.org.participationStatus).toBe('accepted');
    expect(answered.locations?.l1.name).toBe('Room B');
    expect(answered).not.toHaveProperty('description');
    // No pointer keys left on the occurrence as junk properties.
    expect(Object.keys(answered).filter((k) => k.includes('/'))).toEqual([]);
    // The other occurrences keep the series' values.
    expect(result[0].participants?.att.participationStatus).toBe('needs-action');
    expect(result[0].locations?.l1.name).toBe('Room A');
  });
});

// The master's utcStart/utcEnd place its first occurrence. An occurrence the
// device expands carries the instants worked out for it, or none, never the
// master's: kept, they put every later occurrence's reminders on the first
// one's date, where they are in the past and never scheduled.
describe('expandRecurringEvents - the master\'s instants', () => {
  const fifteenHoursBefore = { '@type': 'OffsetTrigger', offset: '-PT15H', relativeTo: 'start' };

  it('gives all-day occurrences no instants, so their reminders go off before each day (0.16.23 and 1.0)', () => {
    // A yearly birthday, as both servers return the master in Berlin.
    const birthday = ev({
      id: 'bday', start: '2024-11-02T00:00:00', showWithoutTime: true, duration: 'P1D', timeZone: null,
      utcStart: '2024-11-01T23:00:00Z', utcEnd: '2024-11-02T23:00:00Z',
      recurrenceRules: [{ frequency: 'yearly' }],
    });

    const [occurrence] = expandRecurringEvents([birthday], '2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z');

    expect(occurrence.start).toBe('2026-11-02T00:00:00');
    expect(occurrence).not.toHaveProperty('utcStart');
    expect(occurrence).not.toHaveProperty('utcEnd');
    expect(computeFireTime(occurrence, fifteenHoursBefore)).toBe(parseISO('2026-11-02T00:00:00').getTime() - 15 * 3600_000);
  });

  it('gives floating occurrences no instants when the master\'s are 0.16.23\'s year 32548', () => {
    const standup = ev({
      id: 'fl', start: '2026-10-05T09:00:00', duration: 'PT1H', timeZone: null,
      utcStart: '32548-12-04T15:30:07Z', utcEnd: '32548-12-04T15:30:07Z',
      recurrenceRules: [{ frequency: 'daily', count: 3 }],
    });

    const result = expandRecurringEvents([standup], '2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z');

    expect(result.map((e) => e.start)).toEqual(['2026-10-05T09:00:00', '2026-10-06T09:00:00', '2026-10-07T09:00:00']);
    for (const occurrence of result) {
      expect(occurrence).not.toHaveProperty('utcStart');
      expect(occurrence).not.toHaveProperty('utcEnd');
    }
  });

  it('gives floating occurrences no instants when the master\'s are the next occurrence\'s (0.16.23)', () => {
    // Once the first occurrence is overridden, 0.16.23 answers the master's
    // utcStart/utcEnd with the next plain occurrence's.
    const standup = ev({
      id: 'fl', start: '2026-10-05T09:00:00', duration: 'PT1H', timeZone: null,
      utcStart: '2026-10-06T07:00:00Z', utcEnd: '2026-10-06T08:00:00Z',
      recurrenceRules: [{ frequency: 'daily', count: 3 }],
      recurrenceOverrides: { '2026-10-05T09:00:00': { title: 'Kick-off' } },
    });

    const result = expandRecurringEvents([standup], '2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z');

    expect(result.map((e) => [e.start, e.utcStart])).toEqual([
      ['2026-10-05T09:00:00', undefined],
      ['2026-10-06T09:00:00', undefined],
      ['2026-10-07T09:00:00', undefined],
    ]);
  });

  it('carries the master\'s offset to floating occurrences when its instants are its own (1.0)', () => {
    // A floating 09:00 read in Berlin summer time: 07:00Z.
    const standup = ev({
      id: 'fl', start: '2026-10-05T09:00:00', duration: 'PT1H', timeZone: null,
      utcStart: '2026-10-05T07:00:00Z', utcEnd: '2026-10-05T08:00:00Z',
      recurrenceRules: [{ frequency: 'daily', count: 2 }],
    });

    const result = expandRecurringEvents([standup], '2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z');

    expect(result.map((e) => [e.utcStart, e.utcEnd])).toEqual([
      ['2026-10-05T07:00:00.000Z', '2026-10-05T08:00:00.000Z'],
      ['2026-10-06T07:00:00.000Z', '2026-10-06T08:00:00.000Z'],
    ]);
  });

  it('times zoned occurrences from the duration when the master\'s instants are another occurrence\'s (0.16.23)', () => {
    const standup = ev({
      id: 'tz', start: '2026-10-05T09:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin',
      utcStart: '2026-10-06T07:00:00Z', utcEnd: '2026-10-06T08:30:00Z',
      recurrenceRules: [{ frequency: 'daily', count: 2 }],
    });

    const result = expandRecurringEvents([standup], '2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z');

    expect(result.map((e) => [e.utcStart, e.utcEnd])).toEqual([
      ['2026-10-05T07:00:00.000Z', '2026-10-05T08:00:00.000Z'],
      ['2026-10-06T07:00:00.000Z', '2026-10-06T08:00:00.000Z'],
    ]);
  });
});
