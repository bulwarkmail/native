/**
 * Custom recurrence rule helpers for the event editor. Mobile port of
 * webmail's components/calendar/recurrence-editor.tsx logic (rule detection,
 * construction, and the human-readable summary).
 */

import { format, type Locale } from 'date-fns';
import type { RecurrenceRule } from '../api/types';
import type { TranslateFn } from '../stores/locale-store';

export type EditorFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type MonthlyMode = 'day' | 'nth';
export type EndsMode = 'never' | 'on' | 'after';

export const EDITOR_FREQUENCIES: EditorFrequency[] = ['daily', 'weekly', 'monthly', 'yearly'];

// JSCalendar weekday ids in display order (week starts Monday, matching the
// firstDayOfWeek the built rules declare).
export const WEEKDAYS: string[] = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
const DAY_TO_REF_DATE: Record<string, number> = { mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6, su: 7 };
export const INDEX_TO_DAY = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

// The editor's unit picker (webmail UNIT_LABEL_KEYS): key and English text.
export const UNIT_LABEL_KEYS: Record<EditorFrequency, [string, string]> = {
  daily: ['calendar.recurrence.editor_unit_days', 'day(s)'],
  weekly: ['calendar.recurrence.editor_unit_weeks', 'week(s)'],
  monthly: ['calendar.recurrence.editor_unit_months', 'month(s)'],
  yearly: ['calendar.recurrence.editor_unit_years', 'year(s)'],
};

// 2024-01-01 is a Monday — used to render weekday names via date-fns.
export function weekdayName(day: string, style: 'long' | 'short' = 'long', locale?: Locale): string {
  const ref = new Date(2024, 0, DAY_TO_REF_DATE[day] ?? 1);
  return format(ref, style === 'long' ? 'EEEE' : 'EEE', { locale });
}

export function monthName(month: number, locale?: Locale): string {
  return format(new Date(2024, month - 1, 1), 'LLLL', { locale });
}

export function nthLabel(nth: number, t: TranslateFn): string {
  switch (nth) {
    case 1: return t('calendar.recurrence.nth_1', 'first');
    case 2: return t('calendar.recurrence.nth_2', 'second');
    case 3: return t('calendar.recurrence.nth_3', 'third');
    case 4: return t('calendar.recurrence.nth_4', 'fourth');
    case -1: return t('calendar.recurrence.nth_last', 'last');
    default: return String(nth);
  }
}

/**
 * "Daily" / "Every 3 weeks" for a rule's frequency and interval, or null for
 * a frequency without a label (hourly etc.).
 */
export function recurrenceIntervalLabel(frequency: string, interval: number, t: TranslateFn): string | null {
  const every = interval > 1;
  switch (frequency) {
    case 'daily':
      return every
        ? t('calendar.recurrence.every_count_days', '{count, plural, one {Every # day} other {Every # days}}', { count: interval })
        : t('calendar.recurrence.daily', 'Daily');
    case 'weekly':
      return every
        ? t('calendar.recurrence.every_count_weeks', '{count, plural, one {Every # week} other {Every # weeks}}', { count: interval })
        : t('calendar.recurrence.weekly', 'Weekly');
    case 'monthly':
      return every
        ? t('calendar.recurrence.every_count_months', '{count, plural, one {Every # month} other {Every # months}}', { count: interval })
        : t('calendar.recurrence.monthly', 'Monthly');
    case 'yearly':
      return every
        ? t('calendar.recurrence.every_count_years', '{count, plural, one {Every # year} other {Every # years}}', { count: interval })
        : t('calendar.recurrence.yearly', 'Yearly');
    default:
      return null;
  }
}

/** "12 occurrences" / "Until Mar 1, 2027" for a rule that ends, else null. */
export function recurrenceEndLabel(rule: RecurrenceRule, t: TranslateFn, locale?: Locale): string | null {
  if (rule.count) {
    return t('calendar.recurrence.occurrence_count', '{count, plural, one {# occurrence} other {# occurrences}}', { count: rule.count });
  }
  if (rule.until) {
    const d = new Date(rule.until);
    if (!isNaN(d.getTime())) {
      return t('calendar.recurrence.until_date', 'Until {date}', { date: format(d, 'MMM d, yyyy', { locale }) });
    }
  }
  return null;
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Extract an "nth weekday" pattern from a rule, accepting both the
 * byDay+nthOfPeriod encoding and the byDay+bySetPosition encoding.
 */
export function getNthDay(rule: RecurrenceRule): { day: string; nth: number } | null {
  if (rule.byDay?.length === 1) {
    const nd = rule.byDay[0];
    if (nd.nthOfPeriod) return { day: nd.day, nth: nd.nthOfPeriod };
    if (rule.bySetPosition?.length === 1) return { day: nd.day, nth: rule.bySetPosition[0] };
  }
  return null;
}

/**
 * True when the rule is exactly what the plain Daily/Weekly/Monthly/Yearly
 * dropdown presets produce, i.e. it needs no custom editor to represent.
 */
export function isSimpleRecurrenceRule(rule: RecurrenceRule): boolean {
  return (
    (EDITOR_FREQUENCIES as string[]).includes(rule.frequency) &&
    (!rule.interval || rule.interval === 1) &&
    !rule.byDay?.length &&
    !rule.byMonthDay?.length &&
    !rule.byMonth?.length &&
    !rule.byYearDay?.length &&
    !rule.byWeekNo?.length &&
    !rule.bySetPosition?.length &&
    !rule.count &&
    !rule.until
  );
}

/**
 * Human-readable summary of a recurrence rule, e.g.
 * "Every 2 months on the third Thursday · 12 occurrences", in the app
 * language (from the same catalog fragments the webmail builds it from).
 * Returns null for frequencies the UI cannot describe (hourly etc.).
 */
export function buildRecurrenceSummary(rule: RecurrenceRule, t: TranslateFn, locale?: Locale): string | null {
  const base = recurrenceIntervalLabel(rule.frequency, rule.interval || 1, t);
  if (!base) return null;

  const parts = [base];

  if (rule.frequency === 'weekly' && rule.byDay?.length) {
    const days = rule.byDay
      .filter((d) => WEEKDAYS.includes(d.day))
      .sort((a, b) => WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day))
      .map((d) => weekdayName(d.day, 'short', locale))
      .join(', ');
    if (days) parts.push(t('calendar.recurrence.on_days', 'on {days}', { days }));
  }

  if (rule.frequency === 'monthly' || rule.frequency === 'yearly') {
    if (rule.frequency === 'yearly' && rule.byMonth?.length) {
      const m = parseInt(rule.byMonth[0], 10);
      if (m >= 1 && m <= 12) parts.push(t('calendar.recurrence.in_month', 'in {month}', { month: monthName(m, locale) }));
    }
    const nthDay = getNthDay(rule);
    if (nthDay) {
      parts.push(t('calendar.recurrence.on_the_nth', 'on the {nth} {day}', {
        nth: nthLabel(nthDay.nth, t),
        day: weekdayName(nthDay.day, 'long', locale),
      }));
    } else if (rule.byMonthDay?.length) {
      parts.push(t('calendar.recurrence.on_day_n', 'on day {day}', { day: rule.byMonthDay[0] }));
    }
  }

  const summary = parts.join(' ');
  const end = recurrenceEndLabel(rule, t, locale);
  return end ? `${summary} · ${end}` : summary;
}

export interface RecurrenceEditorValue {
  frequency: EditorFrequency;
  interval: number;
  weekDays: string[];
  monthlyMode: MonthlyMode;
  monthDay: number;
  nth: number;
  nthDay: string;
  month: number;
  endsMode: EndsMode;
  untilDate: string; // yyyy-MM-dd
  count: number;
}

/** Build the editor's initial state from an existing rule (or defaults). */
export function editorValueFromRule(
  rule: RecurrenceRule | null,
  eventStart: Date,
): RecurrenceEditorValue {
  const startDay = INDEX_TO_DAY[eventStart.getDay()];
  const nthDayInfo = rule ? getNthDay(rule) : null;

  const weekDays = (() => {
    if (rule?.frequency === 'weekly' && rule.byDay?.length) {
      const days = rule.byDay.map((d) => d.day).filter((d) => WEEKDAYS.includes(d));
      if (days.length) return days;
    }
    return [startDay];
  })();

  const monthFromRule = rule?.byMonth?.length ? parseInt(rule.byMonth[0], 10) : NaN;
  const untilFromRule = (() => {
    if (rule?.until) {
      const d = new Date(rule.until);
      if (!isNaN(d.getTime())) return format(d, 'yyyy-MM-dd');
    }
    const inAYear = new Date(eventStart);
    inAYear.setFullYear(inAYear.getFullYear() + 1);
    return format(inAYear, 'yyyy-MM-dd');
  })();

  return {
    frequency: rule && (EDITOR_FREQUENCIES as string[]).includes(rule.frequency)
      ? (rule.frequency as EditorFrequency)
      : 'weekly',
    interval: rule?.interval || 1,
    weekDays,
    monthlyMode: nthDayInfo ? 'nth' : 'day',
    monthDay: rule?.byMonthDay?.[0] && rule.byMonthDay[0] >= 1 && rule.byMonthDay[0] <= 31
      ? rule.byMonthDay[0]
      : eventStart.getDate(),
    nth: nthDayInfo && (nthDayInfo.nth === -1 || (nthDayInfo.nth >= 1 && nthDayInfo.nth <= 4))
      ? nthDayInfo.nth
      : Math.min(4, Math.floor((eventStart.getDate() - 1) / 7) + 1),
    nthDay: nthDayInfo && WEEKDAYS.includes(nthDayInfo.day) ? nthDayInfo.day : startDay,
    month: monthFromRule >= 1 && monthFromRule <= 12 ? monthFromRule : eventStart.getMonth() + 1,
    endsMode: rule?.count ? 'after' : rule?.until ? 'on' : 'never',
    untilDate: untilFromRule,
    count: rule?.count ?? 12,
  };
}

/** Build the JSCalendar rule the editor state describes. */
export function buildRuleFromEditorValue(
  value: RecurrenceEditorValue,
  eventStart: Date,
): RecurrenceRule {
  const startDay = INDEX_TO_DAY[eventStart.getDay()];
  const built: RecurrenceRule = {
    '@type': 'RecurrenceRule',
    frequency: value.frequency,
    interval: Math.max(1, value.interval),
    // No rscale/skip: Stalwart serialises them into the RRULE as
    // RSCALE=GREGORIAN;SKIP=OMIT, which DAVx5 rejects and which breaks
    // Android CalDAV sync for the whole calendar (#805).
    firstDayOfWeek: 'mo',
  };

  if (value.endsMode === 'after') {
    built.count = Math.max(1, value.count);
  } else if (value.endsMode === 'on' && value.untilDate) {
    built.until = `${value.untilDate}T23:59:59`;
  }

  if (value.frequency === 'weekly') {
    const days = value.weekDays.length ? value.weekDays : [startDay];
    built.byDay = WEEKDAYS.filter((d) => days.includes(d)).map((day) => ({ day }));
  } else if (value.frequency === 'monthly' || value.frequency === 'yearly') {
    if (value.monthlyMode === 'nth') {
      built.byDay = [{ day: value.nthDay, nthOfPeriod: value.nth }];
    } else {
      built.byMonthDay = [Math.min(31, Math.max(1, value.monthDay))];
    }
    if (value.frequency === 'yearly') {
      built.byMonth = [String(value.month)];
    }
  }

  return built;
}
