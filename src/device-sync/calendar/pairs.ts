/**
 * Deletions and inserts that are one edit (docs/device-sync.md, "Uploads",
 * "Pairs"). Etar moves an event to another calendar, and turns a series into
 * a single event, by deleting the row and inserting a copy. A deleted row
 * and a new row of the same run whose projections match apart from the
 * calendar (or the rule) upload as a patch of the existing object, so its
 * uid, participants and history stay; the new row then takes the old one's
 * identity. Across JMAP accounts nothing pairs: that move is a create in the
 * target account and a destroy in the source.
 */
import { Attendees, Events } from '../android-columns';
import type { CalendarContext, EventBaseline, LocalEvent, LocalEventRow, OpGroup } from '../planner';
import type { Row } from '../types';
import type { CalendarEventWire } from '../wire';
import { exceptionRef, parseObjectRef } from '../common/ids';
import { clone } from '../common/json';
import { applyPatch, type PatchObject } from '../common/patch';
import { isSelfAddress, type SelfContext } from './attendees';
import { EXCEPTION_CELLS, MASTER_CELLS, encodeBaseline, makeBaseline } from './columns';
import { durationTextSeconds } from './duration';
import { isExcluded, overridesOf } from './exceptions';
import { linkedExceptionCount } from './merge';
import { GroupBuilder, assertExceptionCount, assertRow, deleteRow, updateRow } from './rows';
import { rruleParts } from './rrule';
import { sendsSchedulingMessages } from './scheduling';
import { MASTER_COLUMN_UNITS, deviceChangedUnit, exdateEntries, remindersDiffer, sideOfBaseline, sideOfRow } from './units';
import { put } from './upload';
import { isUnsetStatus } from './values';

/** What must be equal for two rows to be one event (the calendar and the rule aside). */
const PAIR_COLUMNS = [
  Events.TITLE,
  Events.DESCRIPTION,
  Events.EVENT_LOCATION,
  Events.STATUS,
  Events.AVAILABILITY,
  Events.ACCESS_LEVEL,
  Events.EVENT_COLOR,
  Events.DTSTART,
  Events.ALL_DAY,
];

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

function lengthMs(cells: Row): number | null {
  const dtstart = num(cells[Events.DTSTART]);
  const dtend = num(cells[Events.DTEND]);
  if (dtstart !== null && dtend !== null) return dtend - dtstart;
  const seconds = durationTextSeconds(cells[Events.DURATION]);
  return seconds === null ? null : seconds * 1000;
}

/**
 * The attendees' addresses, the user's own left out: Etar's copy of a meeting
 * has no row for the user when the user was listed (its editor keeps the
 * owner's row out of its attendee list), and one as the organizer when not.
 */
const attendeeSet = (row: LocalEventRow, self: SelfContext) =>
  row.attendees
    .map((a) => String(a.cells[Attendees.ATTENDEE_EMAIL] ?? '').toLowerCase())
    .filter((email) => !isSelfAddress(email, self))
    .sort()
    .join(',');

export interface PairKind {
  /** The same event in another calendar. */
  move: boolean;
  /** A series turned into a single event. */
  unrecur: boolean;
}

/** How a deleted and a new row are one edit, or null. */
export function pairKind(deleted: LocalEvent, fresh: LocalEvent, self: SelfContext): PairKind | null {
  for (const c of PAIR_COLUMNS) {
    // A copy inserted without STATUS (Google Calendar) says nothing about it.
    if (c === Events.STATUS && (isUnsetStatus(deleted.cells[c]) || isUnsetStatus(fresh.cells[c]))) continue;
    if (String(deleted.cells[c] ?? '') !== String(fresh.cells[c] ?? '')) return null;
  }
  const allDay = Number(fresh.cells[Events.ALL_DAY] ?? 0) === 1;
  if (!allDay && String(deleted.cells[Events.EVENT_TIMEZONE] ?? '') !== String(fresh.cells[Events.EVENT_TIMEZONE] ?? '')) return null;
  if (lengthMs(deleted.cells) !== lengthMs(fresh.cells)) return null;
  if (attendeeSet(deleted, self) !== attendeeSet(fresh, self)) return null;
  const move = deleted.calendarRowId !== fresh.calendarRowId;
  const deletedRule = rruleParts(deleted.cells[Events.RRULE]);
  const freshRule = rruleParts(fresh.cells[Events.RRULE]);
  const unrecur = !!deletedRule && !freshRule;
  if (!unrecur && String(deleted.cells[Events.RRULE] ?? '') !== String(fresh.cells[Events.RRULE] ?? '')) return null;
  return move || unrecur ? { move, unrecur } : null;
}

/** The patch a pair uploads: the calendar membership swapped, the rule and its overrides removed. */
export function pairPatch(
  deleted: LocalEvent,
  fresh: LocalEvent,
  kind: PairKind,
  ctx: CalendarContext,
): { patch: PatchObject; sendSchedulingMessages: boolean } | null {
  const shadow = deleted.shadow;
  if (!parseObjectRef(deleted.syncId) || !shadow) return null;
  const patch: PatchObject = {};
  if (kind.move) {
    const from = ctx.calendarIdOfRow(deleted.calendarRowId);
    const to = ctx.calendarIdOfRow(fresh.calendarRowId);
    if (!from || !to || from.jmapAccountId !== ctx.jmapAccountId || to.jmapAccountId !== ctx.jmapAccountId) return null;
    put(patch, ['calendarIds', from.calendarId], null);
    put(patch, ['calendarIds', to.calendarId], true);
  }
  if (kind.unrecur) {
    put(patch, ['recurrenceRule'], null);
    if (Object.keys(overridesOf(shadow)).length) put(patch, ['recurrenceOverrides'], null);
  }
  // A move alone tells nobody; a series ending its recurrence does.
  const scheduling = kind.unrecur && sendsSchedulingMessages(shadow, { kind: 'update', notifying: true, rsvp: false, addsAttendees: false }, ctx);
  return { patch, sendSchedulingMessages: scheduling };
}

const children = (row: LocalEventRow) => ({ attendees: row.attendees.map((a) => a.cells), reminders: row.reminders.map((r) => r.cells) });

/**
 * The new row's baseline: the old row's (what the server held, as last
 * written) with what the patch changed, the calendar and, for a series turned
 * single, its rule and its timing as a single event. So an edit saved with the
 * move, or made before it, still differs from the baseline and uploads next.
 * Attendee rows are the app's re-insert (Etar writes every attendee it copies
 * as required, without a status), so their details are no edits: they are
 * taken as they are, like the reminders of a row that copied none.
 */
function pairedBaseline(deleted: LocalEvent, fresh: LocalEvent, kind: PairKind, ctx: CalendarContext): EventBaseline {
  const own = makeBaseline(fresh.cells, MASTER_CELLS, children(fresh).attendees, children(fresh).reminders);
  if (!deleted.baseline) return own;
  const next = clone(deleted.baseline);
  next.cells[Events.CALENDAR_ID] = own.cells[Events.CALENDAR_ID];
  next.attendees = own.attendees;
  if (ctx.reminderOwner !== 'device' || !fresh.reminders.length) next.reminders = own.reminders;
  if (kind.unrecur) {
    const start = num(deleted.baseline.cells[Events.DTSTART]);
    const length = lengthMs(deleted.baseline.cells);
    next.cells[Events.DTEND] = start !== null && length !== null ? start + length : own.cells[Events.DTEND];
    next.cells[Events.DURATION] = null;
    next.cells[Events.RRULE] = own.cells[Events.RRULE];
    next.cells[Events.EXDATE] = own.cells[Events.EXDATE];
  }
  return next;
}

/** Whether a master holds a change against `baseline` that an upload would look at. */
function changedSince(row: LocalEventRow, baseline: EventBaseline, ctx: CalendarContext): boolean {
  const cur = sideOfRow(row);
  const bl = sideOfBaseline(baseline);
  if (MASTER_COLUMN_UNITS.some((unit) => deviceChangedUnit(unit, cur, bl))) return true;
  const [now, before] = [exdateEntries(cur), exdateEntries(bl)];
  if (now.size !== before.size || [...now].some((e) => !before.has(e))) return true;
  return ctx.reminderOwner === 'device' && remindersDiffer(cur, bl);
}

/**
 * Applied once the pair's patch is accepted: the new row takes the identity
 * and the old row goes. The old row's exception rows move to the new row with
 * what they wait to upload (Etar copies only the exceptions it never synced;
 * an app's copy of one the old row has goes). A copied exception takes the
 * identity of its override. The shadow is the old one with the patch applied
 * until the server's comes back. A row that still differs from its baseline
 * (see `pairedBaseline`) stays dirty and uploads next.
 */
export function pairOps(deleted: LocalEvent, fresh: LocalEvent, kind: PairKind, patch: PatchObject, ctx: CalendarContext): OpGroup {
  const syncId = deleted.syncId!;
  const shadow: CalendarEventWire = applyPatch(deleted.shadow!, patch) ?? deleted.shadow!;
  const group = new GroupBuilder(syncId);
  assertRow(group, deleted, false, false);
  for (const x of deleted.exceptions) assertRow(group, x, true, x.dirty || x.deleted);
  assertExceptionCount(group, deleted.eventId, linkedExceptionCount(deleted));
  assertRow(group, fresh, false, true);
  for (const x of fresh.exceptions) assertRow(group, x, true, true);
  assertExceptionCount(group, fresh.eventId, linkedExceptionCount(fresh));
  const kept = new Set<string>();
  for (const x of deleted.exceptions) {
    // A series turned single has no occurrences left.
    if (kind.unrecur || !x.recurrenceId) {
      deleteRow(group, x.eventId);
      continue;
    }
    kept.add(x.recurrenceId);
    const values: Row = { [Events.ORIGINAL_ID]: fresh.eventId, [Events.CALENDAR_ID]: fresh.calendarRowId };
    if (x.baseline) values[Events.SYNC_DATA4] = encodeBaseline({ ...x.baseline, cells: { ...x.baseline.cells, [Events.CALENDAR_ID]: fresh.calendarRowId } });
    group.write({ op: 'update', table: 'events', id: x.eventId, values, expectCount: 1 });
  }
  deleteRow(group, deleted.eventId);
  const cells: Row = {};
  for (const c of MASTER_CELLS) cells[c] = fresh.cells[c] ?? null;
  const baseline = pairedBaseline(deleted, fresh, kind, ctx);
  updateRow(
    group,
    { ...fresh, shadow: null },
    {
      isException: false,
      cells,
      ...children(fresh),
      baseline,
      syncId,
      uid: typeof shadow.uid === 'string' ? shadow.uid : null,
      shadow,
      pending: null,
      clearDirty: !changedSince(fresh, baseline, ctx),
      hasParticipants: fresh.attendees.length > 0,
    },
  );
  const overrides = overridesOf(shadow);
  for (const x of fresh.exceptions) {
    const key = x.recurrenceId;
    if (key && kept.has(key)) {
      deleteRow(group, x.eventId);
      continue;
    }
    const values: Row = { [Events.ORIGINAL_SYNC_ID]: syncId };
    if (key && overrides[key] && !isExcluded(overrides[key])) {
      Object.assign(values, {
        [Events._SYNC_ID]: exceptionRef(syncId, key),
        [Events.SYNC_DATA2]: key,
        [Events.SYNC_DATA4]: encodeBaseline(makeBaseline(x.cells, EXCEPTION_CELLS, children(x).attendees, children(x).reminders)),
        [Events.DIRTY]: 0,
      });
    }
    group.write({ op: 'update', table: 'events', id: x.eventId, values, expectCount: 1 });
  }
  return group.build();
}
