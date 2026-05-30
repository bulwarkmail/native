import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatListDate } from '../date-format';

afterEach(() => {
  vi.useRealTimers();
});

describe('formatListDate', () => {
  it('returns empty string for an invalid date', () => {
    expect(formatListDate('not-a-date', { dateFormat: 'smart', timeFormat: '24h', locale: 'en' })).toBe('');
  });

  it('relative: minutes / hours / days ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T12:00:00Z'));
    const opts = { dateFormat: 'relative' as const, timeFormat: '24h' as const, locale: 'en' };
    expect(formatListDate(new Date(Date.now() - 5 * 60000), opts)).toBe('5m ago');
    expect(formatListDate(new Date(Date.now() - 3 * 3600000), opts)).toBe('3h ago');
    expect(formatListDate(new Date(Date.now() - 2 * 86400000), opts)).toBe('2d ago');
  });

  it('relative: "Just now" under a minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T12:00:00Z'));
    expect(
      formatListDate(new Date(Date.now() - 10_000), { dateFormat: 'relative', timeFormat: '24h', locale: 'en' }),
    ).toBe('Just now');
  });

  it('smart: same-day shows time only (24h, no AM/PM)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T12:00:00Z'));
    const out = formatListDate(new Date(), { dateFormat: 'smart', timeFormat: '24h', locale: 'en' });
    expect(out).not.toMatch(/AM|PM/);
    expect(out).toMatch(/^\d{1,2}:\d{2}$/);
  });

  it('smart: older than a week shows a numeric date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T12:00:00Z'));
    const out = formatListDate(new Date('2026-01-01T09:00:00Z'), {
      dateFormat: 'smart',
      timeFormat: '24h',
      locale: 'en',
    });
    expect(out).toContain('2026');
  });

  it('full: always includes the year', () => {
    const out = formatListDate('2026-04-28T15:31:00Z', { dateFormat: 'full', timeFormat: '24h', locale: 'en' });
    expect(out).toContain('2026');
  });
});
