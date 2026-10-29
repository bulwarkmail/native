/**
 * The units changes are detected, merged and uploaded in (docs/device-sync.md,
 * "Units"): groups of related columns, each attendee (by address), the
 * reminder set, and for a master each EXDATE entry. Exception rows are
 * compared with the same units, recursively.
 */
import { Attendees, Events } from '../android-columns';
import type { EventBaseline, LocalEventRow } from '../planner';
import type { Row } from '../types';
import { addressKey, type SelfContext } from './attendees';
import { MASTER_CELLS, EXCEPTION_CELLS, makeBaseline, sameCell } from './columns';
import { exdateSet } from './exdate';
import { sameReminders } from './reminders';
import type { RowImage } from './image';
import { isUnsetStatus } from './values';

export const COLUMN_UNITS: Record<string, readonly string[]> = {
  title: [Events.TITLE],
  description: [Events.DESCRIPTION],
  location: [Events.EVENT_LOCATION],
  timing: [Events.DTSTART, Events.DTEND, Events.DURATION, Events.EVENT_TIMEZONE, Events.ALL_DAY],
  rule: [Events.RRULE],
  status: [Events.STATUS],
  availability: [Events.AVAILABILITY],
  privacy: [Events.ACCESS_LEVEL],
  color: [Events.EVENT_COLOR],
  calendar: [Events.CALENDAR_ID],
};

export const MASTER_COLUMN_UNITS = Object.keys(COLUMN_UNITS);
/** An exception has no rule of its own and lives in its master's calendar. */
export const EXCEPTION_COLUMN_UNITS = MASTER_COLUMN_UNITS.filter((u) => u !== 'rule' && u !== 'calendar');

/** Apps that rewrite what they don't model (docs/device-sync.md, "Lossy calendar editors"). */
const LOSSY_EDITORS = ['org.fossify.calendar', 'com.simplemobiletools.calendar.pro', 'com.simplemobiletools.calendar'];

/** Whether MUTATORS names an editor whose attendee types and rule parts can't be trusted. */
export function isLossyEditor(mutators: string | null | undefined): boolean {
  if (!mutators) return false;
  return mutators.split(',').some((m) => LOSSY_EDITORS.includes(m.trim()));
}

/** One side of a comparison: a row as read, a baseline, or an image. */
export interface Side {
  cells: Row;
  attendees: Row[];
  /** Null: not managed (Bulwark owns reminders). */
  reminders: Row[] | null;
}

export function sideOfRow(row: LocalEventRow): Side {
  return { cells: row.cells, attendees: row.attendees.map((a) => a.cells), reminders: row.reminders.map((r) => r.cells) };
}

export function sideOfBaseline(b: EventBaseline): Side {
  return { cells: b.cells, attendees: b.attendees, reminders: b.reminders };
}

export function sideOfImage(image: RowImage): Side {
  return { cells: image.cells, attendees: image.attendees, reminders: image.reminders };
}

export function baselineOfImage(image: RowImage, isException: boolean): EventBaseline {
  return makeBaseline(
    image.cells,
    isException ? EXCEPTION_CELLS : MASTER_CELLS,
    image.attendees,
    image.reminders ?? [],
    image.truncatedDescription,
  );
}

export function columnUnitDiffers(unit: string, a: Side, b: Side): boolean {
  return (COLUMN_UNITS[unit] ?? []).some((c) => !sameCell(c, a.cells[c], b.cells[c]));
}

/**
 * Whether the device changed a column unit against what it is measured by
 * (the baseline, or the plain instance of a new exception row). A STATUS an
 * app left NULL is no change: it sets no status (`statusFromDevice`).
 */
export function deviceChangedUnit(unit: string, current: Side, reference: Side): boolean {
  if (unit === 'status' && isUnsetStatus(current.cells[Events.STATUS])) return false;
  return columnUnitDiffers(unit, current, reference);
}

/** Attendee rows by address key (the user's aliases are one key). */
export function attendeesByKey(rows: Row[], ctx: SelfContext): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const row of rows) {
    const key = addressKey(row[Attendees.ATTENDEE_EMAIL], ctx);
    if (key && !out.has(key)) out.set(key, row);
  }
  return out;
}

const ATTENDEE_COMPARED = [Attendees.ATTENDEE_NAME, Attendees.ATTENDEE_RELATIONSHIP, Attendees.ATTENDEE_TYPE, Attendees.ATTENDEE_STATUS];
/** What a lossy editor rewrites on every save and so never counts as an edit. */
const LOSSY_IGNORED = new Set<string>([Attendees.ATTENDEE_RELATIONSHIP, Attendees.ATTENDEE_TYPE]);

export function attendeeDiffers(a: Row | undefined, b: Row | undefined, lossy = false): boolean {
  if (!a || !b) return !!a !== !!b;
  return ATTENDEE_COMPARED.some((c) => !(lossy && LOSSY_IGNORED.has(c)) && !sameCell(c, a[c], b[c]));
}

export function remindersDiffer(a: Side, b: Side): boolean {
  if (a.reminders === null || b.reminders === null) return false;
  return !sameReminders(a.reminders, b.reminders);
}

/** EXDATE entries of a side, normalised (see `exdateSet`). */
export function exdateEntries(side: Side): Set<string> {
  return exdateSet(side.cells[Events.EXDATE], Number(side.cells[Events.ALL_DAY] ?? 0) === 1);
}
