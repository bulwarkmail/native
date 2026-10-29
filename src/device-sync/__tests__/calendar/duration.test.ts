import { describe, expect, it } from 'vitest';
import {
  addDuration,
  durationBetween,
  durationTextSeconds,
  formatAospDuration,
  formatJsDuration,
  formatJsDurationSeconds,
  parseDuration,
  sameDurationLength,
} from '../../calendar/duration';
import { aospDurationValid } from '../fakes/fake-provider';
import { localToUtc } from '../../calendar/zoned-time';

describe('calendar/duration', () => {
  it('parses JSCalendar, iCalendar and AOSP durations', () => {
    expect(parseDuration('PT1H30M')).toEqual({ negative: false, days: 0, seconds: 5400 });
    expect(parseDuration('P1W')).toEqual({ negative: false, days: 7, seconds: 0 });
    expect(parseDuration('P1W2D')).toEqual({ negative: false, days: 9, seconds: 0 });
    expect(parseDuration('P1DT2H')).toEqual({ negative: false, days: 1, seconds: 7200 });
    expect(parseDuration('-PT15M')).toEqual({ negative: true, days: 0, seconds: 900 });
    expect(parseDuration('+PT15M')).toEqual({ negative: false, days: 0, seconds: 900 });
    expect(parseDuration('PT1.5S')).toEqual({ negative: false, days: 0, seconds: 1.5 });
    expect(parseDuration('pt10m')).toEqual({ negative: false, days: 0, seconds: 600 });
    // AOSP: no T before seconds, M always minutes, Fossify's padded form.
    expect(parseDuration('P3600S')).toEqual({ negative: false, days: 0, seconds: 3600 });
    expect(parseDuration('P0DT1H30M0S')).toEqual({ negative: false, days: 0, seconds: 5400 });
    for (const bad of ['P', 'PT', 'P1Y', 'P1.5D', '1H', '', 'PTH']) expect(parseDuration(bad)).toBeNull();
    expect(durationTextSeconds('P1W')).toBe(604_800);
  });

  it('writes the strict JSCalendar grammar', () => {
    expect(formatJsDuration(0, 0)).toBe('PT0S');
    expect(formatJsDuration(2, 0)).toBe('P2D');
    expect(formatJsDuration(1, 3600)).toBe('P1DT1H');
    expect(formatJsDuration(0, 5400)).toBe('PT1H30M');
    // Minutes stay between hours and seconds.
    expect(formatJsDuration(0, 3605)).toBe('PT1H0M5S');
    expect(formatJsDuration(0, 45)).toBe('PT45S');
    expect(formatJsDuration(0, 59.6)).toBe('PT1M');
    expect(formatJsDurationSeconds(90_000)).toBe('P1DT1H');
    expect(formatJsDuration(-1, -5)).toBe('PT0S');
  });

  it('writes only what CalendarProvider accepts', () => {
    expect(formatAospDuration(5400, false)).toBe('P5400S');
    expect(formatAospDuration(0, false)).toBe('P0S');
    expect(formatAospDuration(172_800, true)).toBe('P2D');
    // A time part on an all-day event is rounded up to whole days; never zero days.
    expect(formatAospDuration(90_000, true)).toBe('P2D');
    expect(formatAospDuration(0, true)).toBe('P1D');
    for (const s of [0, 1, 59, 3600, 86_400, 1_000_000]) {
      expect(aospDurationValid(formatAospDuration(s, false))).toBe(true);
      expect(formatAospDuration(s, true)).toMatch(/^P\d+D$/);
    }
  });

  it('counts whole days nominally in the zone and the rest exactly', () => {
    const berlin = 'Europe/Berlin';
    // 23 h across the spring change are still one day.
    const start = localToUtc('2026-03-28T12:00:00', berlin)!;
    const end = localToUtc('2026-03-29T12:00:00', berlin)!;
    expect(end - start).toBe(23 * 3_600_000);
    expect(durationBetween(start, end, berlin)).toEqual({ negative: false, days: 1, seconds: 0 });
    expect(addDuration(start, { negative: false, days: 1, seconds: 0 }, berlin)).toBe(end);
    expect(durationBetween(start, end + 1_800_000, berlin)).toEqual({ negative: false, days: 1, seconds: 1800 });
    expect(durationBetween(start, start + 5_400_000, berlin)).toEqual({ negative: false, days: 0, seconds: 5400 });
    expect(durationBetween(end, start, berlin)).toEqual({ negative: false, days: 0, seconds: 0 });
  });

  it('keeps the second instant of a repeated hour when adding exact time', () => {
    const second = Date.parse('2026-10-25T01:30:00Z'); // 02:30 CET, after the change
    expect(addDuration(second, { negative: false, days: 0, seconds: 3600 }, 'Europe/Berlin')).toBe(second + 3_600_000);
  });

  it('compares lengths with a day as 24 hours', () => {
    expect(sameDurationLength('PT24H', 'P1D')).toBe(true);
    expect(sameDurationLength('P3600S', 'PT1H')).toBe(true);
    expect(sameDurationLength('PT1H', 'PT2H')).toBe(false);
  });
});
