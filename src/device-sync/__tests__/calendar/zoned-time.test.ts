import { describe, expect, it } from 'vitest';
import {
  canonicalZone,
  classifyLocal,
  dateToUtcMidnight,
  fixedOffsetZone,
  isValidTimeZone,
  localToUtc,
  offsetAt,
  parseLocalDateTime,
  utcMidnightToDate,
  utcToLocal,
} from '../../calendar/zoned-time';

const utc = (iso: string) => Date.parse(iso);

describe('calendar/zoned-time', () => {
  it('reads LocalDateTimes like Stalwart: fraction and suffix ignored, impossible dates refused', () => {
    expect(parseLocalDateTime('2026-10-25T02:30:00')).toEqual({ year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 });
    expect(parseLocalDateTime('2026-10-25T02:30:00.250Z')).toMatchObject({ hour: 2, minute: 30, second: 0 });
    expect(parseLocalDateTime('2026-10-25')).toMatchObject({ hour: 0, minute: 0 });
    expect(parseLocalDateTime('2026-02-30T00:00:00')).toBeNull();
    expect(parseLocalDateTime('2026-01-01T24:00:00')).toBeNull();
    expect(parseLocalDateTime('garbage')).toBeNull();
  });

  // R3 B1: the app's localDateTimeToInstant gets these wrong in one direction or the other.
  it.each([
    ['America/New_York', '2026-03-08T02:30:00', 'gap', '2026-03-08T07:30:00Z'],
    ['America/New_York', '2026-11-01T01:30:00', 'overlap', '2026-11-01T05:30:00Z'],
    ['Europe/Berlin', '2026-03-29T02:30:00', 'gap', '2026-03-29T01:30:00Z'],
    ['Europe/Berlin', '2026-10-25T02:30:00', 'overlap', '2026-10-25T00:30:00Z'],
    ['Australia/Sydney', '2026-04-05T02:30:00', 'overlap', '2026-04-04T15:30:00Z'],
    ['Australia/Sydney', '2026-10-04T02:30:00', 'gap', '2026-10-03T16:30:00Z'],
    ['Australia/Lord_Howe', '2026-10-04T02:15:00', 'gap', '2026-10-03T15:45:00Z'],
    ['Europe/Berlin', '2026-10-25T04:30:00', 'ok', '2026-10-25T03:30:00Z'],
    ['Asia/Kolkata', '2026-06-01T10:00:00', 'ok', '2026-06-01T04:30:00Z'],
  ])('resolves %s %s (%s) with RFC 5545 semantics', (zone, local, kind, expected) => {
    expect(classifyLocal(local, zone)).toBe(kind);
    expect(new Date(localToUtc(local, zone)!).toISOString().replace('.000', '')).toBe(expected);
  });

  it('moves a gap time forward by the gap and keeps the wall time of an overlap', () => {
    expect(utcToLocal(localToUtc('2026-03-29T02:30:00', 'Europe/Berlin')!, 'Europe/Berlin')).toBe('2026-03-29T03:30:00');
    expect(utcToLocal(localToUtc('2026-03-08T02:30:00', 'America/New_York')!, 'America/New_York')).toBe('2026-03-08T03:30:00');
    // Both instants of the repeated hour read back as the same wall time.
    expect(utcToLocal(utc('2026-10-25T00:30:00Z'), 'Europe/Berlin')).toBe('2026-10-25T02:30:00');
    expect(utcToLocal(utc('2026-10-25T01:30:00Z'), 'Europe/Berlin')).toBe('2026-10-25T02:30:00');
  });

  it('does not depend on the zone the process runs in', () => {
    // The device's own gap day is no special case: fields are parsed, not handed to Date.
    expect(localToUtc('2026-03-29T02:30:00', 'UTC')).toBe(utc('2026-03-29T02:30:00Z'));
    expect(offsetAt(utc('2026-07-01T00:00:00Z'), 'Europe/Berlin')).toBe(7_200_000);
    expect(offsetAt(utc('2026-01-01T00:00:00Z'), 'America/New_York')).toBe(-18_000_000);
  });

  it('validates zones with Intl and names them canonically', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(canonicalZone('europe/berlin')).toBe('Europe/Berlin');
    expect(canonicalZone('US/Eastern')).toBe('America/New_York');
  });

  it('names fixed-offset zones the Etc way, UTC for fractional offsets', () => {
    expect(fixedOffsetZone(7_200_000)).toBe('Etc/GMT-2');
    expect(fixedOffsetZone(-18_000_000)).toBe('Etc/GMT+5');
    expect(fixedOffsetZone(0)).toBe('Etc/UTC');
    expect(fixedOffsetZone(19_800_000)).toBe('Etc/UTC');
  });

  it('maps all-day dates to UTC midnight and back', () => {
    expect(dateToUtcMidnight('2026-10-08T00:00:00')).toBe(utc('2026-10-08T00:00:00Z'));
    expect(dateToUtcMidnight('2026-10-08T09:00:00')).toBe(utc('2026-10-08T00:00:00Z'));
    expect(utcMidnightToDate(utc('2026-10-08T00:00:00Z'))).toBe('2026-10-08T00:00:00');
    // Date.UTC would read year 50 as 1950.
    expect(new Date(dateToUtcMidnight('0050-01-01T00:00:00')!).toISOString()).toBe('0050-01-01T00:00:00.000Z');
  });
});
