import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatListDate } from '../date-format';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

// `formatListDate` as it was before it cached its Intl formatters: every call
// went through `toLocale*String`, which builds a new formatter each time. The
// cached version has to format exactly like it.
function formatListDateUncached(
  date: Date,
  opts: { dateFormat: 'smart' | 'relative' | 'full'; timeFormat: '12h' | '24h'; locale: string },
): string {
  const d = date;
  const now = new Date();
  const locale = opts.locale && opts.locale.length > 0 ? opts.locale : 'en';
  const intlLocale = locale === 'en' ? 'en-US' : locale;
  const hour12 = opts.timeFormat === '12h';
  if (opts.dateFormat === 'relative') {
    const diff = now.getTime() - d.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString(intlLocale, {
      month: 'short',
      day: 'numeric',
      year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    });
  }
  if (opts.dateFormat === 'full') {
    return d.toLocaleString(intlLocale, {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12,
    });
  }
  const timeStr = d.toLocaleTimeString(intlLocale, { hour: '2-digit', minute: '2-digit', hour12 });
  const isSameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isSameDay) return timeStr;
  const daysAgo = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (daysAgo < 7) {
    const weekday = d.toLocaleDateString(intlLocale, { weekday: 'short' }).replace(/\.$/, '');
    return `${weekday} ${timeStr}`;
  }
  return d.toLocaleDateString(intlLocale, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

describe('formatListDate with cached formatters', () => {
  const NOW = new Date('2026-05-30T12:00:00Z');
  const HOUR = 3600000;
  const DAY = 24 * HOUR;
  const ages = [
    30_000, 20 * 60000, 2 * HOUR, 11 * HOUR, 20 * HOUR, DAY, 3 * DAY, 6.9 * DAY, 8 * DAY, 40 * DAY,
    160 * DAY, 400 * DAY, -DAY,
  ];
  const locales = ['en', '', 'de', 'fr', 'es', 'nl', 'pt-BR', 'ru', 'ja', 'zh', 'ko', 'ar', 'he', 'hi'];

  it('formats exactly as the per-call toLocale*String methods did', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    for (const locale of locales) {
      for (const dateFormat of ['smart', 'relative', 'full'] as const) {
        for (const timeFormat of ['12h', '24h'] as const) {
          for (const age of ages) {
            const d = new Date(NOW.getTime() - age);
            const opts = { dateFormat, timeFormat, locale };
            expect(formatListDate(d, opts), `${locale} ${dateFormat} ${timeFormat} ${age}`)
              .toBe(formatListDateUncached(d, opts));
          }
        }
      }
    }
  });

  it('builds each formatter once per locale and format', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const ctor = vi.spyOn(Intl, 'DateTimeFormat');
    const opts = { dateFormat: 'smart' as const, timeFormat: '24h' as const, locale: 'sv' };
    const threeDaysAgo = new Date(NOW.getTime() - 3 * DAY);
    // A weekday row needs the time and the weekday formatter.
    const first = formatListDate(threeDaysAgo, opts);
    expect(ctor).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 50; i++) expect(formatListDate(threeDaysAgo, opts)).toBe(first);
    expect(ctor).toHaveBeenCalledTimes(2);
    // Another locale gets its own.
    formatListDate(threeDaysAgo, { ...opts, locale: 'da' });
    expect(ctor).toHaveBeenCalledTimes(4);
  });

  it('builds them again when the UTC offset changes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const opts = { dateFormat: 'smart' as const, timeFormat: '24h' as const, locale: 'fi' };
    const earlier = new Date(NOW.getTime() - HOUR);
    formatListDate(earlier, opts);
    const ctor = vi.spyOn(Intl, 'DateTimeFormat');
    formatListDate(earlier, opts);
    expect(ctor).not.toHaveBeenCalled();
    const offset = NOW.getTimezoneOffset();
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(offset + 60);
    formatListDate(earlier, opts);
    expect(ctor).toHaveBeenCalledTimes(1);
  });
});
