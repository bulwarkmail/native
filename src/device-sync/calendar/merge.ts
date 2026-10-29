/**
 * A server event into its rows (docs/device-sync.md, "Change detection and
 * merge rules"). One writer serves downloads, accepted uploads, reverts and
 * zone changes:
 *
 * - a clean row is rewritten to the image of the server event (only cells
 *   that differ are written, so an echo writes nothing);
 * - a dirty row is merged per unit against its baseline (what the device
 *   changed) and the old shadow's image (what the server changed): the server
 *   wins real conflicts, local changes the server did not touch stay dirty
 *   for the upload;
 * - exception rows are matched to overrides by recurrence id and merged the
 *   same way; a device deletion of an instance wins over a server edit, a
 *   server removal wins over a device edit.
 *
 * Every write into an existing item is guarded: the group first asserts
 * DIRTY and the projection the plan was made from (with attendees and
 * reminders for the rows that are dirty: a clean row's DIRTY catches any app
 * edit of them) and the number of exception rows.
 */
import { Events } from '../android-columns';
import type { CalendarContext, EventBaseline, LocalEvent, LocalEventRow, LocalException, OpGroup } from '../planner';
import type { Row } from '../types';
import type { CalendarEventWire } from '../wire';
import { collectionKey, exceptionRef, objectRef } from '../common/ids';
import { EventStatus } from '../android-columns';
import type { SelfContext } from './attendees';
import { eventImage, plainInstanceImage, type EventImage, type ExceptionImage, type RowImage } from './image';
import {
  GroupBuilder,
  assertExceptionCount,
  assertRow,
  deleteRow,
  eventInsert,
  eventWrite,
  insertRow,
  updateRow,
  type RowState,
} from './rows';
import {
  COLUMN_UNITS,
  EXCEPTION_COLUMN_UNITS,
  MASTER_COLUMN_UNITS,
  attendeeDiffers,
  attendeesByKey,
  baselineOfImage,
  columnUnitDiffers,
  deviceChangedUnit,
  exdateEntries,
  isLossyEditor,
  remindersDiffer,
  sideOfBaseline,
  sideOfImage,
  sideOfRow,
} from './units';

export interface CalendarTarget {
  calendarRowId: number;
  calendarId: string;
}

/**
 * The calendar row an event lives in: the row it is already in while the
 * event still belongs to that calendar, else its first selected calendar by
 * id (docs/device-sync.md, "Decisions and limitations").
 */
export function pickCalendar(
  event: CalendarEventWire,
  local: LocalEventRow | null,
  ctx: Pick<CalendarContext, 'jmapAccountId' | 'calendarRowId' | 'calendarIdOfRow' | 'isSelected'>,
): CalendarTarget | null {
  const ids = Object.entries(event.calendarIds ?? {})
    .filter(([, on]) => on)
    .map(([id]) => id)
    .sort();
  const candidates = ids.filter((id) => ctx.calendarRowId(id) !== null && ctx.isSelected(collectionKey(ctx.jmapAccountId, id)));
  if (local) {
    const current = ctx.calendarIdOfRow(local.calendarRowId);
    if (current && current.jmapAccountId === ctx.jmapAccountId && candidates.includes(current.calendarId)) {
      return { calendarRowId: local.calendarRowId, calendarId: current.calendarId };
    }
  }
  if (!candidates.length) return null;
  return { calendarRowId: ctx.calendarRowId(candidates[0])!, calendarId: candidates[0] };
}

// ─── One row ────────────────────────────────────────────

export interface RowMerge {
  cells: Row;
  attendees: Row[];
  reminders: Row[] | null;
  baseline: EventBaseline;
  /** Units whose local change survived (the row stays dirty). */
  kept: string[];
  conflicts: number;
}

export interface RowMergeInput {
  isException: boolean;
  current: LocalEventRow;
  /** What the device last wrote (SYNC_DATA4), or an image standing in for it. */
  baseline: EventBaseline;
  /** The old server state's image of this row. */
  base: RowImage;
  /** The new server state's image of this row. */
  remote: RowImage;
  /** Whether the row's differences from its baseline are edits (DIRTY). */
  dirty: boolean;
  /** Units counted as edited even on a clean row (a split source's rule). */
  forced?: ReadonlySet<string>;
  /** An editor that rewrites attendee types (Fossify). */
  lossy?: boolean;
  self: SelfContext;
}

/** Per-unit merge of one row (see the header): what to write, the new baseline, what stays dirty. */
export function mergeRow(input: RowMergeInput): RowMerge {
  const { current, baseline, base, remote, dirty } = input;
  const forced = input.forced ?? new Set<string>();
  const cur = sideOfRow(current);
  const bl = sideOfBaseline(baseline);
  const bs = sideOfImage(base);
  const rm = sideOfImage(remote);
  const cells: Row = { ...remote.cells };
  const remoteBaseline = baselineOfImage(remote, input.isException);
  const baseCells: Row = { ...remoteBaseline.cells };
  const kept: string[] = [];
  let conflicts = 0;

  const decide = (unit: string, local: boolean, remoteChanged: boolean, same: boolean): 'local' | 'remote' => {
    if (!local) return 'remote';
    if (!remoteChanged) {
      kept.push(unit);
      return 'local';
    }
    if (!same) conflicts += 1;
    return 'remote';
  };

  for (const unit of input.isException ? EXCEPTION_COLUMN_UNITS : MASTER_COLUMN_UNITS) {
    const local = (dirty || forced.has(unit)) && deviceChangedUnit(unit, cur, bl);
    const choice = decide(unit, local, columnUnitDiffers(unit, bs, rm), !columnUnitDiffers(unit, cur, rm));
    if (choice === 'local') {
      for (const c of COLUMN_UNITS[unit]) {
        cells[c] = current.cells[c] ?? null;
        baseCells[c] = baseline.cells[c] ?? null;
      }
    }
  }

  if (!input.isException) {
    const curE = exdateEntries(cur);
    const blE = exdateEntries(bl);
    const bsE = exdateEntries(bs);
    const rmE = exdateEntries(rm);
    const final = new Set<string>();
    const finalBaseline = new Set<string>();
    for (const e of new Set([...curE, ...blE, ...bsE, ...rmE])) {
      const choice = decide(`exdate:${e}`, dirty && curE.has(e) !== blE.has(e), bsE.has(e) !== rmE.has(e), curE.has(e) === rmE.has(e));
      if (choice === 'remote') {
        if (rmE.has(e)) {
          final.add(e);
          finalBaseline.add(e);
        }
      } else {
        if (curE.has(e)) final.add(e);
        if (blE.has(e)) finalBaseline.add(e);
      }
    }
    const recurring = !!cells[Events.RRULE];
    // Our own column text when nothing local is kept, so an echo compares equal character for character.
    cells[Events.EXDATE] = !recurring || !final.size ? null : sameEntries(final, rmE) ? remote.cells[Events.EXDATE] : [...final].sort().join(',');
    baseCells[Events.EXDATE] = !finalBaseline.size ? null : [...finalBaseline].sort().join(',');
  }

  const curA = attendeesByKey(cur.attendees, input.self);
  const blA = attendeesByKey(bl.attendees, input.self);
  const bsA = attendeesByKey(bs.attendees, input.self);
  const rmA = attendeesByKey(rm.attendees, input.self);
  const attendees: Row[] = [];
  const baselineAttendees: Row[] = [];
  for (const key of new Set([...rmA.keys(), ...curA.keys(), ...blA.keys(), ...bsA.keys()])) {
    const local = dirty && attendeeDiffers(curA.get(key), blA.get(key), input.lossy);
    const choice = decide(
      `attendee:${key}`,
      local,
      attendeeDiffers(bsA.get(key), rmA.get(key)),
      !attendeeDiffers(curA.get(key), rmA.get(key), input.lossy),
    );
    if (choice === 'remote') {
      const r = rmA.get(key);
      if (r) {
        attendees.push(r);
        baselineAttendees.push(r);
      }
    } else {
      const c = curA.get(key);
      const b = blA.get(key);
      if (c) attendees.push(c);
      if (b) baselineAttendees.push(b);
    }
  }

  let reminders: Row[] | null = null;
  let baselineReminders: Row[];
  if (remote.reminders === null) {
    // Bulwark owns reminders: the rows are an app's business, neither written nor uploaded.
    baselineReminders = current.reminders.map((r) => r.cells);
  } else {
    const local = dirty && remindersDiffer(cur, bl);
    const choice = decide('reminders', local, remindersDiffer(bs, rm), !remindersDiffer(cur, rm));
    reminders = choice === 'remote' ? remote.reminders : current.reminders.map((r) => r.cells);
    baselineReminders = choice === 'remote' ? remote.reminders : bl.reminders ?? [];
  }

  return {
    cells,
    attendees,
    reminders,
    baseline: { cells: baseCells, attendees: baselineAttendees, reminders: baselineReminders },
    kept,
    conflicts,
  };
}

/** Exception rows the provider links to the master by ORIGINAL_ID (what the count assert counts). */
export function linkedExceptionCount(local: LocalEvent): number {
  return local.exceptions.filter((x) => Number(x.cells[Events.ORIGINAL_ID]) === local.eventId).length;
}

function sameEntries(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((e) => b.has(e));
}

// ─── A whole event ──────────────────────────────────────

export type WriteMode =
  /** A download: dirty rows are merged per unit. */
  | 'merge'
  /** After an accepted upload, a revert or a zone change: every row becomes the image, DIRTY cleared. */
  | 'overwrite';

export interface EventWriteResult {
  /** One group, or a chain for an event too big for one (see `eventWrite`). */
  ops: OpGroup;
  conflicts: number;
  stillDirty: boolean;
}

/** Whether an exception row stands for "this instance was deleted" (a DELETED row or a new cancellation). */
export function isRemovedInstance(row: LocalEventRow): boolean {
  if (row.deleted) return true;
  if (Number(row.cells[Events.STATUS]) !== EventStatus.CANCELED) return false;
  // A cancellation the row already had when device sync wrote it is the server's own status.
  return !row.baseline || Number(row.baseline.cells[Events.STATUS]) !== EventStatus.CANCELED;
}

export interface EventWriteOptions {
  mode: WriteMode;
  ref: string;
  ctx: CalendarContext;
  /** The old server state the rows were written from; null: adopt (the rows' changes are measured against `event`). */
  base: CalendarEventWire | null;
  /** SYNC_DATA3 to write; undefined leaves it. */
  pending?: null;
  /** SYNC_DATA5 to write; undefined leaves it. */
  clearPoison?: boolean;
}

/**
 * The ops that bring a local event (master and exceptions) to `event`,
 * merged per `options.mode`. `image` is `event`'s image in its calendar.
 */
export function writeEvent(
  event: CalendarEventWire,
  image: EventImage,
  target: CalendarTarget,
  local: LocalEvent,
  options: EventWriteOptions,
): EventWriteResult {
  const { ctx } = options;
  const overwrite = options.mode === 'overwrite';
  const masterRef = objectRef(ctx.jmapAccountId, event.id);
  const uid = typeof event.uid === 'string' && event.uid ? event.uid : null;
  const baseEvent = options.base ?? event;
  const baseTarget = options.base ? { calendarRowId: local.calendarRowId, calendarId: ctx.calendarIdOfRow(local.calendarRowId)?.calendarId ?? target.calendarId } : target;
  const baseImage = options.base ? eventImage(baseEvent, baseTarget.calendarRowId, baseTarget.calendarId, ctx) ?? image : image;
  const lossy = isLossyEditor(local.mutators);

  // Asserts first: the rows as read. Attendees and reminders only for dirty rows (see `assertRow`): a big
  // meeting's occurrences would otherwise assert every attendee and outgrow one provider transaction.
  const opsOf = (build: (group: GroupBuilder) => void) => {
    const group = new GroupBuilder(options.ref);
    build(group);
    return group.build().ops;
  };
  const masterAsserts = opsOf((g) => assertRow(g, local, false, local.dirty || local.deleted));
  const rowAsserts = new Map(local.exceptions.map((x) => [x.eventId, opsOf((g) => assertRow(g, x, true, x.dirty || x.deleted))]));
  const countAssert = opsOf((g) => assertExceptionCount(g, local.eventId, linkedExceptionCount(local)));

  let conflicts = 0;
  let stillDirty = false;

  const masterMerge = mergeRow({
    isException: false,
    current: local,
    baseline: options.base && local.baseline ? local.baseline : baselineOfImage(options.base ? baseImage.master : image.master, false),
    base: baseImage.master,
    remote: image.master,
    dirty: !overwrite && local.dirty,
    // A CONTENT_EXCEPTION_URI split capped this rule without DIRTY.
    forced: !overwrite && local.split === 'source' ? new Set(['rule']) : undefined,
    lossy,
    self: ctx,
  });
  conflicts += masterMerge.conflicts;
  if (masterMerge.kept.length) stillDirty = true;
  const masterState: RowState = {
    isException: false,
    cells: masterMerge.cells,
    attendees: masterMerge.attendees,
    reminders: masterMerge.reminders,
    baseline: masterMerge.baseline,
    syncId: masterRef,
    uid,
    shadow: event,
    ...(options.pending === null ? { pending: null } : {}),
    ...(options.clearPoison ? { poison: null } : {}),
    clearDirty: overwrite || (local.dirty && !masterMerge.kept.length),
    hasParticipants: image.master.hasParticipants,
  };

  const deletes: LocalException[] = [];
  const updates: Array<{ row: LocalEventRow; state: RowState }> = [];
  const inserts: RowState[] = [];

  const byKey = new Map<string, LocalException[]>();
  for (const x of local.exceptions) {
    if (!x.recurrenceId) continue;
    const list = byKey.get(x.recurrenceId) ?? [];
    list.push(x);
    byKey.set(x.recurrenceId, list);
  }
  const keys = new Set<string>([...byKey.keys(), ...image.exceptions.keys(), ...baseImage.exceptions.keys()]);
  const finalCalendarRowId = Number(masterMerge.cells[Events.CALENDAR_ID]);

  const exceptionState = (key: string, merged: { cells: Row; attendees: Row[]; reminders: Row[] | null; baseline: EventBaseline }, dirtyLeft: boolean, row: LocalEventRow | null, ours: boolean): RowState => ({
    isException: true,
    cells: { ...merged.cells, [Events.CALENDAR_ID]: finalCalendarRowId },
    attendees: merged.attendees,
    reminders: merged.reminders,
    baseline: { ...merged.baseline, cells: { ...merged.baseline.cells, [Events.CALENDAR_ID]: finalCalendarRowId } },
    syncId: ours ? exceptionRef(masterRef, key) : row?.syncId ?? null,
    uid,
    recurrenceKey: ours ? key : ((row?.cells[Events.SYNC_DATA2] as string | null | undefined) ?? null),
    originalSyncId: masterRef,
    clearDirty: !!row?.dirty && !dirtyLeft,
    hasParticipants: merged.attendees.length > 0,
  });

  for (const key of [...keys].sort()) {
    const rows = byKey.get(key) ?? [];
    const [row, ...duplicates] = rows;
    // Two rows for one instance (an app's own duplicate): the extra ones go when clean.
    for (const extra of duplicates) {
      if (overwrite || !(extra.dirty || extra.deleted)) deletes.push(extra);
      else stillDirty = true;
    }
    const r = image.exceptions.get(key);
    const b = baseImage.exceptions.get(key);
    if (!row) {
      if (r) inserts.push(imageState(r, finalCalendarRowId, masterRef, uid));
      continue;
    }
    if (overwrite && row.deleted) {
      // Its exclusion was uploaded (or is being reverted): a soft-deleted row is purged either way.
      deletes.push(row);
      if (r) inserts.push(imageState(r, finalCalendarRowId, masterRef, uid));
      continue;
    }
    const rowDirty = !overwrite && (row.dirty || row.deleted);
    if (!rowDirty) {
      if (r) updates.push({ row, state: exceptionState(key, { ...r, baseline: baselineOfImage(r, true) }, false, row, true) });
      else deletes.push(row);
      continue;
    }
    if (isRemovedInstance(row)) {
      // The device deleted this instance: that wins over a server edit and uploads as an exclusion.
      stillDirty = true;
      continue;
    }
    if ((b && !r) || image.excluded.has(key)) {
      // The server removed or excluded the instance's override: the server delete wins.
      deletes.push(row);
      conflicts += 1;
      continue;
    }
    const remoteSide = r ?? plainInstanceImage(event, key, finalCalendarRowId, target.calendarId, ctx);
    const baseSide = b ?? plainInstanceImage(baseEvent, key, baseTarget.calendarRowId, baseTarget.calendarId, ctx) ?? remoteSide;
    if (!remoteSide || !baseSide) {
      stillDirty = true;
      continue;
    }
    const merged = mergeRow({
      isException: true,
      current: row,
      baseline: row.baseline ?? baselineOfImage(baseSide, true),
      base: baseSide,
      remote: remoteSide,
      dirty: true,
      lossy,
      self: ctx,
    });
    conflicts += merged.conflicts;
    // A local exception the server has no override for keeps its local identity until it is uploaded.
    const left = merged.kept.length > 0 || !r;
    if (left) stillDirty = true;
    updates.push({ row, state: exceptionState(key, merged, left, row, !!r) });
  }

  const ops = eventWrite(options.ref, {
    master: masterAsserts,
    rows: rowAsserts,
    count: countAssert,
    deletes: deletes.map((row) => ({ row: row.eventId, asserts: [], writes: opsOf((g) => deleteRow(g, row.eventId)) })),
    masterWrite: opsOf((g) => updateRow(g, local, masterState)),
    updates: updates.map(({ row, state }) => ({ row: row.eventId, asserts: [], writes: opsOf((g) => updateRow(g, row, state)) })),
    inserts: inserts.map((state) => ({ asserts: [], writes: opsOf((g) => insertRow(g, state, { id: local.eventId })) })),
  });

  return { ops, conflicts, stillDirty: !overwrite && (stillDirty || local.deleted) };
}

/** The row an exception image becomes, written clean. */
export function imageState(x: ExceptionImage, calendarRowId: number, masterRef: string, uid: string | null): RowState {
  const cells = { ...x.cells, [Events.CALENDAR_ID]: calendarRowId };
  const baseline = baselineOfImage({ ...x, cells }, true);
  return {
    isException: true,
    cells,
    attendees: x.attendees,
    reminders: x.reminders,
    baseline,
    syncId: exceptionRef(masterRef, x.key),
    uid,
    recurrenceKey: x.key,
    originalSyncId: masterRef,
    hasParticipants: x.hasParticipants,
  };
}

function masterInsertState(event: CalendarEventWire, image: EventImage, masterRef: string, uid: string | null): RowState {
  return {
    isException: false,
    cells: image.master.cells,
    attendees: image.master.attendees,
    reminders: image.master.reminders,
    baseline: baselineOfImage(image.master, false),
    syncId: masterRef,
    uid,
    shadow: event,
    hasParticipants: image.master.hasParticipants,
  };
}

/** A new event's rows: the master and one row per exception, attendees and reminders included. */
export function insertEvent(event: CalendarEventWire, image: EventImage, ctx: CalendarContext, ref: string): GroupBuilder {
  const group = new GroupBuilder(ref);
  const masterRef = objectRef(ctx.jmapAccountId, event.id);
  const uid = typeof event.uid === 'string' && event.uid ? event.uid : null;
  const master = insertRow(group, masterInsertState(event, image, masterRef, uid));
  for (const key of [...image.exceptions.keys()].sort()) {
    const x = image.exceptions.get(key)!;
    insertRow(group, imageState(x, Number(image.master.cells[Events.CALENDAR_ID]), masterRef, uid), { ref: master });
  }
  return group;
}

/** A new event's rows as one group, or as a chain for an event too big for one (see `eventInsert`). */
export function insertEventOps(event: CalendarEventWire, image: EventImage, ctx: CalendarContext, ref: string): OpGroup {
  const masterRef = objectRef(ctx.jmapAccountId, event.id);
  const uid = typeof event.uid === 'string' && event.uid ? event.uid : null;
  const calendarRowId = Number(image.master.cells[Events.CALENDAR_ID]);
  const opsOf = (build: (group: GroupBuilder) => void) => {
    const group = new GroupBuilder(ref);
    build(group);
    return group.build().ops;
  };
  return eventInsert(ref, insertEvent(event, image, ctx, ref).build(), () => ({
    masterRef,
    master: opsOf((g) => insertRow(g, { ...masterInsertState(event, image, masterRef, uid), shadow: undefined })),
    exceptions: [...image.exceptions.keys()].sort().map((key) => ({
      asserts: [],
      writes: opsOf((g) => insertRow(g, imageState(image.exceptions.get(key)!, calendarRowId, masterRef, uid))),
    })),
    shadow: event,
  }));
}
