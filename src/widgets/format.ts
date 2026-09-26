// Strings and date formatting for widget layouts. Widgets render in a headless
// task with no React tree, so this uses the plain translate() lookup instead
// of the useTranslation hook. Keys live under `widgets.` in locales/rn/*.json
// (added by `npm run i18n:harvest`); each call repeats the English text as
// the fallback so a missing key never shows up raw on the home screen.

import { isSupportedLocale, translate, type LocaleCode, type MessageParams } from '../i18n';

export interface Fmt {
  locale: string;
  hour12: boolean;
  t: (key: string, fallback: string, params?: MessageParams) => string;
  /** Clock time in the user's 12h/24h setting. */
  time: (ms: number) => string;
  weekdayShort: (ms: number) => string;
  weekdayLong: (ms: number) => string;
  monthLong: (ms: number) => string;
  /** "Sep 28" */
  dayMonth: (ms: number) => string;
  /** "Mon, Sep 28" */
  weekdayDayMonth: (ms: number) => string;
  /** "Sep 28, 2026" */
  fullDate: (ms: number) => string;
  /** Time today, weekday this week, date otherwise - the list's receivedAt style. */
  listDate: (ms: number, now: number) => string;
  /** "in 25 min", "in 2 h", "now". */
  relative: (ms: number, now: number) => string;
  bytes: (n: number) => string;
}

function safeFormat(locale: string, options: Intl.DateTimeFormatOptions): (ms: number) => string {
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat(locale, options);
  } catch {
    try {
      formatter = new Intl.DateTimeFormat('en', options);
    } catch {
      formatter = null;
    }
  }
  return (ms: number) => {
    const d = new Date(ms);
    if (formatter) {
      try {
        return formatter.format(d);
      } catch {
        // fall through
      }
    }
    return d.toDateString();
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

export function makeFmt(locale: string, hour12: boolean): Fmt {
  const lang: LocaleCode = isSupportedLocale(locale) ? locale : 'en';
  const t = (key: string, fallback: string, params?: MessageParams) =>
    translate(lang, key, fallback, params);

  const weekdayShort = safeFormat(locale, { weekday: 'short' });
  const weekdayLong = safeFormat(locale, { weekday: 'long' });
  const monthLong = safeFormat(locale, { month: 'long' });
  const dayMonth = safeFormat(locale, { month: 'short', day: 'numeric' });
  const weekdayDayMonth = safeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric' });
  const fullDate = safeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' });

  const time = (ms: number) => {
    const d = new Date(ms);
    const h = d.getHours();
    const m = pad(d.getMinutes());
    if (!hour12) return `${pad(h)}:${m}`;
    const suffix = h < 12 ? 'AM' : 'PM';
    return `${h % 12 === 0 ? 12 : h % 12}:${m} ${suffix}`;
  };

  return {
    locale,
    hour12,
    t,
    time,
    weekdayShort,
    weekdayLong,
    monthLong,
    dayMonth,
    weekdayDayMonth,
    fullDate,
    listDate: (ms, now) => {
      if (sameDay(ms, now)) return time(ms);
      const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86400000);
      if (days > 0 && days < 7) return weekdayShort(ms);
      return dayMonth(ms);
    },
    relative: (ms, now) => {
      const minutes = Math.round((ms - now) / 60000);
      if (minutes <= 0) return t('widgets.relative.now', 'now');
      if (minutes < 60) return t('widgets.relative.minutes', 'in {count} min', { count: minutes });
      const hours = Math.round(minutes / 60);
      if (hours < 24) return t('widgets.relative.hours', 'in {count} h', { count: hours });
      const days = Math.round((startOfDay(ms) - startOfDay(now)) / 86400000);
      return t('widgets.relative.days', '{count, plural, one {in # day} other {in # days}}', { count: days });
    },
    bytes: (n) => {
      if (!Number.isFinite(n) || n <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let v = n;
      let i = 0;
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
      }
      return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
    },
  };
}
