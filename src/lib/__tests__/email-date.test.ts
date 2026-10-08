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

  it('keeps worded dates in the language\'s own pattern whatever the region', () => {
    const utc = { timeZone: 'UTC' };
    for (const dateLocale of ['auto', 'iso', 'en-GB', 'en-US'] as const) {
      expect(formatHeaderDate(iso, 'en', { ...utc, dateLocale })).toBe('Tue, Apr 28, 2026');
      expect(formatHeaderDate(iso, 'de', { ...utc, dateLocale })).toBe('Di., 28. Apr. 2026');
      expect(formatFullDateTime(iso, '24h', 'en', { ...utc, dateLocale })).toBe('Tue, Apr 28, 2026, 23:30');
    }
  });

  it('dates fa in the Gregorian calendar', () => {
    const out = formatHeaderDate(iso, 'fa', { timeZone: 'UTC', dateLocale: 'en-GB' });
    expect(out).toContain('آوریل');
    expect(out).toContain('۲۰۲۶');
    expect(out).not.toContain('اردیبهشت');
    expect(out).not.toContain('۱۴۰۵');
    expect(formatFullDateTime(iso, '24h', 'fa', { timeZone: 'UTC', dateLocale: 'en-GB' })).toContain('آوریل');
  });

  it('never leaves the month a bare number next to the day', () => {
    const r = { timeZone: 'UTC', dateLocale: 'en-GB' as const };
    expect(formatHeaderDate(iso, 'ja', r)).toBe('2026年4月28日(火)');
    expect(formatFullDateTime(iso, '24h', 'ja', r)).toMatch(/^2026年4月28日\(火\) 23:30$/);
    expect(formatHeaderDate(iso, 'cs', r)).toBe('út 28. dubna 2026');
    expect(formatFullDateTime(iso, '24h', 'cs', r)).toMatch(/^út 28\. dubna 2026.*23:30$/);
    for (const locale of ['ja', 'cs', 'zh', 'sk']) {
      expect(formatHeaderDate(iso, locale, r), locale).not.toMatch(/\d+\.?\s\d+\.?\s\d{4}/);
    }
  });
});
