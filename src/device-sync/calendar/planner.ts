/**
 * The calendar planner (docs/device-sync.md, "Calendar mapping"): JSCalendar
 * events and calendars ↔ CalendarContract rows, pure. The engine owns all
 * I/O; this module turns rows and server objects into op groups and upload
 * actions, following the contract in ../planner.ts.
 *
 * Tasks never reach CalendarContract: the engine filters them, and every
 * entry point here refuses one as well.
 */
import { Events } from '../android-columns';
import type {
  AcceptedPlan,
  CalendarContext,
  CalendarPlanner,
  DownloadPlan,
  LocalEvent,
  LocalEventRow,
  OpGroup,
  PoisonMarker,
  UploadAction,
  UploadPlan,
} from '../planner';
import type { CalendarEventWire } from '../wire';
import { objectRef, parseObjectRef, pendingUidOf } from '../common/ids';
import { deepEqual, jsonHash } from '../common/json';
import { isTaskLikeObject } from '../../lib/calendar-component-detection';
import { keepDirtyGroup, type UploadedUnits } from './accepted';
import { ATTENDEE_COLUMNS, CALENDAR_COLUMNS, EVENT_COLUMNS, EXCEPTION_CELLS, MASTER_CELLS, REMINDER_COLUMNS, isTruncatedBaseline, makeBaseline } from './columns';
import { planCalendars } from './calendars';
import { claimOps, claimUid, claimedUid, computeCreate, createTarget, deleteActions, movedAway } from './create';
import { decodeCalendar, decodeEvents, isExceptionRow, isNewMaster } from './decode';
import { isExcluded, overridesOf } from './exceptions';
import { eventImage } from './image';
import { insertEvent, insertEventOps, isRemovedInstance, linkedExceptionCount, pickCalendar, writeEvent, type CalendarTarget } from './merge';
import { pairKind, pairOps, pairPatch } from './pairs';
import { GroupBuilder, assertExceptionCount, assertRow, deleteRow, writesOf } from './rows';
import { eventZone } from './timing';
import { columnUnitDiffers, remindersDiffer, sideOfBaseline, sideOfRow } from './units';
import { SKIP, SkipUpload, computeUpdate, type UploadComputation } from './upload';

type Plan = UploadPlan<CalendarEventWire>;

function refuseTask(event: CalendarEventWire | null | undefined): void {
  if (event && isTaskLikeObject(event)) {
    throw new Error('calendar planner: tasks are not synced to the device (filter them before planning)');
  }
}

function refOf(local: LocalEventRow | null, event?: CalendarEventWire, jmapAccountId?: string): string {
  if (local?.syncId) return local.syncId;
  if (event && jmapAccountId) return objectRef(jmapAccountId, event.id);
  return local ? `row:${local.eventId}` : 'new';
}

/** The calendar a row is in, when it is one of ours. */
function rowCalendar(local: LocalEventRow, ctx: CalendarContext): CalendarTarget | null {
  const cal = ctx.calendarIdOfRow(local.calendarRowId);
  return cal ? { calendarRowId: local.calendarRowId, calendarId: cal.calendarId } : null;
}

// ─── Downloads ──────────────────────────────────────────

function planDownload(event: CalendarEventWire, local: LocalEvent | null, ctx: CalendarContext): DownloadPlan {
  refuseTask(event);
  refuseTask(local?.shadow);
  const ref = refOf(local, event, ctx.jmapAccountId);
  const none = (stillDirty: boolean): DownloadPlan => ({ ops: { ref, ops: [] }, conflicts: 0, stillDirty, effect: 'none', writes: 0 });
  // A different object under a reused id: its rows are replaced, never patched.
  const uidChanged = !!local?.shadow && typeof local.shadow.uid === 'string' && typeof event.uid === 'string' && local.shadow.uid !== event.uid;

  if (local?.deleted && local.split !== 'clone' && !uidChanged) {
    // Deleted on the device: that wins over a server edit, so only the shadow follows, for the deletion.
    // Also when no synced calendar holds the event any more: the deletion is then moot (see planUpload).
    if (!local.shadow || deepEqual(local.shadow, event)) return none(true);
    const group = new GroupBuilder(ref);
    group.assert({ op: 'assert', table: 'events', id: local.eventId, values: { [Events.DELETED]: 1, [Events._SYNC_ID]: local.syncId }, expectCount: 1 });
    group.write({ op: 'update', table: 'events', id: local.eventId, values: { [Events.SYNC_DATA1]: JSON.stringify(event) }, expectCount: 1 });
    const ops = group.build();
    return { ops, conflicts: 0, stillDirty: true, effect: 'update', writes: writesOf(ops) };
  }

  // An event another client moved out of every synced calendar still merges into its rows where they are
  // (they wait for an upload; the accepted write then removes them).
  const target = pickCalendar(event, local, ctx) ?? (local ? rowCalendar(local, ctx) : null);
  if (!target) throw new Error(`calendar planner: ${ref} is in no synced calendar (the engine removes such rows)`);
  const image = eventImage(event, target.calendarRowId, target.calendarId, ctx);
  // Stalwart drops a start it can't resolve (a DST gap or overlap): nothing to show.
  if (!image) return none(!!local && (local.dirty || local.deleted));

  if (!local) {
    const ops = insertEventOps(event, image, ctx, ref);
    return { ops, conflicts: 0, stillDirty: false, effect: 'insert', writes: writesOf(ops) };
  }
  // A split clone only looks like this object: it is a new event and uploads as one. The source row is the object's.
  if (local.split === 'clone') return none(true);

  if (uidChanged) {
    const group = new GroupBuilder(ref);
    for (const x of local.exceptions) deleteRow(group, x.eventId);
    deleteRow(group, local.eventId);
    const inserted = insertEvent(event, image, ctx, ref).build().ops;
    const offset = group.writeCount;
    for (const op of inserted) {
      if (op.op === 'insert' && op.refs) {
        const refs = Object.fromEntries(Object.entries(op.refs).map(([k, v]) => [k, v + offset]));
        group.write({ ...op, refs });
      } else group.write(op);
    }
    const ops = group.build();
    return { ops, conflicts: 0, stillDirty: false, effect: 'update', writes: writesOf(ops) };
  }

  const itemDirty = local.dirty || local.split === 'source' || local.exceptions.some((x) => x.dirty || x.deleted);
  const result = writeEvent(event, image, target, local, {
    mode: 'merge',
    ref,
    ctx,
    // No shadow: our own create whose identity was never written. Adopt it; its rows count as edits of `event`.
    base: local.shadow,
    ...(local.shadow ? {} : { pending: null }),
    clearPoison: !itemDirty,
  });
  const ops = result.ops;
  const writes = writesOf(ops);
  return {
    ops: writes ? ops : { ref, ops: [] },
    conflicts: result.conflicts,
    stillDirty: result.stillDirty,
    effect: writes ? 'update' : 'none',
    writes,
  };
}

function planLocalDelete(local: LocalEvent): OpGroup {
  const group = new GroupBuilder(refOf(local));
  assertExceptionCount(group, local.eventId, linkedExceptionCount(local));
  for (const x of local.exceptions) deleteRow(group, x.eventId);
  deleteRow(group, local.eventId);
  return group.build();
}

/**
 * Rewrites the baselines of clean rows that drifted from them (the provider
 * normalised a write, or a crash hit between a chunk and its read-back),
 * behind DIRTY=0. A recurring master's timing and rule are never healed: a
 * CONTENT_EXCEPTION_URI split changes them without DIRTY.
 */
function planBaselineHeal(local: LocalEvent): OpGroup | null {
  if (local.split || local.deleted || isExceptionRow(local.cells)) return null;
  const group = new GroupBuilder(refOf(local));
  const heals: Array<{ row: LocalEventRow; isException: boolean; baseline: ReturnType<typeof makeBaseline> }> = [];
  const consider = (row: LocalEventRow, isException: boolean) => {
    if (row.dirty || row.deleted) return;
    const columns = isException ? EXCEPTION_CELLS : MASTER_CELLS;
    const truncated = isTruncatedBaseline(row.baseline?.cells[Events.DESCRIPTION]) && !columnUnitDiffers('description', sideOfRow(row), sideOfBaseline(row.baseline!));
    const next = makeBaseline(row.cells, columns, row.attendees.map((a) => a.cells), row.reminders.map((r) => r.cells), truncated);
    if (truncated) next.cells[Events.DESCRIPTION] = row.baseline!.cells[Events.DESCRIPTION];
    const recurring = !isException && (!!row.cells[Events.RRULE] || !!row.baseline?.cells[Events.RRULE]);
    if (recurring && row.baseline) {
      for (const c of [Events.DTSTART, Events.DTEND, Events.DURATION, Events.EVENT_TIMEZONE, Events.ALL_DAY, Events.RRULE]) {
        next.cells[c] = row.baseline.cells[c] ?? null;
      }
    }
    if (row.baseline && deepEqual(next, row.baseline)) return;
    heals.push({ row, isException, baseline: next });
  };
  consider(local, false);
  for (const x of local.exceptions) consider(x, true);
  if (!heals.length) return null;
  for (const h of heals) assertRow(group, h.row, h.isException, false);
  for (const h of heals) {
    group.write({ op: 'update', table: 'events', id: h.row.eventId, values: { [Events.SYNC_DATA4]: JSON.stringify({ v: 1, ...h.baseline }) }, expectCount: 1 });
  }
  return group.build();
}

// ─── Uploads ────────────────────────────────────────────

/**
 * The fingerprint a poison marker records for an event: what it would upload
 * from (its flags, shadow, rows, attendees, reminders and exceptions), so the
 * back-off holds while nothing changes and lifts when the user edits it. The
 * engine writes the markers and checks them before planning
 * (engine/calendar-sync.ts); this is the same content, so an item handed in
 * anyway is still skipped.
 */
export function poisonFingerprint(e: LocalEvent): string {
  return jsonHash({
    deleted: e.deleted,
    shadow: e.shadow,
    cells: e.cells,
    attendees: e.attendees.map((a) => JSON.stringify(a.cells)).sort(),
    reminders: e.reminders.map((r) => JSON.stringify(r.cells)).sort(),
    exceptions: e.exceptions
      .map((x) => JSON.stringify([x.deleted, x.cells, x.attendees.map((a) => a.cells), x.reminders.map((r) => r.cells)]))
      .sort(),
  });
}

/** Writes a poison marker (SYNC_DATA5) on the master. */
export function poisonOps(local: LocalEvent, marker: PoisonMarker): OpGroup {
  return {
    ref: refOf(local),
    ops: [{ op: 'update', table: 'events', id: local.eventId, values: { [Events.SYNC_DATA5]: JSON.stringify(marker) }, expectCount: 1 }],
  };
}

function activePoison(local: LocalEvent, ctx: CalendarContext): PoisonMarker | null {
  const p = local.poison;
  if (!p || ctx.now >= p.until) return null;
  return p.fp === poisonFingerprint(local) ? p : null;
}

/** Deletes a master and its exceptions (a purge, a revert that refetches). */
function purgeGroup(local: LocalEvent): OpGroup {
  return planLocalDelete(local);
}

/** Rows rewritten from the shadow, DIRTY cleared: a read-only event's device edits are undone. */
function revertGroup(local: LocalEvent, ctx: CalendarContext): OpGroup | null {
  const shadow = local.shadow;
  if (!shadow) return null;
  const target = pickCalendar(shadow, local, ctx) ?? rowCalendar(local, ctx);
  if (!target) return null;
  const image = eventImage(shadow, target.calendarRowId, target.calendarId, ctx);
  if (!image) return null;
  return writeEvent(shadow, image, target, local, { mode: 'overwrite', ref: refOf(local), ctx, base: shadow }).ops;
}

/** Clears DIRTY where nothing uploadable changed, taking the rows as they are as the new baselines. */
function cleanGroup(local: LocalEvent, computation: UploadComputation | null): OpGroup {
  const group = new GroupBuilder(refOf(local));
  // Attendees and reminders of the dirty rows only (see `assertRow`), so a big meeting fits one transaction.
  assertRow(group, local, false, local.dirty || local.deleted);
  for (const x of local.exceptions) assertRow(group, x, true, x.dirty || x.deleted);
  const settle = (row: LocalEventRow, isException: boolean) => {
    if (!row.dirty) return;
    const truncated = isTruncatedBaseline(row.baseline?.cells[Events.DESCRIPTION]);
    const baseline = makeBaseline(row.cells, isException ? EXCEPTION_CELLS : MASTER_CELLS, row.attendees.map((a) => a.cells), row.reminders.map((r) => r.cells), truncated);
    group.write({ op: 'update', table: 'events', id: row.eventId, values: { [Events.DIRTY]: 0, [Events.SYNC_DATA4]: JSON.stringify({ v: 1, ...baseline }) }, expectCount: 1 });
  };
  settle(local, false);
  const overrides = overridesOf(local.shadow);
  for (const x of local.exceptions) {
    const excludedAlready = !!x.recurrenceId && isExcluded(overrides[x.recurrenceId]);
    if ((computation?.removedExceptions.has(x.eventId) || isRemovedInstance(x)) && excludedAlready) {
      deleteRow(group, x.eventId);
      continue;
    }
    settle(x, true);
  }
  return group.build();
}

function planUpload(local: LocalEvent, ctx: CalendarContext): Plan {
  refuseTask(local.shadow);
  // An exception row whose master is gone never uploads as an event of its own.
  if (isExceptionRow(local.cells)) return { kind: 'purge', ops: purgeGroup(local) };
  const calendar = ctx.calendarIdOfRow(local.calendarRowId);
  if (!calendar) return { kind: 'skip', reason: SKIP.notOurCalendar };
  const isNew = local.split === 'clone' || (!local.shadow && isNewMaster(local));

  if (local.deleted) {
    if (isNew) {
      // Never created (or its outcome unknown): destroy whatever carries the pending uid, else just purge.
      const uid = local.split === 'clone' ? null : local.pending?.uid ?? pendingUidOf(local.syncId);
      if (!uid) return { kind: 'purge', ops: purgeGroup(local) };
      return { kind: 'upload', actions: [{ kind: 'destroy', id: null, uid }] };
    }
    if (!parseObjectRef(local.syncId)) return { kind: 'purge', ops: purgeGroup(local) };
    // Moved away on the server before the deletion reached it: nothing goes up, only the rows go.
    if (movedAway(local, calendar, ctx)) return { kind: 'purge', ops: purgeGroup(local) };
    if (ctx.isReadOnly(calendar.calendarId)) return { kind: 'revert', ops: purgeGroup(local), refetch: true, reason: SKIP.readOnly };
    return { kind: 'upload', actions: deleteActions(local, ctx) };
  }

  if (isNew) {
    if (ctx.isReadOnly(calendar.calendarId)) return { kind: 'revert', ops: purgeGroup(local), reason: SKIP.readOnly };
    const uid = claimedUid(local);
    const target = createTarget(local, ctx);
    if (!target) return { kind: 'skip', reason: SKIP.notOurCalendar };
    if (!uid) return { kind: 'claim', ops: claimOps(local, claimUid(local, ctx), target.key) };
    const poison = activePoison(local, ctx);
    if (poison) return { kind: 'skip', reason: poison.type };
    try {
      const create = computeCreate(local, uid, target.calendarId, ctx);
      const action: UploadAction<CalendarEventWire> = { kind: 'create', uid, collectionId: target.calendarId, object: create.object };
      if (create.sendSchedulingMessages) action.sendSchedulingMessages = true;
      return { kind: 'upload', actions: [action] };
    } catch (e) {
      if (e instanceof SkipUpload) return { kind: 'skip', reason: e.reason };
      throw e;
    }
  }

  const ref = parseObjectRef(local.syncId);
  const shadow = local.shadow;
  if (!ref || !shadow) return { kind: 'skip', reason: 'noShadow' };
  const poison = activePoison(local, ctx);
  if (poison) return { kind: 'skip', reason: poison.type };
  // An instance Stalwart holds without its series can't be changed on its own.
  if (shadow.recurrenceId && !shadow.recurrenceRule) {
    const ops = revertGroup(local, ctx);
    return ops ? { kind: 'revert', ops, reason: SKIP.instanceOnly } : { kind: 'skip', reason: SKIP.instanceOnly };
  }

  let computation: UploadComputation;
  try {
    computation = computeUpdate(local, ctx);
  } catch (e) {
    if (e instanceof SkipUpload) return { kind: 'skip', reason: e.reason };
    throw e;
  }
  const keys = Object.keys(computation.patch);
  const readOnly = ctx.isReadOnly(calendar.calendarId);
  const movedToReadOnly = keys.some((k) => {
    const m = /^calendarIds\/(.+)$/.exec(k);
    return m && computation.patch[k] === true && ctx.isReadOnly(m[1]);
  });
  if ((readOnly && keys.length) || movedToReadOnly) {
    // RSVP, to the series or to occurrences, is the one change a calendar without write rights may take.
    const rsvp = computation.rsvpOnly && !movedToReadOnly;
    if (!(rsvp && ctx.calendar(calendar.calendarId)?.myRights?.mayRSVP)) {
      const ops = revertGroup(local, ctx);
      const reason = rsvp ? SKIP.rsvpRefused : SKIP.readOnly;
      return ops ? { kind: 'revert', ops, reason } : { kind: 'skip', reason };
    }
  }
  if (!keys.length) {
    if (computation.dropped.some((u) => u === 'timing' || u === 'rule')) return { kind: 'skip', reason: SKIP.ruleNotRepresentable };
    // A move into a calendar of another JMAP account is no patch (only new rows are created across accounts):
    // the row goes back to its calendar instead of staying there unsynced. With other changes, their accepted
    // write puts it back.
    if (computation.dropped.includes('calendar')) {
      const ops = revertGroup(local, ctx);
      if (ops) return { kind: 'revert', ops, reason: SKIP.crossAccountMove };
    }
    // Every reminder of an occurrence removed where the server can't store none: back to what it holds, reported.
    if (computation.dropped.includes('reminders')) {
      const ops = revertGroup(local, ctx);
      if (ops) return { kind: 'revert', ops, reason: SKIP.remindersNotRepresentable };
    }
    return { kind: 'clean', ops: cleanGroup(local, computation) };
  }
  const action: UploadAction<CalendarEventWire> = { kind: 'update', id: ref.id, patch: computation.patch };
  if (computation.sendSchedulingMessages) action.sendSchedulingMessages = true;
  return { kind: 'upload', actions: [action] };
}

function planAccepted(local: LocalEvent, server: CalendarEventWire, ctx: CalendarContext): AcceptedPlan {
  refuseTask(server);
  const target = pickCalendar(server, local, ctx);
  if (!target) {
    // Moved out of every synced calendar (a membership removal): the rows go.
    const ops = purgeGroup(local);
    return { ops, keepDirtyOps: ops };
  }
  const wasNew = local.split === 'clone' || (!local.shadow && isNewMaster(local));
  let uploaded: UploadedUnits;
  if (wasNew || !local.shadow) {
    uploaded = { all: true, master: new Set(), exceptions: new Map(), removed: new Set(local.exceptions.filter(isRemovedInstance).map((x) => x.eventId)) };
  } else {
    try {
      const c = computeUpdate(local, ctx);
      uploaded = { all: false, master: c.masterUnits, exceptions: c.exceptionUnits, removed: c.removedExceptions };
    } catch {
      uploaded = { all: false, master: new Set(), exceptions: new Map(), removed: new Set() };
    }
  }
  const keepDirtyOps = keepDirtyGroup(local, server, uploaded, ctx);
  const image = eventImage(server, target.calendarRowId, target.calendarId, ctx);
  if (!image) return { ops: keepDirtyOps, keepDirtyOps };
  const ops = writeEvent(server, image, target, local, {
    mode: 'overwrite',
    ref: objectRef(ctx.jmapAccountId, server.id),
    ctx,
    base: local.shadow ?? server,
    pending: null,
    clearPoison: true,
  }).ops;
  return { ops, keepDirtyOps };
}

function planPairs(
  deleted: LocalEvent[],
  fresh: LocalEvent[],
  ctx: CalendarContext,
): Array<{ deleted: LocalEvent; fresh: LocalEvent; actions: UploadAction<CalendarEventWire>[]; ops: OpGroup }> {
  const pairs: Array<{ deleted: LocalEvent; fresh: LocalEvent; actions: UploadAction<CalendarEventWire>[]; ops: OpGroup }> = [];
  const used = new Set<number>();
  const inAccount = (row: LocalEventRow) => ctx.calendarIdOfRow(row.calendarRowId)?.jmapAccountId === ctx.jmapAccountId;
  for (const d of deleted) {
    const ref = parseObjectRef(d.syncId);
    if (!ref || !d.shadow || !d.deleted || d.split || !inAccount(d)) continue;
    refuseTask(d.shadow);
    for (const f of fresh) {
      if (used.has(f.eventId) || f.syncId !== null || f.pending || f.deleted || isExceptionRow(f.cells) || !inAccount(f)) continue;
      const kind = pairKind(d, f, ctx);
      if (!kind) continue;
      const pair = pairPatch(d, f, kind, ctx);
      if (!pair) continue;
      const action: UploadAction<CalendarEventWire> = { kind: 'update', id: ref.id, patch: pair.patch };
      if (pair.sendSchedulingMessages) action.sendSchedulingMessages = true;
      pairs.push({ deleted: d, fresh: f, actions: [action], ops: pairOps(d, f, kind, pair.patch, ctx) });
      used.add(f.eventId);
      break;
    }
  }
  return pairs;
}

// ─── Device zone and reminder owner ─────────────────────

function planZoneChange(local: LocalEvent, previousZone: string, ctx: CalendarContext): OpGroup | null {
  const shadow = local.shadow;
  if (!shadow || local.split || local.deleted || local.dirty || local.exceptions.some((x) => x.dirty || x.deleted)) return null;
  refuseTask(shadow);
  if (previousZone === ctx.deviceZone || !eventZone(shadow, ctx.deviceZone).floating) return null;
  const target = pickCalendar(shadow, local, ctx);
  if (!target) return null;
  const image = eventImage(shadow, target.calendarRowId, target.calendarId, ctx);
  if (!image) return null;
  const ops = writeEvent(shadow, image, target, local, { mode: 'overwrite', ref: refOf(local), ctx, base: shadow }).ops;
  return writesOf(ops) ? ops : null;
}

function planReminderOwnerChange(local: LocalEvent, ctx: CalendarContext): OpGroup | null {
  const shadow = local.shadow;
  if (!shadow || local.deleted || isExceptionRow(local.cells)) return null;
  refuseTask(shadow);
  const target = pickCalendar(shadow, local, ctx);
  if (!target) return null;
  const image = eventImage(shadow, target.calendarRowId, target.calendarId, { ...ctx, reminderOwner: 'device' });
  if (!image) return null;
  const rows: Array<{ row: LocalEventRow; isException: boolean; wanted: LocalEventRow['cells'][] }> = [];
  const add = (row: LocalEventRow, isException: boolean, wanted: LocalEventRow['cells'][] | null) => {
    if (!wanted) return;
    // A reminder edit that has not reached the server yet is not overwritten.
    if (row.dirty && row.baseline && remindersDiffer(sideOfRow(row), sideOfBaseline(row.baseline))) return;
    rows.push({ row, isException, wanted: ctx.reminderOwner === 'device' ? wanted : [] });
  };
  add(local, false, image.master.reminders);
  for (const x of local.exceptions) {
    if (x.deleted || !x.recurrenceId) continue;
    const xi = image.exceptions.get(x.recurrenceId);
    add(x, true, xi ? xi.reminders : null);
  }
  const changing = rows.filter(({ row, wanted }) => {
    const have = row.reminders.map((r) => r.cells);
    return have.length !== wanted.length || remindersDiffer({ cells: {}, attendees: [], reminders: have }, { cells: {}, attendees: [], reminders: wanted });
  });
  if (!changing.length) return null;
  const group = new GroupBuilder(refOf(local));
  for (const { row, isException } of changing) assertRow(group, row, isException, true);
  for (const { row, isException, wanted } of changing) {
    for (const r of row.reminders) group.write({ op: 'delete', table: 'reminders', id: r.id, expectCount: 1 });
    for (const w of wanted) group.write({ op: 'insert', table: 'reminders', values: { ...w, event_id: row.eventId } });
    const baseline = row.baseline ?? makeBaseline(row.cells, isException ? EXCEPTION_CELLS : MASTER_CELLS, row.attendees.map((a) => a.cells), []);
    group.write({
      op: 'update',
      table: 'events',
      id: row.eventId,
      values: { [Events.SYNC_DATA4]: JSON.stringify({ v: 1, ...baseline, reminders: wanted }) },
      expectCount: 1,
    });
  }
  return group.build();
}

export const calendarPlanner: CalendarPlanner = {
  calendarColumns: CALENDAR_COLUMNS,
  eventColumns: EVENT_COLUMNS,
  attendeeColumns: ATTENDEE_COLUMNS,
  reminderColumns: REMINDER_COLUMNS,
  decodeCalendar,
  decodeEvents,
  planCalendars,
  planDownload,
  planLocalDelete,
  planBaselineHeal,
  planUpload,
  planAccepted,
  planPairs,
  planZoneChange,
  planReminderOwnerChange,
};
