import { describe, it, expect } from 'vitest';
import { emailDisplayDate, formatFullDateTime, formatHeaderDate, formatHeaderTime, MAX_FUTURE_SENT_AT_MS } from '../email-date';

describe('emailDisplayDate', () => {
  it('prefers sentAt over receivedAt (#891)', () => {
    expect(emailDisplayDate({ sentAt: '2024-01-01T00:00:00Z', receivedAt: '2026-06-01T00:00:00Z' })).toBe('2024-01-01T00:00:00Z');
  });

  it('falls back when sentAt is missing, unparsable or forged into the future', () => {
    expect(emailDisplayDate({ receivedAt: '2026-06-01T00:00:00Z' })).toBe('2026-06-01T00:00:00Z');
    expect(emailDisplayDate({ sentAt: 'garbage', receivedAt: '2026-06-01T00:00:00Z' })).toBe('2026-06-01T00:00:00Z');
    const received = Date.parse('2026-06-01T00:00:00Z');
    const future = new Date(received + MAX_FUTURE_SENT_AT_MS + 1000).toISOString();
    expect(emailDisplayDate({ sentAt: future, receivedAt: '2026-06-01T00:00:00Z' })).toBe('2026-06-01T00:00:00Z');
    const slightlyAhead = new Date(received + 60_000).toISOString();
    expect(emailDisplayDate({ sentAt: slightlyAhead, receivedAt: '2026-06-01T00:00:00Z' })).toBe(slightlyAhead);
  });
});

describe('formatHeaderTime', () => {
  it('honours the time-format setting', () => {
    const iso = '2026-06-01T15:07:00';
    expect(formatHeaderTime(iso, '24h', 'en')).toMatch(/15:07/);
    expect(formatHeaderTime(iso, '12h', 'en')).toMatch(/3:07\s?PM/i);
    expect(formatHeaderTime(undefined, '24h')).toBe('');
  });
});

describe('header and detail times in the chosen zone and region', () => {
  const iso = '2026-04-28T23:30:00Z';

  it('shifts the header time and day with the zone', () => {
    expect(formatHeaderTime(iso, '24h', 'en', { timeZone: 'UTC' })).toBe('23:30');
    expect(formatHeaderTime(iso, '24h', 'en', { timeZone: 'Asia/Tokyo' })).toBe('08:30');
    expect(formatHeaderDate(iso, 'en', { timeZone: 'UTC' })).toBe('Tue, Apr 28, 2026');
    expect(formatHeaderDate(iso, 'en', { timeZone: 'Asia/Tokyo' })).toBe('Wed, Apr 29, 2026');
  });

  it('shifts the detail time with the zone', () => {
    expect(formatFullDateTime(iso, '24h', 'en', { timeZone: 'America/New_York' })).toBe('Tue, Apr 28, 2026, 19:30');
  });

  it('follows the device for auto', () => {
    expect(formatHeaderTime(iso, '24h', 'en', { timeZone: 'auto' })).toBe(formatHeaderTime(iso, '24h', 'en'));
  });

  it('orders the date by the region and keeps the names in the language', () => {
    const utc = { timeZone: 'UTC' };
    expect(formatHeaderDate(iso, 'en', { ...utc, dateLocale: 'en-GB' })).toBe('Tue, 28 Apr 2026');
    expect(formatFullDateTime(iso, '24h', 'en', { ...utc, dateLocale: 'en-GB' })).toBe('Tue, 28 Apr 2026, 23:30');
    expect(formatHeaderDate(iso, 'de', { ...utc, dateLocale: 'en-US' })).toBe('Di., Apr. 28, 2026');
    expect(formatFullDateTime(iso, '12h', 'en', { ...utc, dateLocale: 'en-GB' })).toMatch(/^Tue, 28 Apr 2026, 11:30\sPM$/);
    expect(formatHeaderDate(iso, 'de', { ...utc, dateLocale: 'auto' })).toBe('Di., 28. Apr. 2026');
  });
});
