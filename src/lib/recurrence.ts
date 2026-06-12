/**
 * Custom recurrence rule helpers for the event editor. Mobile port of
 * webmail's components/calendar/recurrence-editor.tsx logic (rule detection,
 * construction, and the human-readable summary).
 */

import { format } from 'date-fns';
import type { RecurrenceRule } from '../api/types';

export type EditorFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type MonthlyMode = 'day' | 'nth';
export type EndsMode = 'never' | 'on' | 'after';

export const EDITOR_FREQUENCIES: EditorFrequency[] = ['daily', 'weekly', 'monthly', 'yearly'];

// JSCalendar weekday ids in display order (week starts Monday, matching the
// firstDayOfWeek the built rules declare).
export const WEEKDAYS: string[] = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
const DAY_TO_REF_DATE: Record<string, number> = { mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6, su: 7 };
export const INDEX_TO_DAY = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

export const UNIT_LABELS: Record<EditorFrequency, string> = {
  daily: 'days',
  weekly: 'weeks',
  monthly: 'months',
  yearly: 'years',
};

// 2024-01-01 is a Monday — used to render weekday names via date-fns.
export function weekdayName(day: string, style: 'long' | 'short' = 'long'): string {
  const ref = new Date(2024, 0, DAY_TO_REF_DATE[day] ?? 1);
  return format(ref, style === 'long' ? 'EEEE' : 'EEE');
}

export function monthName(month: number): string {
  return format(new Date(2024, month - 1, 1), 'LLLL');
}

const NTH_LABELS: Record<number, string> = {
  1: 'first',
  2: 'second',
  3: 'third',
  4: 'fourth',
  [-1]: 'last',
};

export function nthLabel(nth: number): string {
  return NTH_LABELS[nth] ?? String(nth);
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
 * "Every 2 months on the third Thursday · 12 occurrences".
 * Returns null for frequencies the UI cannot describe (hourly etc.).
 */
export function buildRecurrenceSummary(rule: RecurrenceRule): string | null {
  const interval = rule.interval || 1;
  let base: string;
  switch (rule.frequency) {
    case 'daily':
      base = interval > 1 ? `Every ${interval} days` : 'Daily';
      break;
    case 'weekly':
      base = interval > 1 ? `Every ${interval} weeks` : 'Weekly';
      break;
    case 'monthly':
      base = interval > 1 ? `Every ${interval} months` : 'Monthly';
      break;
    case 'yearly':
      base = interval > 1 ? `Every ${interval} years` : 'Yearly';
      break;
    default:
      return null;
  }

  const parts = [base];

  if (rule.frequency === 'weekly' && rule.byDay?.length) {
    const days = rule.byDay
      .filter((d) => WEEKDAYS.includes(d.day))
      .sort((a, b) => WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day))
      .map((d) => weekdayName(d.day, 'short'))
      .join(', ');
    if (days) parts.push(`on ${days}`);
  }

  if (rule.frequency === 'monthly' || rule.frequency === 'yearly') {
    if (rule.frequency === 'yearly' && rule.byMonth?.length) {
      const m = parseInt(rule.byMonth[0], 10);
      if (m >= 1 && m <= 12) parts.push(`in ${monthName(m)}`);
    }
    const nthDay = getNthDay(rule);
    if (nthDay) {
      parts.push(`on the ${nthLabel(nthDay.nth)} ${weekdayName(nthDay.day)}`);
    } else if (rule.byMonthDay?.length) {
      parts.push(`on day ${rule.byMonthDay[0]}`);
    }
  }

  let summary = parts.join(' ');
  if (rule.count) {
    summary += ` · ${rule.count} ${rule.count === 1 ? 'occurrence' : 'occurrences'}`;
  } else if (rule.until) {
    const d = new Date(rule.until);
    if (!isNaN(d.getTime())) {
      summary += ` · until ${format(d, 'MMM d, yyyy')}`;
    }
  }
  return summary;
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
    rscale: 'gregorian',
    skip: 'omit',
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
