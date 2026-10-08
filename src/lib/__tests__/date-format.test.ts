import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatFileModified, formatListDate, formatNumericDate, resolveDateLocale } from '../date-format';

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

describe('date format region', () => {
  const NOW = new Date('2026-05-30T12:00:00Z');
  const OLDER = new Date('2026-04-28T15:31:00Z');
  const smart = { dateFormat: 'smart' as const, timeFormat: '24h' as const, timeZone: 'UTC' };

  it('maps each region to the locale that orders its numbers', () => {
    expect(resolveDateLocale('iso', 'de')).toBe('en-CA');
    expect(resolveDateLocale('en-GB', 'de')).toBe('en-GB');
    expect(resolveDateLocale('en-US', 'de')).toBe('en-US');
    expect(resolveDateLocale('auto', 'de')).toBe('de');
    expect(resolveDateLocale(undefined, 'fr')).toBe('fr');
  });

  it('orders an older date by the region', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatListDate(OLDER, { ...smart, locale: 'en', dateLocale: 'iso' })).toBe('2026-04-28');
    expect(formatListDate(OLDER, { ...smart, locale: 'en', dateLocale: 'en-GB' })).toBe('28/04/2026');
    expect(formatListDate(OLDER, { ...smart, locale: 'en', dateLocale: 'en-US' })).toBe('04/28/2026');
    expect(formatListDate(OLDER, { ...smart, locale: 'de', dateLocale: 'iso' })).toBe('2026-04-28');
  });

  it('leaves auto as it was', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    for (const locale of ['en', 'de', 'fr', 'ja']) {
      for (const dateFormat of ['smart', 'full', 'relative'] as const) {
        const base = { dateFormat, timeFormat: '24h' as const, locale, timeZone: 'UTC' };
        expect(formatListDate(OLDER, { ...base, dateLocale: 'auto' })).toBe(formatListDate(OLDER, base));
      }
    }
    expect(formatListDate(OLDER, { ...smart, locale: 'de', dateLocale: 'auto' })).toBe('28.04.2026');
  });

  it('applies the region to the full format', () => {
    expect(formatListDate(OLDER, { dateFormat: 'full', timeFormat: '24h', locale: 'de', dateLocale: 'iso', timeZone: 'UTC' }))
      .toBe('2026-04-28, 15:31');
    expect(formatListDate(OLDER, { dateFormat: 'full', timeFormat: '24h', locale: 'en', dateLocale: 'en-GB', timeZone: 'UTC' }))
      .toBe('28/04/2026, 15:31');
  });

  it('keeps weekday and month names in the language', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const threeDaysAgo = new Date('2026-05-27T15:31:00Z');
    expect(formatListDate(threeDaysAgo, { ...smart, locale: 'de', dateLocale: 'iso' })).toBe('Mi 15:31');
    expect(formatListDate(OLDER, { dateFormat: 'relative', timeFormat: '24h', locale: 'de', dateLocale: 'iso', timeZone: 'UTC' }))
      .toBe('28. Apr.');
  });

  it('formats a bare numeric date for previews', () => {
    expect(formatNumericDate(OLDER, { locale: 'en', dateLocale: 'iso', timeZone: 'UTC' })).toBe('2026-04-28');
    expect(formatNumericDate(OLDER, { locale: 'de', dateLocale: 'auto', timeZone: 'UTC' })).toBe('28.04.2026');
    expect(formatNumericDate('nope', { locale: 'en' })).toBe('');
  });
});

describe('time zone', () => {
  const opts = { dateFormat: 'smart' as const, timeFormat: '24h' as const, locale: 'en' };

  it('shows list times in the chosen zone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T12:00:00Z'));
    const d = new Date('2026-05-30T09:15:00Z');
    expect(formatListDate(d, { ...opts, timeZone: 'UTC' })).toBe('09:15');
    expect(formatListDate(d, { ...opts, timeZone: 'Asia/Tokyo' })).toBe('18:15');
    expect(formatListDate(d, { ...opts, timeZone: 'America/New_York' })).toBe('05:15');
  });

  it('decides "today" in the chosen zone', () => {
    vi.useFakeTimers();
    // 00:10 on the 31st in UTC, 20:10 on the 30th in New York, 02:10 on the 31st in Berlin.
    vi.setSystemTime(new Date('2026-05-31T00:10:00Z'));
    const d = new Date('2026-05-30T23:30:00Z');
    expect(formatListDate(d, { ...opts, timeZone: 'America/New_York' })).toBe('19:30');
    expect(formatListDate(d, { ...opts, timeZone: 'Europe/Berlin' })).toBe('01:30');
    // Yesterday in UTC, so it gets its weekday.
    expect(formatListDate(d, { ...opts, timeZone: 'UTC' })).toBe('Sat 23:30');
  });

  it('dates an older message by its day in the chosen zone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T12:00:00Z'));
    const d = new Date('2026-04-28T23:30:00Z');
    expect(formatListDate(d, { ...opts, timeZone: 'UTC' })).toBe('04/28/2026');
    expect(formatListDate(d, { ...opts, timeZone: 'Asia/Tokyo' })).toBe('04/29/2026');
  });

  it('takes the year from the chosen zone in the relative format', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T12:00:00Z'));
    const d = new Date('2025-12-31T23:30:00Z');
    const rel = { ...opts, dateFormat: 'relative' as const };
    expect(formatListDate(d, { ...rel, timeZone: 'UTC' })).toBe('Dec 31, 2025');
    expect(formatListDate(d, { ...rel, timeZone: 'Europe/Berlin' })).toBe('Jan 1');
  });

  it('crosses a DST change on the clock of the chosen zone', () => {
    vi.useFakeTimers();
    // Berlin moved from CET to CEST at 01:00 UTC on 29 March 2026.
    vi.setSystemTime(new Date('2026-03-29T10:00:00Z'));
    expect(formatListDate(new Date('2026-03-28T23:30:00Z'), { ...opts, timeZone: 'Europe/Berlin' })).toBe('00:30');
    expect(formatListDate(new Date('2026-03-29T01:30:00Z'), { ...opts, timeZone: 'Europe/Berlin' })).toBe('03:30');
    // Back to CET at 01:00 UTC on 25 October 2026: 02:30 happens twice.
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    expect(formatListDate(new Date('2026-10-25T00:30:00Z'), { ...opts, timeZone: 'Europe/Berlin' })).toBe('02:30');
    expect(formatListDate(new Date('2026-10-25T01:30:00Z'), { ...opts, timeZone: 'Europe/Berlin' })).toBe('02:30');
    expect(formatListDate(new Date('2026-10-24T21:30:00Z'), { ...opts, timeZone: 'Europe/Berlin' })).toBe('Sat 23:30');
  });

  it('follows the device for auto and for an unknown zone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T12:00:00Z'));
    const d = new Date('2026-05-30T09:15:00Z');
    const device = formatListDate(d, opts);
    expect(formatListDate(d, { ...opts, timeZone: 'auto' })).toBe(device);
    expect(formatListDate(d, { ...opts, timeZone: 'Mars/Olympus_Mons' })).toBe(device);
  });

  it('keys the formatter cache by zone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T03:00:00Z'));
    const d = new Date('2026-05-30T01:15:00Z');
    const z = { ...opts, locale: 'is' };
    expect(formatListDate(d, { ...z, timeZone: 'Asia/Kolkata' })).toBe('06:45');
    // Same locale and format, another zone: not the cached Kolkata formatter.
    expect(formatListDate(d, { ...z, timeZone: 'Pacific/Auckland' })).toBe('13:15');
    expect(formatListDate(d, { ...z, timeZone: 'Asia/Kolkata' })).toBe('06:45');
  });
});

describe('Gregorian calendar', () => {
  it('dates fa list rows in the Gregorian calendar', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T12:00:00Z'));
    const older = new Date('2026-04-28T15:31:00Z');
    expect(formatListDate(older, { dateFormat: 'smart', timeFormat: '24h', locale: 'fa', timeZone: 'UTC' })).toBe('۲۰۲۶/۰۴/۲۸');
    expect(formatListDate(older, { dateFormat: 'relative', timeFormat: '24h', locale: 'fa', timeZone: 'UTC' })).toContain('آوریل');
  });
});

describe('formatFileModified', () => {
  const now = new Date('2026-05-30T23:30:00Z');

  it('decides today in the chosen zone and shows its clock', () => {
    const iso = '2026-05-30T22:00:00Z';
    expect(formatFileModified(iso, 'UTC', now)).toMatch(/^10:00\sPM$|^22:00$/);
    // Already the 31st in Tokyo for both, so still today, at 07:00.
    expect(formatFileModified(iso, 'Asia/Tokyo', now)).toMatch(/^07:00(\sAM)?$/);
    // 01:00 on the 30th in New York, where it is still the 30th; already
    // the 31st in Tokyo, so there it is yesterday's file.
    const early = '2026-05-30T05:00:00Z';
    expect(formatFileModified(early, 'America/New_York', now)).toMatch(/^01:00(\sAM)?$/);
    expect(formatFileModified(early, 'UTC', now)).toMatch(/^05:00(\sAM)?$/);
    expect(formatFileModified(early, 'Asia/Tokyo', now)).toMatch(/^May 30$|^30/);
  });

  it('reads the year in the chosen zone', () => {
    const iso = '2025-12-31T23:30:00Z';
    expect(formatFileModified(iso, 'UTC', now)).toContain('2025');
    expect(formatFileModified(iso, 'Europe/Berlin', now)).not.toContain('2025');
  });

  it('is empty for no or a bad date', () => {
    expect(formatFileModified(undefined, 'UTC', now)).toBe('');
    expect(formatFileModified('nope', 'UTC', now)).toBe('');
  });
});
