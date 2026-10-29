/**
 * JSCalendar `recurrenceRule` ↔ the RRULE column (docs/device-sync.md,
 * "Recurrence").
 *
 * AOSP's EventRecurrence rejects every part it does not know except `X-…`,
 * so RSCALE and SKIP are never written (the #805 failure); a rule that needs
 * them (a non-Gregorian `rscale`, a `skip` other than `omit`, a leap month
 * such as `5L`) is written without them and reported as not representable.
 * UNTIL is UTC (`…Z`) for timed events and a DATE for all-day ones, because
 * AOSP reads a floating UNTIL as UTC anyway. Rules written by device apps
 * are read tolerantly: any case, an `RRULE:` prefix, `X-` parts, UNTIL as a
 * DATE, a floating or a UTC date-time (Etar writes UTC date-times even for
 * all-day events), COUNT together with UNTIL.
 */
import type { RecurrenceRule } from '../../api/types';
import {
  canonicalZone,
  dateToUtcMidnight,
  formatDate,
  localToUtc,
  parseLocalDateTime,
  utcToLocal,
  wallFromMs,
  wallMs,
  type WallClock,
} from './zoned-time';

export interface RuleZone {
  allDay: boolean;
  /** The event's zone for timed events (the device zone for floating ones). */
  zone: string;
}

const FREQUENCIES = ['yearly', 'monthly', 'weekly', 'daily', 'hourly', 'minutely', 'secondly'];
const WEEKDAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];

/** Parts EventRecurrence knows, in the order they are written. */
const PART_ORDER = [
  'FREQ', 'UNTIL', 'COUNT', 'INTERVAL', 'BYSECOND', 'BYMINUTE', 'BYHOUR', 'BYDAY', 'BYMONTHDAY',
  'BYYEARDAY', 'BYWEEKNO', 'BYMONTH', 'BYSETPOS', 'WKST',
] as const;
const KNOWN_PARTS = new Set<string>(PART_ORDER);

/** Why a rule can only be shown approximately; empty when it is representable. */
export function unrepresentableParts(rule: RecurrenceRule | null | undefined): string[] {
  if (!rule) return [];
  const out: string[] = [];
  if (rule.rscale && rule.rscale.toLowerCase() !== 'gregorian') out.push('rscale');
  if (rule.skip && rule.skip.toLowerCase() !== 'omit') out.push('skip');
  if ((rule.byMonth ?? []).some((m) => /l$/i.test(String(m)))) out.push('byMonth');
  if (!FREQUENCIES.includes(String(rule.frequency ?? '').toLowerCase())) out.push('frequency');
  return out;
}

export function isRuleRepresentable(rule: RecurrenceRule | null | undefined): boolean {
  return unrepresentableParts(rule).length === 0;
}

const ints = (list: unknown): number[] =>
  Array.isArray(list) ? list.filter((n): n is number => Number.isInteger(n)) : [];

/**
 * The RRULE column for a rule, or null when it cannot be written at all (no
 * known frequency). Unrepresentable parts are left out (see the header).
 */
export function ruleToRRule(rule: RecurrenceRule | null | undefined, ctx: RuleZone): string | null {
  if (!rule) return null;
  const freq = String(rule.frequency ?? '').toLowerCase();
  if (!FREQUENCIES.includes(freq)) return null;
  const parts: Array<[string, string]> = [['FREQ', freq.toUpperCase()]];
  if (Number.isInteger(rule.count) && (rule.count as number) > 0) {
    parts.push(['COUNT', String(rule.count)]);
  } else if (rule.until) {
    const until = formatUntil(rule.until, ctx);
    if (until) parts.push(['UNTIL', until]);
  }
  if (Number.isInteger(rule.interval) && (rule.interval as number) > 1) parts.push(['INTERVAL', String(rule.interval)]);
  const list = (name: string, values: Array<string | number>) => {
    if (values.length) parts.push([name, values.join(',')]);
  };
  list('BYSECOND', ints(rule.bySecond));
  list('BYMINUTE', ints(rule.byMinute));
  list('BYHOUR', ints(rule.byHour));
  list(
    'BYDAY',
    (rule.byDay ?? [])
      .filter((d) => d && WEEKDAYS.includes(String(d.day).toLowerCase()))
      .map((d) => `${Number.isInteger(d.nthOfPeriod) && d.nthOfPeriod !== 0 ? d.nthOfPeriod : ''}${String(d.day).toUpperCase()}`),
  );
  list('BYMONTHDAY', ints(rule.byMonthDay));
  list('BYYEARDAY', ints(rule.byYearDay));
  list('BYWEEKNO', ints(rule.byWeekNo));
  list('BYMONTH', (rule.byMonth ?? []).map(String).filter((m) => /^\d{1,2}$/.test(m)).map(Number));
  list('BYSETPOS', ints(rule.bySetPosition));
  const wkst = String(rule.firstDayOfWeek ?? '').toLowerCase();
  if (WEEKDAYS.includes(wkst) && wkst !== 'mo') parts.push(['WKST', wkst.toUpperCase()]);
  return parts.map(([k, v]) => `${k}=${v}`).join(';');
}

const compact = (w: WallClock, withTime: boolean) => {
  const date = formatDate(w).replace(/-/g, '');
  if (!withTime) return date;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date}T${p(w.hour)}${p(w.minute)}${p(w.second)}`;
};

/** UNTIL: the date for all-day rules, else the instant of the LocalDateTime in the event's zone, in UTC. */
export function formatUntil(until: string, ctx: RuleZone): string | null {
  const wall = parseLocalDateTime(until);
  if (!wall) return null;
  if (ctx.allDay) return compact(wall, false);
  const utc = localToUtc(until, ctx.zone);
  return utc === null ? null : `${compact(wallFromMs(utc), true)}Z`;
}

/**
 * The instant an UNTIL value stands for, the way AOSP's RecurrenceProcessor
 * reads it: a DATE is midnight UTC, a floating date-time is UTC as well.
 */
export function untilInstant(value: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/i.exec(value.trim());
  if (!m) return null;
  return wallMs({
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4] ?? 0),
    minute: Number(m[5] ?? 0),
    second: Number(m[6] ?? 0),
  });
}

/** UNTIL as JSCalendar's LocalDateTime: the UTC date for all-day rules, the instant in the event's zone otherwise. */
export function parseUntil(value: string, ctx: RuleZone): string | null {
  const utc = untilInstant(value);
  if (utc === null) return null;
  if (ctx.allDay) return `${formatDate(wallFromMs(utc))}T00:00:00`;
  return utcToLocal(utc, canonicalZone(ctx.zone) ?? 'UTC');
}

/**
 * The parts of an RRULE column as a map (upper-case names and values), from
 * its first rule, or null when there is no rule. `X-` parts are dropped and
 * so are names EventRecurrence would reject.
 */
export function rruleParts(text: unknown): Map<string, string> | null {
  if (typeof text !== 'string') return null;
  const first = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!first) return null;
  const parts = new Map<string, string>();
  for (const raw of first.replace(/^RRULE:/i, '').split(';')) {
    const eq = raw.indexOf('=');
    if (eq <= 0) continue;
    const name = raw.slice(0, eq).trim().toUpperCase();
    if (name.startsWith('X-') || !KNOWN_PARTS.has(name) || parts.has(name)) continue;
    parts.set(name, raw.slice(eq + 1).trim().toUpperCase());
  }
  return parts.has('FREQ') ? parts : null;
}

/**
 * A comparable form of an RRULE column: parts in a fixed order, list values
 * sorted, defaults (INTERVAL=1, WKST=MO) dropped. Two texts with the same
 * meaning compare equal, so an app that rewrites a rule unchanged (Fossify
 * rebuilds it on every save) is not an edit. Empty for no rule.
 */
export function canonicalRRule(text: unknown): string {
  const parts = rruleParts(text);
  if (!parts) return '';
  if (parts.get('INTERVAL') === '1') parts.delete('INTERVAL');
  if (parts.get('WKST') === 'MO') parts.delete('WKST');
  return PART_ORDER.filter((p) => parts.has(p))
    .map((p) => {
      const v = parts.get(p)!;
      return `${p}=${p.startsWith('BY') ? v.split(',').sort().join(',') : v}`;
    })
    .join(';');
}

const numberList = (v: string | undefined) =>
  v === undefined ? [] : v.split(',').map((n) => Number(n)).filter((n) => Number.isInteger(n));

/**
 * A rule from an RRULE column, or null when there is none or its FREQ is
 * unknown. A COUNT wins over an UNTIL next to it (RFC 5545 forbids both;
 * AOSP only warns).
 */
export function rruleToRule(text: unknown, ctx: RuleZone): RecurrenceRule | null {
  const parts = rruleParts(text);
  if (!parts) return null;
  return partsToRule(parts, ctx);
}

export function partsToRule(parts: Map<string, string>, ctx: RuleZone): RecurrenceRule | null {
  const frequency = (parts.get('FREQ') ?? '').toLowerCase();
  if (!FREQUENCIES.includes(frequency)) return null;
  const rule: RecurrenceRule = { frequency };
  const interval = Number(parts.get('INTERVAL'));
  if (Number.isInteger(interval) && interval > 1) rule.interval = interval;
  const count = Number(parts.get('COUNT'));
  if (parts.has('COUNT') && Number.isInteger(count) && count > 0) {
    rule.count = count;
  } else if (parts.has('UNTIL')) {
    const until = parseUntil(parts.get('UNTIL')!, ctx);
    if (until) rule.until = until;
  }
  const byDay = (parts.get('BYDAY') ?? '')
    .split(',')
    .map((d) => /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(d.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => (m[1] && Number(m[1]) !== 0 ? { day: m[2].toLowerCase(), nthOfPeriod: Number(m[1]) } : { day: m[2].toLowerCase() }));
  if (byDay.length) rule.byDay = byDay;
  const lists: Array<[keyof RecurrenceRule, string]> = [
    ['byMonthDay', 'BYMONTHDAY'],
    ['byYearDay', 'BYYEARDAY'],
    ['byWeekNo', 'BYWEEKNO'],
    ['byHour', 'BYHOUR'],
    ['byMinute', 'BYMINUTE'],
    ['bySecond', 'BYSECOND'],
    ['bySetPosition', 'BYSETPOS'],
  ];
  for (const [key, part] of lists) {
    const values = numberList(parts.get(part));
    if (values.length) (rule as unknown as Record<string, unknown>)[key] = values;
  }
  const byMonth = numberList(parts.get('BYMONTH')).filter((m) => m >= 1 && m <= 12).map(String);
  if (byMonth.length) rule.byMonth = byMonth;
  const wkst = (parts.get('WKST') ?? '').toLowerCase();
  if (WEEKDAYS.includes(wkst) && wkst !== 'mo') rule.firstDayOfWeek = wkst;
  return rule;
}

/**
 * Where a rule stops, for pruning overrides after a "this and following"
 * cut: the UNTIL instant, or null when the rule is unbounded or bounded by
 * COUNT (the caller then asks CalendarProvider's LAST_DATE).
 */
export function untilUtc(rule: RecurrenceRule | null | undefined, ctx: RuleZone): number | null {
  if (!rule?.until || rule.count) return null;
  if (ctx.allDay) {
    const midnight = dateToUtcMidnight(rule.until);
    return midnight === null ? null : midnight + 86_399_000;
  }
  return localToUtc(rule.until, ctx.zone);
}
