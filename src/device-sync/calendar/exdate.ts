/**
 * The EXDATE column ↔ excluded recurrence overrides (docs/device-sync.md,
 * "Recurrence"). AOSP's RecurrenceSet reads lines split by `\n`, each
 * `[<tzid>;]<date>[,<date>…]` with a bare Olson id as prefix; dates are
 * `YYYYMMDD`, `YYYYMMDDTHHMMSS` or `…Z`, and a line without a prefix is UTC,
 * not the event's zone. Device sync writes one line without a prefix: UTC
 * date-times for timed events, dates for all-day ones.
 */
import {
  canonicalZone,
  dateToUtcMidnight,
  formatDate,
  localToUtc,
  resolveWallClock,
  utcMidnightToDate,
  utcToLocal,
  wallFromMs,
  type WallClock,
} from './zoned-time';
import type { RuleZone } from './rrule';

const compactUtc = (utc: number) => {
  const w = wallFromMs(utc);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${formatDate(w).replace(/-/g, '')}T${p(w.hour)}${p(w.minute)}${p(w.second)}Z`;
};

/** One EXDATE entry for a recurrence id (a LocalDateTime in the event's zone). */
export function exdateEntry(key: string, ctx: RuleZone): string | null {
  if (ctx.allDay) {
    const midnight = dateToUtcMidnight(key);
    return midnight === null ? null : formatDate(wallFromMs(midnight)).replace(/-/g, '');
  }
  const utc = localToUtc(key, ctx.zone);
  return utc === null ? null : compactUtc(utc);
}

/** The EXDATE column for a set of recurrence ids, sorted; null for none. */
export function formatExdate(keys: Iterable<string>, ctx: RuleZone): string | null {
  const entries = [...new Set([...keys].map((k) => exdateEntry(k, ctx)).filter((e): e is string => !!e))].sort();
  return entries.length ? entries.join(',') : null;
}

interface ParsedEntry {
  /** The instant (timed) or UTC midnight of the date. */
  utc: number;
  dateOnly: boolean;
}

function parseEntry(text: string, zone: string | null): ParsedEntry | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/i.exec(text.trim());
  if (!m) return null;
  const wall: WallClock = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4] ?? 0),
    minute: Number(m[5] ?? 0),
    second: Number(m[6] ?? 0),
  };
  const dateOnly = m[4] === undefined;
  if (m[7] || !zone) return { utc: resolveWallClock(wall, 'UTC').utc, dateOnly };
  return { utc: resolveWallClock(wall, zone).utc, dateOnly };
}

/** Every entry of an EXDATE (or RDATE) column as an instant; garbage is skipped. */
export function exdateInstants(text: unknown): ParsedEntry[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const out: ParsedEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const semi = line.indexOf(';');
    const zone = semi >= 0 ? canonicalZone(line.slice(0, semi).trim()) : null;
    const dates = semi >= 0 ? line.slice(semi + 1) : line;
    for (const d of dates.split(',')) {
      const entry = parseEntry(d, zone);
      if (entry) out.push(entry);
    }
  }
  return out;
}

/**
 * The recurrence ids an EXDATE column excludes, in the event's zone
 * (all-day: the date at midnight). A timed entry's key is its instant in the
 * zone; a date-only entry of a timed event is AOSP's UTC midnight of it.
 */
export function parseExdate(text: unknown, ctx: RuleZone): string[] {
  const keys = new Set<string>();
  for (const entry of exdateInstants(text)) {
    keys.add(ctx.allDay ? utcMidnightToDate(entry.utc) : utcToLocal(entry.utc, ctx.zone));
  }
  return [...keys].sort();
}

/**
 * The entries as a set of normalised instants (`YYYYMMDDTHHMMSSZ`, or
 * `YYYYMMDD` for dates and for every entry of an all-day event): the
 * column's meaning independent of how an app spelled it.
 */
export function exdateSet(text: unknown, allDay = false): Set<string> {
  const out = new Set<string>();
  for (const entry of exdateInstants(text)) {
    out.add(entry.dateOnly || allDay ? formatDate(wallFromMs(entry.utc)).replace(/-/g, '') : compactUtc(entry.utc));
  }
  return out;
}

/** The recurrence id of one normalised entry (see `exdateSet`). */
export function exdateEntryKey(entry: string, ctx: RuleZone): string | null {
  const parsed = parseEntry(entry, null);
  if (!parsed) return null;
  return ctx.allDay ? utcMidnightToDate(parsed.utc) : utcToLocal(parsed.utc, ctx.zone);
}
