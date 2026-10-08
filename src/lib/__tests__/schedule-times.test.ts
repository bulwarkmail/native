import { describe, it, expect } from 'vitest';
import { schedulePresetTimes, tomorrowMorning, withPickedDayIn, withPickedTimeIn } from '../schedule-times';

describe('schedule times in the app zone', () => {
  // 23:30 on the 30th in UTC; already 08:30 on the 31st in Tokyo; 19:30 on
  // the 30th in New York.
  const now = new Date('2026-05-30T23:30:00Z');

  it('puts "Tomorrow morning" at 08:00 in the zone', () => {
    expect(tomorrowMorning(now, 'UTC').toISOString()).toBe('2026-05-31T08:00:00.000Z');
    expect(tomorrowMorning(now, 'Asia/Tokyo').toISOString()).toBe('2026-05-31T23:00:00.000Z');
    expect(tomorrowMorning(now, 'America/New_York').toISOString()).toBe('2026-05-31T12:00:00.000Z');
  });

  it('keeps 08:00 across a DST change', () => {
    // Berlin goes to CEST overnight: 08:00 is 06:00 UTC, not 07:00.
    expect(tomorrowMorning(new Date('2026-03-28T20:00:00Z'), 'Europe/Berlin').toISOString())
      .toBe('2026-03-29T06:00:00.000Z');
  });

  it('offers the hour presets as offsets', () => {
    const p = schedulePresetTimes(now, 'Asia/Tokyo');
    expect(p.in1h.toISOString()).toBe('2026-05-31T00:30:00.000Z');
    expect(p.in3h.toISOString()).toBe('2026-05-31T02:30:00.000Z');
    expect(p.tomorrowMorning.toISOString()).toBe('2026-05-31T23:00:00.000Z');
  });

  it('combines a picked day and time on the zone\'s clock', () => {
    const base = new Date('2026-05-31T00:30:00Z'); // 09:30 on 31 May in Tokyo
    // The picker hands back 3 June in Tokyo (at whatever time).
    const day = withPickedDayIn(base, new Date('2026-06-03T02:00:00Z'), 'Asia/Tokyo');
    expect(day.toISOString()).toBe('2026-06-03T00:30:00.000Z');
    // Then 14:05 in Tokyo.
    const time = withPickedTimeIn(day, new Date('2026-06-03T05:05:42Z'), 'Asia/Tokyo');
    expect(time.toISOString()).toBe('2026-06-03T05:05:00.000Z');
  });
});
