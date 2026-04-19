/**
 * Client-side recurrence expansion for JSCalendar events.
 *
 * Implements JSCalendar 2.0 (draft-ietf-calext-jscalendarbis-15) §3.3.3.1
 * recurrence rule interpretation: implicit byX addition, byX filtering,
 * bySetPosition. Mobile port of webmail's lib/recurrence-expansion.ts.
 *
 * Stalwart does not yet support mutations on the synthetic IDs produced by
 * CalendarEvent/query?expandRecurrences=true, so we fetch raw events (with
 * real, mutable IDs) and expand recurring series into individual occurrences
 * on the client.
 */

import { addDays, addMonths, addWeeks, addYears, format, parseISO } from 'date-fns';
import type { CalendarEvent, RecurrenceRule } from '../api/types';

type NDay = { day: string; nthOfPeriod?: number };

const DAY_INDEX: Record<string, number> = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };
const INDEX_TO_DAY: string[] = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

/**
 * Given an event list and a date range, return an array of "virtual" occurrence
 * events. Each occurrence carries a synthetic `id` (for dedup in React) and an
 * `originalId` field that points back to the real server-side ID so the store
 * can use it for mutations.
 *
 * Non-recurring events pass through. For recurring events the master is **not**
 * returned - only expanded instances within the range.
 */
export function expandRecurringEvents(
  events: CalendarEvent[],
  rangeStart: string,
  rangeEnd: string,
): CalendarEvent[] {
  const start = parseISO(rangeStart);
  const end = parseISO(rangeEnd);
  const result: CalendarEvent[] = [];

  // Skip server-returned override instances belonging to a master we already
  // see; the master's recurrenceOverrides covers them.
  const recurringUids = new Set<string>();
  for (const event of events) {
    if (event.recurrenceRules?.length && event.uid && !event.recurrenceId) {
      recurringUids.add(event.uid);
    }
  }

  for (const event of events) {
    if (event.recurrenceId && event.uid && recurringUids.has(event.uid)) continue;

    if (!event.recurrenceRules?.length) {
      result.push(event);
      continue;
    }

    result.push(...expandEvent(event, start, end));
  }

  return result;
}

function expandEvent(
  master: CalendarEvent,
  rangeStart: Date,
  rangeEnd: Date,
): CalendarEvent[] {
  const eventStart = parseISO(master.start);
  if (isNaN(eventStart.getTime())) return [];

  const rules = master.recurrenceRules || [];
  const overrides = master.recurrenceOverrides || {};
  const occurrences: CalendarEvent[] = [];
  const seenDates = new Set<string>();

  for (const rule of rules) {
    const dates = generateDates(eventStart, rule, rangeStart, rangeEnd);
    for (const date of dates) {
      const dateKey = master.showWithoutTime
        ? format(date, 'yyyy-MM-dd')
        : date.toISOString();

      if (seenDates.has(dateKey)) continue;
      seenDates.add(dateKey);

      const recurrenceId = master.showWithoutTime
        ? format(date, "yyyy-MM-dd'T'00:00:00")
        : format(date, "yyyy-MM-dd'T'HH:mm:ss");

      const override = overrides[recurrenceId] as
        | (Partial<CalendarEvent> & { excluded?: boolean })
        | undefined;
      if (override?.excluded) continue;

      occurrences.push(createOccurrence(master, date, recurrenceId, override));
    }
  }

  // RDATE-equivalent: overrides may define dates not produced by any rule.
  for (const [recurrenceId, rawOverride] of Object.entries(overrides)) {
    const override = rawOverride as Partial<CalendarEvent> & { excluded?: boolean };
    if (override.excluded) continue;
    const overrideDate = parseISO(recurrenceId);
    if (isNaN(overrideDate.getTime())) continue;
    if (overrideDate < rangeStart || overrideDate >= rangeEnd) continue;

    const dateKey = master.showWithoutTime
      ? format(overrideDate, 'yyyy-MM-dd')
      : overrideDate.toISOString();
    if (seenDates.has(dateKey)) continue;
    seenDates.add(dateKey);

    occurrences.push(createOccurrence(master, overrideDate, recurrenceId, override));
  }

  return occurrences;
}

function createOccurrence(
  master: CalendarEvent,
  date: Date,
  recurrenceId: string,
  override?: Partial<CalendarEvent>,
): CalendarEvent {
  const startStr = master.showWithoutTime
    ? format(date, "yyyy-MM-dd'T'00:00:00")
    : format(date, "yyyy-MM-dd'T'HH:mm:ss");

  // Compute utcStart/utcEnd for this occurrence so getEventStartDate /
  // getEventEndDate return the occurrence times rather than the master's.
  let utcStart: string | undefined;
  let utcEnd: string | undefined;
  if (!master.showWithoutTime && master.utcStart && master.start) {
    const masterLocal = parseISO(master.start);
    const masterUtc = parseISO(master.utcStart);
    const offsetMs = masterUtc.getTime() - masterLocal.getTime();
    utcStart = new Date(date.getTime() + offsetMs).toISOString();

    if (master.utcEnd) {
      const masterUtcEnd = parseISO(master.utcEnd);
      const durationMs = masterUtcEnd.getTime() - masterUtc.getTime();
      utcEnd = new Date(date.getTime() + offsetMs + durationMs).toISOString();
    }
  }

  return {
    ...master,
    ...(override || {}),
    id: `${master.id}:${recurrenceId}`,
    originalId: master.originalId || master.id,
    uid: master.uid,
    calendarIds: master.calendarIds,
    start: override?.start || startStr,
    ...(utcStart && !override?.utcStart ? { utcStart } : {}),
    ...(utcEnd && !override?.utcEnd ? { utcEnd } : {}),
    recurrenceId,
    recurrenceRules: master.recurrenceRules,
    recurrenceOverrides: master.recurrenceOverrides,
    excludedRecurrenceRules: master.excludedRecurrenceRules,
  };
}

// ─── §3.3.3.1 - Implicit byX property addition ──────────
function addImplicitByX(rule: RecurrenceRule, eventStart: Date): RecurrenceRule {
  const r: RecurrenceRule = { ...rule };
  const freq = r.frequency;

  if (freq !== 'secondly' && !r.bySecond?.length) {
    r.bySecond = [eventStart.getSeconds()];
  }
  if (freq !== 'secondly' && freq !== 'minutely' && !r.byMinute?.length) {
    r.byMinute = [eventStart.getMinutes()];
  }
  if (
    freq !== 'secondly' && freq !== 'minutely' && freq !== 'hourly' && !r.byHour?.length
  ) {
    r.byHour = [eventStart.getHours()];
  }
  if (freq === 'weekly' && !r.byDay?.length) {
    r.byDay = [{ day: INDEX_TO_DAY[eventStart.getDay()] }];
  }
  if (freq === 'monthly' && !r.byDay?.length && !r.byMonthDay?.length) {
    r.byMonthDay = [eventStart.getDate()];
  }
  if (freq === 'yearly' && !r.byYearDay?.length) {
    if (
      !r.byMonth?.length
      && !r.byWeekNo?.length
      && (r.byMonthDay?.length || !r.byDay?.length)
    ) {
      r.byMonth = [String(eventStart.getMonth() + 1)];
    }
    if (!r.byMonthDay?.length && !r.byWeekNo?.length && !r.byDay?.length) {
      r.byMonthDay = [eventStart.getDate()];
    }
    if (r.byWeekNo?.length && !r.byMonthDay?.length && !r.byDay?.length) {
      r.byDay = [{ day: INDEX_TO_DAY[eventStart.getDay()] }];
    }
  }

  return r;
}

// ─── §3.3.3.1 - Generate occurrence dates ───────────────
function generateDates(
  eventStart: Date,
  rawRule: RecurrenceRule,
  rangeStart: Date,
  rangeEnd: Date,
): Date[] {
  const rule = addImplicitByX(rawRule, eventStart);
  const dates: Date[] = [];
  const interval = rule.interval || 1;
  const countLimit = rule.count || Infinity;
  const until = rule.until ? parseISO(rule.until) : null;
  let totalCount = 0;
  let current = new Date(eventStart);

  const maxIterations = 2000;
  const maxOccurrences = 500;
  let iterations = 0;

  while (iterations++ < maxIterations) {
    if (totalCount >= countLimit || totalCount >= maxOccurrences) break;
    if (until && current > until) break;
    if (
      current >= rangeEnd
      && rule.frequency !== 'yearly'
      && rule.frequency !== 'monthly'
      && rule.frequency !== 'weekly'
    ) break;

    const candidates = generateCandidatesForPeriod(current, rule, eventStart);

    const filtered = rule.bySetPosition?.length
      ? applyBySetPosition(candidates, rule.bySetPosition)
      : candidates;

    for (const d of filtered) {
      if (until && d > until) break;
      if (totalCount >= countLimit || totalCount >= maxOccurrences) break;

      // Spec rule 4: eliminate dates before event start
      if (d < eventStart) continue;

      totalCount++;
      if (d >= rangeStart && d < rangeEnd) {
        dates.push(d);
      }
      if (d >= rangeEnd) break;
    }

    if (totalCount >= countLimit || totalCount >= maxOccurrences) break;

    current = advancePeriod(current, rule.frequency, interval);
    if (current <= eventStart && iterations === 1) {
      current = advancePeriod(eventStart, rule.frequency, interval);
    }
  }

  // Spec rule 1: the start date-time is ALWAYS the first occurrence.
  if (dates.length > 0 && dates[0].getTime() !== eventStart.getTime()) {
    if (eventStart >= rangeStart && eventStart < rangeEnd) {
      if (!dates.some((d) => d.getTime() === eventStart.getTime())) {
        dates.unshift(eventStart);
      }
    }
  }

  return dates;
}

function generateCandidatesForPeriod(
  periodStart: Date,
  rule: RecurrenceRule,
  eventStart: Date,
): Date[] {
  const freq = rule.frequency;
  let candidates: Date[];

  switch (freq) {
    case 'yearly':
      candidates = expandYearly(periodStart, rule, eventStart);
      break;
    case 'monthly':
      candidates = expandMonthly(periodStart, rule, eventStart);
      break;
    case 'weekly':
      candidates = expandWeekly(periodStart, rule, eventStart);
      break;
    case 'daily':
    case 'hourly':
    case 'minutely':
    case 'secondly':
    default:
      candidates = [new Date(periodStart)];
      break;
  }

  candidates = candidates.filter((d) => matchesByX(d, rule));
  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates;
}

function expandYearly(
  periodStart: Date,
  rule: RecurrenceRule,
  eventStart: Date,
): Date[] {
  const year = periodStart.getFullYear();
  const h = eventStart.getHours();
  const m = eventStart.getMinutes();
  const s = eventStart.getSeconds();
  const dates: Date[] = [];

  const months = rule.byMonth?.length
    ? rule.byMonth.map((ms) => parseInt(ms.replace('L', ''), 10) - 1)
    : [eventStart.getMonth()];

  if (rule.byWeekNo?.length) {
    for (const wn of rule.byWeekNo) {
      const weekDates = datesInISOWeek(year, wn);
      dates.push(
        ...weekDates.map((d) => {
          d.setHours(h, m, s, 0);
          return d;
        }),
      );
    }
  } else if (rule.byYearDay?.length) {
    for (const yd of rule.byYearDay) {
      const d = dayOfYear(year, yd);
      if (d) {
        d.setHours(h, m, s, 0);
        dates.push(d);
      }
    }
  } else if (rule.byDay?.length && rule.byMonthDay?.length) {
    for (const mo of months) {
      for (const md of rule.byMonthDay) {
        const d = resolveMonthDay(year, mo, md);
        if (d) {
          d.setHours(h, m, s, 0);
          dates.push(d);
        }
      }
    }
  } else if (rule.byDay?.length) {
    for (const mo of months) {
      const expanded = expandByDayInMonth(year, mo, rule.byDay, h, m, s);
      dates.push(...expanded);
    }
  } else if (rule.byMonthDay?.length) {
    for (const mo of months) {
      for (const md of rule.byMonthDay) {
        const d = resolveMonthDay(year, mo, md);
        if (d) {
          d.setHours(h, m, s, 0);
          dates.push(d);
        }
      }
    }
  } else {
    for (const mo of months) {
      const d = new Date(year, mo, eventStart.getDate(), h, m, s, 0);
      if (d.getMonth() === mo) dates.push(d);
    }
  }

  return dates;
}

function expandMonthly(
  periodStart: Date,
  rule: RecurrenceRule,
  eventStart: Date,
): Date[] {
  const year = periodStart.getFullYear();
  const month = periodStart.getMonth();
  const h = eventStart.getHours();
  const m = eventStart.getMinutes();
  const s = eventStart.getSeconds();
  const dates: Date[] = [];

  if (rule.byDay?.length) {
    dates.push(...expandByDayInMonth(year, month, rule.byDay, h, m, s));
  } else if (rule.byMonthDay?.length) {
    for (const md of rule.byMonthDay) {
      const d = resolveMonthDay(year, month, md);
      if (d) {
        d.setHours(h, m, s, 0);
        dates.push(d);
      }
    }
  } else {
    const d = new Date(year, month, eventStart.getDate(), h, m, s, 0);
    if (d.getMonth() === month) dates.push(d);
  }

  return dates;
}

function expandWeekly(
  periodStart: Date,
  rule: RecurrenceRule,
  eventStart: Date,
): Date[] {
  const dates: Date[] = [];
  const baseDay = periodStart.getDay();

  const byDay = rule.byDay?.length
    ? rule.byDay
    : [{ day: INDEX_TO_DAY[eventStart.getDay()] }];

  for (const { day } of byDay) {
    const targetDay = DAY_INDEX[day];
    if (targetDay === undefined) continue;
    let diff = targetDay - baseDay;
    if (diff < 0) diff += 7;
    const d = addDays(periodStart, diff);
    d.setHours(eventStart.getHours(), eventStart.getMinutes(), eventStart.getSeconds(), 0);
    dates.push(d);
  }

  return dates.sort((a, b) => a.getTime() - b.getTime());
}

function matchesByX(date: Date, rule: RecurrenceRule): boolean {
  if (rule.byMonth?.length) {
    const month = String(date.getMonth() + 1);
    if (!rule.byMonth.some((m) => m.replace('L', '') === month)) return false;
  }
  if (rule.byWeekNo?.length) {
    const wn = getISOWeekNumber(date);
    const weeksInYear = getISOWeeksInYear(date.getFullYear());
    if (!rule.byWeekNo.some((w) => (w > 0 ? w : weeksInYear + 1 + w) === wn)) {
      return false;
    }
  }
  if (rule.byYearDay?.length) {
    const yd = getDayOfYear(date);
    const daysInYear = isLeapYear(date.getFullYear()) ? 366 : 365;
    if (!rule.byYearDay.some((d) => (d > 0 ? d : daysInYear + 1 + d) === yd)) {
      return false;
    }
  }
  if (rule.byMonthDay?.length) {
    const md = date.getDate();
    const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    if (!rule.byMonthDay.some((d) => (d > 0 ? d : daysInMonth + 1 + d) === md)) {
      return false;
    }
  }
  if (rule.byDay?.length) {
    const dayName = INDEX_TO_DAY[date.getDay()];
    const freq = rule.frequency;
    if (
      !rule.byDay.some((nd: NDay) => {
        if (nd.day !== dayName) return false;
        if (nd.nthOfPeriod == null) return true;
        if (freq === 'monthly') {
          return nd.nthOfPeriod === nthWeekdayInMonth(date, nd.nthOfPeriod);
        }
        if (freq === 'yearly') {
          if (rule.byMonth?.length) {
            return nd.nthOfPeriod === nthWeekdayInMonth(date, nd.nthOfPeriod);
          }
          return nd.nthOfPeriod === nthWeekdayInYear(date, nd.nthOfPeriod);
        }
        return true;
      })
    ) return false;
  }
  if (rule.byHour?.length && !rule.byHour.includes(date.getHours())) return false;
  if (rule.byMinute?.length && !rule.byMinute.includes(date.getMinutes())) return false;
  if (rule.bySecond?.length && !rule.bySecond.includes(date.getSeconds())) return false;
  return true;
}

function applyBySetPosition(dates: Date[], positions: number[]): Date[] {
  if (!dates.length) return dates;
  const result: Date[] = [];
  const len = dates.length;
  for (const pos of positions) {
    const idx = pos > 0 ? pos - 1 : len + pos;
    if (idx >= 0 && idx < len) result.push(dates[idx]);
  }
  return result.sort((a, b) => a.getTime() - b.getTime());
}

function advancePeriod(
  date: Date,
  frequency: RecurrenceRule['frequency'],
  interval: number,
): Date {
  switch (frequency) {
    case 'daily':    return addDays(date, interval);
    case 'weekly':   return addWeeks(date, interval);
    case 'monthly':  return addMonths(date, interval);
    case 'yearly':   return addYears(date, interval);
    case 'hourly':   return new Date(date.getTime() + interval * 3600000);
    case 'minutely': return new Date(date.getTime() + interval * 60000);
    case 'secondly': return new Date(date.getTime() + interval * 1000);
    default:         return addDays(date, interval);
  }
}

function expandByDayInMonth(
  year: number,
  month: number,
  byDay: NDay[],
  h: number,
  m: number,
  s: number,
): Date[] {
  const dates: Date[] = [];

  for (const { day, nthOfPeriod } of byDay) {
    const targetDay = DAY_INDEX[day];
    if (targetDay === undefined) continue;

    if (nthOfPeriod != null && nthOfPeriod !== 0) {
      const d = nthWeekdayOfMonth(year, month, targetDay, nthOfPeriod);
      if (d) {
        d.setHours(h, m, s, 0);
        dates.push(d);
      }
    } else {
      let d = new Date(year, month, 1);
      while (d.getDay() !== targetDay) d = addDays(d, 1);
      while (d.getMonth() === month) {
        const occ = new Date(d);
        occ.setHours(h, m, s, 0);
        dates.push(occ);
        d = addDays(d, 7);
      }
    }
  }

  return dates;
}

function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  nth: number,
): Date | null {
  if (nth > 0) {
    let d = new Date(year, month, 1);
    while (d.getDay() !== weekday) d = addDays(d, 1);
    d = addDays(d, (nth - 1) * 7);
    return d.getMonth() === month ? d : null;
  }
  let d = new Date(year, month + 1, 0); // last day of month
  while (d.getDay() !== weekday) d = addDays(d, -1);
  if (nth < -1) d = addDays(d, (nth + 1) * 7);
  return d.getMonth() === month ? d : null;
}

function nthWeekdayInMonth(date: Date, nth: number): number {
  if (nth > 0) {
    return Math.floor((date.getDate() - 1) / 7) + 1;
  }
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return -(Math.floor((daysInMonth - date.getDate()) / 7) + 1);
}

function nthWeekdayInYear(date: Date, nth: number): number {
  const yd = getDayOfYear(date);
  const weekday = date.getDay();
  if (nth > 0) {
    const jan1 = new Date(date.getFullYear(), 0, 1);
    let first = jan1;
    while (first.getDay() !== weekday) first = addDays(first, 1);
    const firstYd = getDayOfYear(first);
    return Math.floor((yd - firstYd) / 7) + 1;
  }
  const dec31 = new Date(date.getFullYear(), 11, 31);
  let last = dec31;
  while (last.getDay() !== weekday) last = addDays(last, -1);
  const lastYd = getDayOfYear(last);
  return -(Math.floor((lastYd - yd) / 7) + 1);
}

function resolveMonthDay(year: number, month: number, day: number): Date | null {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const actualDay = day > 0 ? day : daysInMonth + 1 + day;
  if (actualDay < 1 || actualDay > daysInMonth) return null;
  return new Date(year, month, actualDay);
}

function getDayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  return Math.floor(diff / 86400000);
}

function dayOfYear(year: number, yd: number): Date | null {
  const daysInYear = isLeapYear(year) ? 366 : 365;
  const actual = yd > 0 ? yd : daysInYear + 1 + yd;
  if (actual < 1 || actual > daysInYear) return null;
  return new Date(year, 0, actual);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function getISOWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function getISOWeeksInYear(year: number): number {
  const dec28 = new Date(Date.UTC(year, 11, 28));
  return getISOWeekNumber(dec28);
}

function datesInISOWeek(year: number, weekNo: number): Date[] {
  const weeksInYear = getISOWeeksInYear(year);
  const actual = weekNo > 0 ? weekNo : weeksInYear + 1 + weekNo;
  if (actual < 1 || actual > weeksInYear) return [];

  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const week1Monday = addDays(jan4, 1 - dayOfWeek);
  const targetMonday = addDays(week1Monday, (actual - 1) * 7);

  const dates: Date[] = [];
  for (let i = 0; i < 7; i++) dates.push(addDays(targetMonday, i));
  return dates;
}
