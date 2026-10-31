import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../../api/types';
import { expandRecurringEvents } from '../recurrence-expansion';

// Daily expansion advanced a Date across the device's DST gap and kept the
// shifted time (02:30 became 03:30, midnight became 01:00); the implicit
// byHour then rejected every later day, so the series ended at the gap.

function daily(start: string, allDay: boolean, timeZone?: string): CalendarEvent {
  return {
    id: 'E1', uid: 'u1', title: 'Daily', calendarIds: { c: true },
    start, duration: allDay ? 'P1D' : 'PT30M', showWithoutTime: allDay,
    ...(timeZone ? { timeZone } : {}),
    recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'daily' }],
  } as unknown as CalendarEvent;
}

let originalTZ: string | undefined;
beforeEach(() => {
  originalTZ = process.env.TZ;
});
afterEach(() => {
  process.env.TZ = originalTZ;
});

describe('daily recurrence across a DST gap', () => {
  it('keeps a 02:30 series going past the spring-forward night (Berlin)', () => {
    process.env.TZ = 'Europe/Berlin';
    const out = expandRecurringEvents([daily('2026-03-01T02:30:00', false, 'Europe/Berlin')], '2026-03-01T00:00:00', '2026-04-01T00:00:00');
    expect(out).toHaveLength(31);
    expect(out.at(-1)!.start.slice(0, 16)).toBe('2026-03-31T02:30');
  });

  it('keeps an all-day series going after a midnight gap (Santiago)', () => {
    process.env.TZ = 'America/Santiago';
    const out = expandRecurringEvents([daily('2026-08-20T00:00:00', true)], '2026-09-07T00:00:00', '2026-09-14T00:00:00');
    expect(out).toHaveLength(7);
    expect(out.map((o) => o.start.slice(11, 16))).toEqual(Array(7).fill('00:00'));
  });
});

describe("a daily series in another zone on the device's DST day", () => {
  // Berlin skips 02:00-03:00 on 28 March 2027; New York changed on 14 March.
  it("keeps the series' 02:30 as recurrence id and time on the night the device skips it", () => {
    process.env.TZ = 'Europe/Berlin';
    const out = expandRecurringEvents(
      [daily('2027-03-20T02:30:00', false, 'America/New_York')],
      '2027-03-27T00:00:00', '2027-03-30T00:00:00',
    );
    const day = out.find((o) => o.recurrenceId?.startsWith('2027-03-28'));
    expect(day?.recurrenceId).toBe('2027-03-28T02:30:00');
    expect(day?.start).toBe('2027-03-28T02:30:00');
    expect(day?.id).toBe('E1:2027-03-28T02:30:00');
    // 02:30 in New York (EDT, -4) is 06:30 UTC.
    expect(day?.utcStart).toBe('2027-03-28T06:30:00.000Z');
    expect(out.map((o) => o.recurrenceId)).toEqual([
      '2027-03-27T02:30:00', '2027-03-28T02:30:00', '2027-03-29T02:30:00',
    ]);
  });

  it('applies the override stored for that night', () => {
    process.env.TZ = 'Europe/Berlin';
    const event = {
      ...daily('2027-03-20T02:30:00', false, 'America/New_York'),
      recurrenceOverrides: { '2027-03-28T02:30:00': { title: 'Moved' } },
    } as CalendarEvent;
    const out = expandRecurringEvents([event], '2027-03-28T00:00:00', '2027-03-29T00:00:00');
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Moved');
  });

  it('gives the same occurrences whichever zone the device is in', () => {
    const run = (tz: string) => {
      process.env.TZ = tz;
      return expandRecurringEvents(
        [daily('2027-03-10T02:30:00', false, 'America/New_York')],
        '2027-03-10T00:00:00', '2027-04-01T00:00:00',
      ).map((o) => [o.recurrenceId, o.utcStart]);
    };
    expect(run('Europe/Berlin')).toEqual(run('America/New_York'));
  });
});
