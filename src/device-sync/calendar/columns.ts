/**
 * What the calendar planner reads and writes on each CalendarContract row,
 * how a cell compares to another (an app's `''` is the provider's NULL, a
 * `P3600S` is a `PT1H`) and the baseline format in SYNC_DATA4
 * (docs/device-sync.md, "Calendar columns" and "Baselines").
 */
import { Attendees, Calendars, Events, Reminders } from '../android-columns';
import type { Cell, Row } from '../types';
import type { EventBaseline } from '../planner';
import { parseJsonColumn, utf8 } from '../common/json';
import { sha256Hex } from '../../lib/sha256';
import { canonicalRRule } from './rrule';
import { exdateSet } from './exdate';
import { durationTextSeconds } from './duration';

/** Calendars.CAN_PARTIALLY_UPDATE, re-exported for the calendar modules. */
export const CAN_PARTIALLY_UPDATE = Calendars.CAN_PARTIALLY_UPDATE;

export const CALENDAR_COLUMNS = [
  Calendars._ID,
  Calendars._SYNC_ID,
  Calendars.NAME,
  Calendars.CALENDAR_DISPLAY_NAME,
  Calendars.CALENDAR_COLOR,
  Calendars.CALENDAR_ACCESS_LEVEL,
  Calendars.OWNER_ACCOUNT,
  Calendars.VISIBLE,
  Calendars.SYNC_EVENTS,
  Calendars.CALENDAR_TIME_ZONE,
  Calendars.ALLOWED_REMINDERS,
  Calendars.ALLOWED_AVAILABILITY,
  Calendars.ALLOWED_ATTENDEE_TYPES,
  Calendars.MAX_REMINDERS,
  Calendars.CAN_ORGANIZER_RESPOND,
  CAN_PARTIALLY_UPDATE,
  Calendars.CAL_SYNC2,
  Calendars.CAL_SYNC3,
] as const;

/** Event columns that map to JSCalendar (a master's projection). */
export const MASTER_CELLS = [
  Events.CALENDAR_ID,
  Events.TITLE,
  Events.DESCRIPTION,
  Events.EVENT_LOCATION,
  Events.STATUS,
  Events.AVAILABILITY,
  Events.ACCESS_LEVEL,
  Events.EVENT_COLOR,
  Events.ORGANIZER,
  Events.DTSTART,
  Events.DTEND,
  Events.DURATION,
  Events.EVENT_TIMEZONE,
  Events.ALL_DAY,
  Events.RRULE,
  Events.EXDATE,
] as const;

/** An exception row's projection: no rule of its own, plus the instance it replaces. */
export const EXCEPTION_CELLS = [
  Events.CALENDAR_ID,
  Events.TITLE,
  Events.DESCRIPTION,
  Events.EVENT_LOCATION,
  Events.STATUS,
  Events.AVAILABILITY,
  Events.ACCESS_LEVEL,
  Events.EVENT_COLOR,
  Events.ORGANIZER,
  Events.DTSTART,
  Events.DTEND,
  Events.DURATION,
  Events.EVENT_TIMEZONE,
  Events.ALL_DAY,
  Events.ORIGINAL_INSTANCE_TIME,
  Events.ORIGINAL_ALL_DAY,
] as const;

/** Read but never part of a projection: identity, sync state and provider-computed columns. */
const EVENT_EXTRA_COLUMNS = [
  Events._ID,
  Events._SYNC_ID,
  Events.DIRTY,
  Events.DELETED,
  Events.MUTATORS,
  Events.SYNC_DATA1,
  Events.SYNC_DATA2,
  Events.SYNC_DATA3,
  Events.SYNC_DATA4,
  Events.SYNC_DATA5,
  Events.UID_2445,
  Events.HAS_ATTENDEE_DATA,
  Events.RDATE,
  Events.EXRULE,
  Events.LAST_DATE,
  Events.ORIGINAL_ID,
  Events.ORIGINAL_SYNC_ID,
] as const;

export const EVENT_COLUMNS = [...new Set<string>([...EVENT_EXTRA_COLUMNS, ...MASTER_CELLS, ...EXCEPTION_CELLS])];

export const ATTENDEE_CELLS = [
  Attendees.ATTENDEE_EMAIL,
  Attendees.ATTENDEE_NAME,
  Attendees.ATTENDEE_RELATIONSHIP,
  Attendees.ATTENDEE_TYPE,
  Attendees.ATTENDEE_STATUS,
] as const;
export const ATTENDEE_COLUMNS = [Attendees._ID, Attendees.EVENT_ID, ...ATTENDEE_CELLS];

export const REMINDER_CELLS = [Reminders.MINUTES, Reminders.METHOD] as const;
export const REMINDER_COLUMNS = [Reminders._ID, Reminders.EVENT_ID, ...REMINDER_CELLS];

// ─── Cells ──────────────────────────────────────────────

const TEXT_COLUMNS = new Set<string>([
  Events.TITLE,
  Events.DESCRIPTION,
  Events.EVENT_LOCATION,
  Events.ORGANIZER,
  Events.EVENT_TIMEZONE,
  Attendees.ATTENDEE_EMAIL,
  Attendees.ATTENDEE_NAME,
]);

/** A cell as the bridge may hand it back: numbers stay numbers, `''` and NULL are one value for text. */
export function normalCell(column: string, value: unknown): Cell {
  if (value === undefined || value === null) return TEXT_COLUMNS.has(column) ? '' : null;
  if (TEXT_COLUMNS.has(column)) return String(value);
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(value.trim()) ? n : value;
  }
  return null;
}

/** Whether two values of a column mean the same, the way device sync reads them. */
export function sameCell(column: string, a: unknown, b: unknown): boolean {
  if (column === Events.DURATION) {
    const sa = durationTextSeconds(a);
    const sb = durationTextSeconds(b);
    if (sa !== null || sb !== null) return sa === sb;
    return empty(a) === empty(b);
  }
  if (column === Events.RRULE) return canonicalRRule(a) === canonicalRRule(b);
  if (column === Events.EXDATE) return sameSet(exdateSet(a), exdateSet(b));
  if (column === Events.ALL_DAY || column === Events.ORIGINAL_ALL_DAY) return truthy(a) === truthy(b);
  if (isHashed(a) || isHashed(b)) return textDigest(a) === textDigest(b);
  return normalCell(column, a) === normalCell(column, b);
}

const empty = (v: unknown) => v === null || v === undefined || v === '';
const truthy = (v: unknown) => Number(v ?? 0) === 1;

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

// ─── Long text in baselines ─────────────────────────────

const HASH_PREFIX = 'sha256:';
const TRUNCATED_PREFIX = 'truncated:';
const LONG_TEXT_BYTES = 1024;

/** The largest description written to a row; longer ones are cut, marked in the baseline and never uploaded. */
export const DESCRIPTION_LIMIT_BYTES = 65_536;

function isHashed(v: unknown): boolean {
  return typeof v === 'string' && (v.startsWith(HASH_PREFIX) || v.startsWith(TRUNCATED_PREFIX + HASH_PREFIX));
}

/** Text over 1 KB as `sha256:<hex>`, anything else unchanged. */
export function baselineText(value: string): string {
  return utf8(value).length > LONG_TEXT_BYTES ? HASH_PREFIX + sha256Hex(utf8(value)) : value;
}

/** A truncated description's baseline: its hash, marked so a later edit is never uploaded. */
export function truncatedBaseline(value: string): string {
  return TRUNCATED_PREFIX + HASH_PREFIX + sha256Hex(utf8(value));
}

export function isTruncatedBaseline(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(TRUNCATED_PREFIX);
}

/** What a text cell or its baseline form is compared by: the hash for hashed or long text. */
function textDigest(v: unknown): string {
  if (typeof v !== 'string') return empty(v) ? '' : String(v);
  if (v.startsWith(TRUNCATED_PREFIX)) return v.slice(TRUNCATED_PREFIX.length);
  if (v.startsWith(HASH_PREFIX)) return v;
  return utf8(v).length > LONG_TEXT_BYTES ? HASH_PREFIX + sha256Hex(utf8(v)) : v;
}

/** Cuts text to at most `limit` UTF-8 bytes without splitting a character. */
export function truncateUtf8(text: string, limit = DESCRIPTION_LIMIT_BYTES): { text: string; truncated: boolean } {
  if (utf8(text).length <= limit) return { text, truncated: false };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8(text.slice(0, mid)).length <= limit) lo = mid;
    else hi = mid - 1;
  }
  let end = lo;
  // Never end on the first half of a surrogate pair.
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

// ─── Baselines (SYNC_DATA4) ─────────────────────────────

/**
 * The columns of a row, each in its normal form (numbers as numbers even when
 * the provider handed them back as text), so a read-back never differs from
 * a baseline by type alone.
 */
function normalRow(row: Row, columns: readonly string[]): Row {
  const out: Row = {};
  for (const c of columns) {
    const v = row[c] ?? null;
    out[c] = v === null || TEXT_COLUMNS.has(c) || typeof v !== 'string' ? v : normalCell(c, v);
  }
  return out;
}

/** A baseline from cells as stored: normal forms, long text hashed, a truncated description marked. */
export function makeBaseline(
  cells: Row,
  columns: readonly string[],
  attendees: Row[],
  reminders: Row[],
  truncatedDescription = false,
): EventBaseline {
  const out = normalRow(cells, columns);
  for (const c of columns) {
    const v = out[c];
    if (c === Events.DESCRIPTION && truncatedDescription && typeof v === 'string') out[c] = truncatedBaseline(v);
    else if (typeof v === 'string' && !isHashed(v)) out[c] = baselineText(v);
  }
  return {
    cells: out,
    attendees: attendees.map((a) => normalRow(a, ATTENDEE_CELLS)),
    reminders: reminders.map((r) => normalRow(r, REMINDER_CELLS)),
  };
}

export function encodeBaseline(baseline: EventBaseline): string {
  return JSON.stringify({ v: 1, ...baseline });
}

/** SYNC_DATA4 read defensively: another app may have written anything there. */
export function decodeBaseline(text: unknown): EventBaseline | null {
  const parsed = parseJsonColumn<Record<string, unknown>>(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const cells = parsed.cells;
  if (!cells || typeof cells !== 'object' || Array.isArray(cells)) return null;
  const rows = (v: unknown): Row[] =>
    Array.isArray(v) ? v.filter((r): r is Row => !!r && typeof r === 'object' && !Array.isArray(r)) : [];
  return { cells: cells as Row, attendees: rows(parsed.attendees), reminders: rows(parsed.reminders) };
}
