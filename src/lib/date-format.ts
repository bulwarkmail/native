import type { DateFormat, DateLocale, TimeFormat } from '../stores/settings-store';
import { getWallClock, resolveTimeZone } from './time-zone';

/**
 * Formats a received-at date for the email list. Mirrors the webmail
 * `formatDate` helper (lib/utils.ts) so both clients render list dates the
 * same way. The style is controlled by the `dateFormat` user setting:
 *
 *   - `smart` (default) — locale-aware, age-bucketed:
 *       today        → time only          ("15:31" or "3:31 PM")
 *       last 7 days  → short weekday+time ("Fr 15:31", "Fri 3:31 PM")
 *       older        → full locale date   ("28.04.2026", "04/28/2026")
 *   - `relative` — relative format ("1h ago", "2d ago").
 *   - `full` — always the full locale date+time.
 *
 * `locale` is the language subtag from the locale store (e.g. "en", "de").
 * `dateLocale` (the date format region) orders the numeric dates; weekday
 * and month names stay in the language. Everything, including which day
 * counts as today, is in `timeZone`: the app-wide zone setting, where
 * `auto` (or a zone this runtime does not know) is the device zone.
 */
type Translate = (key: string, fallback?: string, params?: Record<string, string | number>) => string;

type FormatName =
  | 'time12' | 'time24' | 'full12' | 'full24' | 'weekday' | 'date' | 'monthDay' | 'monthDayYear';

const FORMATS: Record<FormatName, Intl.DateTimeFormatOptions> = {
  time12: { hour: '2-digit', minute: '2-digit', hour12: true },
  time24: { hour: '2-digit', minute: '2-digit', hour12: false },
  full12: { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true },
  full24: { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false },
  weekday: { weekday: 'short' },
  date: { year: 'numeric', month: '2-digit', day: '2-digit' },
  monthDay: { month: 'short', day: 'numeric' },
  monthDayYear: { month: 'short', day: 'numeric', year: 'numeric' },
};

// Building an Intl formatter is the expensive part of formatting a date (on
// Hermes it goes through ICU over JNI), and `toLocaleString`,
// `toLocaleDateString` and `toLocaleTimeString` build a new one on every
// call. The list formats a date in every row render, so keep one formatter
// per format, locale and time zone. The output is the same: when the options
// name at least one field, those methods format exactly as
// `Intl.DateTimeFormat` does with the same options.
const formatters = new Map<string, Intl.DateTimeFormat>();
// Every formatter is built with an explicit zone, so a DST change inside it
// needs nothing. The device zone behind `auto` can still change (travel):
// start over when the device's UTC offset moves so stale entries go.
let formattersOffset: number | undefined;

function syncFormatterZone(now: Date): void {
  const offset = now.getTimezoneOffset();
  if (offset === formattersOffset) return;
  formatters.clear();
  formattersOffset = offset;
}

function cachedFormatter(key: string, locale: string, options: Intl.DateTimeFormatOptions, timeZone: string): Intl.DateTimeFormat {
  const fullKey = `${key}|${locale}|${timeZone}`;
  let formatter = formatters.get(fullKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    formatters.set(fullKey, formatter);
  }
  return formatter;
}

function formatWith(d: Date, locale: string, name: FormatName, timeZone: string): string {
  return cachedFormatter(name, locale, FORMATS[name], timeZone).format(d);
}

/** The Intl locale for the language subtag: `en` alone is en-US, as in the webmail. */
function uiIntlLocale(locale: string | undefined): string {
  return !locale || locale === 'en' ? 'en-US' : locale;
}

/**
 * The locale that orders numeric dates for the region setting. Port of the
 * webmail's lib/utils.ts `resolveDateLocale`: `iso` borrows en-CA, whose
 * short date is YYYY-MM-DD.
 */
export function resolveDateLocale(dateLocale: DateLocale | undefined, fallback: string): string {
  switch (dateLocale) {
    case 'iso':
      return 'en-CA';
    case 'en-GB':
      return 'en-GB';
    case 'en-US':
      return 'en-US';
    default:
      return fallback;
  }
}

/** The date format region and the time zone setting, as stored. */
export interface DateRegion {
  dateLocale?: DateLocale;
  /** An IANA zone, or `auto` / undefined for the device zone. */
  timeZone?: string;
}

/** The numeric date alone ("28.04.2026", "2026-04-28"), as an older list row shows it. */
export function formatNumericDate(date: Date | string, opts: DateRegion & { locale: string }): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  syncFormatterZone(new Date());
  const numericLocale = resolveDateLocale(opts.dateLocale, uiIntlLocale(opts.locale));
  return formatWith(d, numericLocale, 'date', resolveTimeZone(opts.timeZone));
}

// Parts that are words in the language rather than digits in the region.
const NAME_PARTS = new Set<Intl.DateTimeFormatPartTypes>(['weekday', 'month', 'dayPeriod', 'era']);
const DIGITS = /^\d+$/;

/**
 * Formats `options` in the zone with the region's order and separators and
 * the language's weekday, month and AM/PM words ("Di., Apr. 28, 2026" for
 * German with month/day/year). Formatting in the region's locale alone
 * would turn those words English. With `auto` it is the language's format.
 */
export function formatInRegion(
  date: Date,
  options: Intl.DateTimeFormatOptions,
  opts: DateRegion & { locale?: string },
): string {
  syncFormatterZone(new Date());
  const uiLocale = uiIntlLocale(opts.locale);
  const regionLocale = resolveDateLocale(opts.dateLocale, uiLocale);
  const timeZone = resolveTimeZone(opts.timeZone);
  const key = JSON.stringify(options);
  const region = cachedFormatter(key, regionLocale, options, timeZone);
  if (regionLocale === uiLocale) return region.format(date);
  const names = new Map<string, string>();
  for (const part of cachedFormatter(key, uiLocale, options, timeZone).formatToParts(date)) {
    if (NAME_PARTS.has(part.type)) names.set(part.type, part.value);
  }
  return region
    .formatToParts(date)
    .map((part) => (NAME_PARTS.has(part.type) && !DIGITS.test(part.value) ? names.get(part.type) ?? part.value : part.value))
    .join('');
}

// Relative strings ("Just now", "5m ago") through the locale catalog when a
// translate function is supplied; the compact English form otherwise.
function relativeLabel(
  t: Translate | undefined,
  unit: 'minute' | 'hour' | 'day',
  count: number,
): string {
  if (!t) return `${count}${unit[0]} ago`;
  const key = `date.${unit}s_ago${count === 1 ? '' : '_plural'}`;
  return t(key, `${count}${unit[0]} ago`, { count });
}

export function formatListDate(
  date: Date | string,
  opts: DateRegion & { dateFormat: DateFormat; timeFormat: TimeFormat; locale: string; t?: Translate },
): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  syncFormatterZone(now);

  const { dateFormat, timeFormat } = opts;
  // Names (weekday, month) and times follow the language; numeric dates
  // follow the region, which is the language for `auto`.
  const intlLocale = uiIntlLocale(opts.locale);
  const numericLocale = resolveDateLocale(opts.dateLocale, intlLocale);
  const timeZone = resolveTimeZone(opts.timeZone);
  const hour12 = timeFormat === '12h';

  if (dateFormat === 'relative') {
    const diff = now.getTime() - d.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (minutes < 1) return opts.t ? opts.t('date.just_now', 'Just now') : 'Just now';
    if (minutes < 60) return relativeLabel(opts.t, 'minute', minutes);
    if (hours < 24) return relativeLabel(opts.t, 'hour', hours);
    if (days < 7) return relativeLabel(opts.t, 'day', days);
    const otherYear = getWallClock(d, timeZone).year !== getWallClock(now, timeZone).year;
    return formatWith(d, intlLocale, otherYear ? 'monthDayYear' : 'monthDay', timeZone);
  }

  if (dateFormat === 'full') {
    return formatWith(d, numericLocale, hour12 ? 'full12' : 'full24', timeZone);
  }

  // 'smart' (default)
  const timeStr = formatWith(d, intlLocale, hour12 ? 'time12' : 'time24', timeZone);

  // The calendar day in the display zone, not the device's: Intl applies
  // the zone's offset for each instant, so a DST change between the two
  // moves neither.
  const dWall = getWallClock(d, timeZone);
  const nowWall = getWallClock(now, timeZone);
  const isSameDay =
    dWall.year === nowWall.year &&
    dWall.month === nowWall.month &&
    dWall.day === nowWall.day;
  if (isSameDay) return timeStr;

  const daysAgo = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (daysAgo < 7) {
    // German Intl outputs "Fr." with a trailing dot for `weekday: 'short'`;
    // strip it so the result reads cleanly next to the time.
    const weekday = formatWith(d, intlLocale, 'weekday', timeZone).replace(/\.$/, '');
    return `${weekday} ${timeStr}`;
  }

  return formatWith(d, numericLocale, 'date', timeZone);
}
