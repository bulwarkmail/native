/**
 * Writing event rows: the op group builder and the translation of "this row
 * should hold that" into the fewest provider ops (docs/device-sync.md,
 * "Merge rules" and "Uploads").
 *
 * A group is atomic and its asserts come first, so the builder refuses an
 * assert after the first write; `refs` are indexes into the group. Rows are
 * addressed by id with `expectCount: 1`, exception rows are deleted by id
 * only (a sync-adapter delete never cascades to them), and a write that
 * would not change a cell is left out, so an echo writes nothing.
 */
import { Attendees, Events, Reminders } from '../android-columns';
import type { EventBaseline, LocalEventRow, OpGroup, PendingCreate, PoisonMarker } from '../planner';
import type { ProviderOp, Row, WriteRow } from '../types';
import type { CalendarEventWire } from '../wire';
import { deepEqual } from '../common/json';
import { MAX_OPS_PER_YIELD, estimateBatchBytes } from '../engine/batch';
import { DEFAULT_TUNING } from '../engine/deps';
import { ATTENDEE_CELLS, MASTER_CELLS, EXCEPTION_CELLS, REMINDER_CELLS, encodeBaseline, sameCell } from './columns';
import { rowReminder } from './reminders';

export class GroupBuilder {
  private readonly asserts: ProviderOp[] = [];
  private readonly writes: ProviderOp[] = [];

  constructor(readonly ref: string) {}

  assert(op: Extract<ProviderOp, { op: 'assert' }>): void {
    if (this.writes.length) throw new Error('calendar planner: an assert after a write');
    this.asserts.push(op);
  }

  /** Adds a write and returns its index in the group (for `refs`). */
  write(op: ProviderOp): number {
    this.writes.push(op);
    return this.asserts.length + this.writes.length - 1;
  }

  get writeCount(): number {
    return this.writes.length;
  }

  build(): OpGroup {
    return { ref: this.ref, ops: [...this.asserts, ...this.writes] };
  }
}

/** Columns asserted for a row: sync state plus its projection. */
const ASSERT_EXTRA = [Events.DIRTY, Events.DELETED, Events._SYNC_ID] as const;

export function projectionColumns(isException: boolean): readonly string[] {
  return isException ? EXCEPTION_CELLS : MASTER_CELLS;
}

/**
 * Asserts that a row still holds what was read: DIRTY, DELETED, `_SYNC_ID`
 * and its mapped cells, and with `children` its attendees and reminders
 * (each row's cells plus their number, so an added one fails too). DIRTY
 * alone guards a clean row against app edits (every app write to an event,
 * its attendees or reminders sets it); a dirty row needs the whole
 * projection.
 */
export function assertRow(group: GroupBuilder, row: LocalEventRow, isException: boolean, children: boolean): void {
  const values: Row = {};
  // As read: a row a sync adapter inserted without DIRTY holds NULL there, not 0.
  values[Events.DIRTY] = row.cells[Events.DIRTY] ?? null;
  values[Events.DELETED] = row.cells[Events.DELETED] ?? null;
  values[Events._SYNC_ID] = row.syncId;
  for (const c of projectionColumns(isException)) values[c] = row.cells[c] ?? null;
  for (const c of ASSERT_EXTRA) if (!(c in values)) values[c] = row.cells[c] ?? null;
  group.assert({ op: 'assert', table: 'events', id: row.eventId, values, expectCount: 1 });
  if (!children) return;
  for (const a of row.attendees) {
    group.assert({ op: 'assert', table: 'attendees', id: a.id, values: pick(a.cells, ATTENDEE_CELLS), expectCount: 1 });
  }
  group.assert({ op: 'assert', table: 'attendees', where: `${Attendees.EVENT_ID} = ?`, args: [row.eventId], expectCount: row.attendees.length });
  for (const r of row.reminders) {
    group.assert({ op: 'assert', table: 'reminders', id: r.id, values: pick(r.cells, REMINDER_CELLS), expectCount: 1 });
  }
  group.assert({ op: 'assert', table: 'reminders', where: `${Reminders.EVENT_ID} = ?`, args: [row.eventId], expectCount: row.reminders.length });
}

/** Asserts the number of exception rows of a master, so one an app adds meanwhile fails the group. */
export function assertExceptionCount(group: GroupBuilder, masterId: number, count: number): void {
  group.assert({ op: 'assert', table: 'events', where: `${Events.ORIGINAL_ID} = ?`, args: [masterId], expectCount: count });
}

function pick(row: Row, columns: readonly string[]): Row {
  const out: Row = {};
  for (const c of columns) out[c] = row[c] ?? null;
  return out;
}

/** What a row should hold after the group: content, sync columns, children. */
export interface RowState {
  isException: boolean;
  /** Mapped cells (the projection). */
  cells: Row;
  attendees: Row[];
  /** Null: Reminders rows are left as they are. */
  reminders: Row[] | null;
  baseline: EventBaseline;
  syncId: string | null;
  uid: string | null;
  /** Masters: SYNC_DATA1; undefined leaves it. */
  shadow?: CalendarEventWire | null;
  /** Exceptions: SYNC_DATA2 (the recurrence id). */
  recurrenceKey?: string | null;
  /** SYNC_DATA3; undefined leaves it. */
  pending?: PendingCreate | null;
  /** SYNC_DATA5; undefined leaves it. */
  poison?: PoisonMarker | null;
  /** Exceptions: ORIGINAL_SYNC_ID. */
  originalSyncId?: string | null;
  /** Written as DIRTY=0 when set; DIRTY is otherwise left to the provider. */
  clearDirty?: boolean;
  /** ORGANIZER is written on insert only when the event has participants (the provider fills the owner otherwise). */
  hasParticipants: boolean;
}

function syncValues(state: RowState): WriteRow {
  const values: WriteRow = {};
  values[Events._SYNC_ID] = state.syncId;
  values[Events.UID_2445] = state.uid;
  if (state.shadow !== undefined) values[Events.SYNC_DATA1] = state.shadow ? JSON.stringify(state.shadow) : null;
  if (state.recurrenceKey !== undefined) values[Events.SYNC_DATA2] = state.recurrenceKey;
  if (state.pending !== undefined) values[Events.SYNC_DATA3] = state.pending ? JSON.stringify(state.pending) : null;
  values[Events.SYNC_DATA4] = encodeBaseline(state.baseline);
  if (state.poison !== undefined) values[Events.SYNC_DATA5] = state.poison ? JSON.stringify(state.poison) : null;
  if (state.originalSyncId !== undefined) values[Events.ORIGINAL_SYNC_ID] = state.originalSyncId;
  return values;
}

/**
 * Inserts a row and its attendees and reminders. `originalId` links an
 * exception to its master: an id, or the index of the master's insert in
 * this group.
 */
export function insertRow(group: GroupBuilder, state: RowState, originalId?: { id: number } | { ref: number }): number {
  // DIRTY is NULL after a sync-adapter insert unless written, and later asserts expect 0.
  const values: WriteRow = { ...syncValues(state), [Events.HAS_ATTENDEE_DATA]: 1, [Events.DIRTY]: 0 };
  for (const [c, v] of Object.entries(state.cells)) {
    if (c === Events.ORGANIZER && !state.hasParticipants) continue;
    values[c] = v;
  }
  const refs: Record<string, number> = {};
  if (originalId && 'id' in originalId) values[Events.ORIGINAL_ID] = originalId.id;
  if (originalId && 'ref' in originalId) refs[Events.ORIGINAL_ID] = originalId.ref;
  const index = group.write({ op: 'insert', table: 'events', values, ...(Object.keys(refs).length ? { refs } : {}) });
  for (const a of state.attendees) group.write({ op: 'insert', table: 'attendees', values: { ...a }, refs: { [Attendees.EVENT_ID]: index } });
  for (const r of state.reminders ?? []) group.write({ op: 'insert', table: 'reminders', values: { ...r }, refs: { [Reminders.EVENT_ID]: index } });
  return index;
}

export function deleteRow(group: GroupBuilder, eventId: number): void {
  group.write({ op: 'delete', table: 'events', id: eventId, expectCount: 1 });
}

const sameJson = (a: unknown, b: unknown) => deepEqual(a ?? null, b ?? null);

/**
 * Updates an existing row to `state`, writing only cells and sync columns
 * that differ, then its attendees (matched by address) and reminders
 * (matched by minutes and method). Returns the number of write ops.
 */
export function updateRow(group: GroupBuilder, current: LocalEventRow & { shadow?: CalendarEventWire | null }, state: RowState): number {
  const before = group.writeCount;
  const values: WriteRow = {};
  for (const [c, v] of Object.entries(state.cells)) {
    const have = current.cells[c] ?? null;
    const want = v ?? null;
    // Same meaning (`''` and NULL, `P3600S` and `PT1H`) is no reason to write.
    if (have === want || sameCell(c, have, want)) continue;
    values[c] = want;
  }
  // Timing columns go together: the provider keeps DTEND and DURATION apart by what is written.
  const timing = [Events.DTSTART, Events.DTEND, Events.DURATION, Events.EVENT_TIMEZONE, Events.ALL_DAY, Events.RRULE];
  if (timing.some((c) => c in values)) for (const c of timing) if (c in state.cells) values[c] = state.cells[c];
  if ((current.syncId ?? null) !== state.syncId) values[Events._SYNC_ID] = state.syncId;
  if ((current.cells[Events.UID_2445] ?? null) !== state.uid) values[Events.UID_2445] = state.uid;
  if (state.shadow !== undefined && !sameJson(current.shadow, state.shadow)) {
    values[Events.SYNC_DATA1] = state.shadow ? JSON.stringify(state.shadow) : null;
  }
  if (state.recurrenceKey !== undefined && (current.cells[Events.SYNC_DATA2] ?? null) !== state.recurrenceKey) {
    values[Events.SYNC_DATA2] = state.recurrenceKey;
  }
  if (state.pending !== undefined && !sameJson(current.pending, state.pending)) {
    values[Events.SYNC_DATA3] = state.pending ? JSON.stringify(state.pending) : null;
  }
  if (!sameJson(current.baseline, state.baseline)) values[Events.SYNC_DATA4] = encodeBaseline(state.baseline);
  if (state.poison !== undefined && !sameJson(current.poison, state.poison)) {
    values[Events.SYNC_DATA5] = state.poison ? JSON.stringify(state.poison) : null;
  }
  if (state.originalSyncId !== undefined && (current.cells[Events.ORIGINAL_SYNC_ID] ?? null) !== state.originalSyncId) {
    values[Events.ORIGINAL_SYNC_ID] = state.originalSyncId;
  }
  if (state.clearDirty && current.dirty) values[Events.DIRTY] = 0;
  if (Object.keys(values).length) group.write({ op: 'update', table: 'events', id: current.eventId, values, expectCount: 1 });

  writeAttendees(group, current, state.attendees);
  if (state.reminders !== null) writeReminders(group, current, state.reminders);
  return group.writeCount - before;
}

const emailKey = (row: Row) => String(row[Attendees.ATTENDEE_EMAIL] ?? '').trim().toLowerCase();

function writeAttendees(group: GroupBuilder, current: LocalEventRow, wanted: Row[]): void {
  const unmatched = [...current.attendees];
  const inserts: Row[] = [];
  const updates: Array<{ id: number; values: Row }> = [];
  for (const want of wanted) {
    const i = unmatched.findIndex((a) => emailKey(a.cells) === emailKey(want));
    if (i < 0) {
      inserts.push(want);
      continue;
    }
    const [have] = unmatched.splice(i, 1);
    const values: Row = {};
    for (const c of ATTENDEE_CELLS) {
      const v = want[c] ?? null;
      const h = have.cells[c] ?? null;
      if (h === v) continue;
      // The email's case matters: Android finds "me" by comparing it with OWNER_ACCOUNT exactly.
      if (c !== Attendees.ATTENDEE_EMAIL && sameCell(c, h, v)) continue;
      values[c] = v;
    }
    if (Object.keys(values).length) updates.push({ id: have.id, values });
  }
  for (const gone of unmatched) group.write({ op: 'delete', table: 'attendees', id: gone.id, expectCount: 1 });
  for (const u of updates) group.write({ op: 'update', table: 'attendees', id: u.id, values: u.values, expectCount: 1 });
  for (const add of inserts) group.write({ op: 'insert', table: 'attendees', values: { ...add, [Attendees.EVENT_ID]: current.eventId } });
}

function writeReminders(group: GroupBuilder, current: LocalEventRow, wanted: Row[]): void {
  const key = (row: Row) => {
    const r = rowReminder(row);
    return r ? `${r.minutes}/${r.method}` : `raw:${String(row[Reminders.MINUTES])}/${String(row[Reminders.METHOD])}`;
  };
  const unmatched = [...current.reminders];
  const inserts: Row[] = [];
  for (const want of wanted) {
    const i = unmatched.findIndex((r) => key(r.cells) === key(want));
    if (i < 0) inserts.push(want);
    else unmatched.splice(i, 1);
  }
  for (const gone of unmatched) group.write({ op: 'delete', table: 'reminders', id: gone.id, expectCount: 1 });
  for (const add of inserts) group.write({ op: 'insert', table: 'reminders', values: { ...add, [Reminders.EVENT_ID]: current.eventId } });
}

/** Counts the provider writes of a group and the groups after it (asserts are not writes). */
export function writesOf(group: OpGroup): number {
  return [group, ...(group.next ?? [])].reduce(
    (n, g) => n + g.ops.filter((op) => op.op === 'insert' || op.op === 'update' || op.op === 'delete').length,
    0,
  );
}

// ─── Items too big for one group ────────────────────────

/**
 * What one group may hold: the engine's batch budget as `estimateBatchBytes`
 * weighs it, and one op less than a provider yield window (room for the
 * engine's insert guard). A bigger event is written as a chain of groups
 * (`OpGroup.next`); a master's shadow is one column and may take a group of
 * its own beyond the budget (under one transaction for any event that syncs).
 */
const GROUP_BYTES = DEFAULT_TUNING.maxBatchBytes;
const GROUP_OPS = MAX_OPS_PER_YIELD - 1;

const weight = (ops: readonly ProviderOp[]) => (ops.length ? estimateBatchBytes(ops) : 0);

/** One group from asserts and write blocks whose `refs` index into their own block, asserts first. */
function assemble(ref: string, asserts: readonly ProviderOp[], blocks: ReadonlyArray<readonly ProviderOp[]>): OpGroup {
  const ops: ProviderOp[] = [...asserts];
  for (const block of blocks) {
    const offset = ops.length;
    for (const op of block) {
      if (op.op !== 'insert' || !op.refs) ops.push(op);
      else ops.push({ ...op, refs: Object.fromEntries(Object.entries(op.refs).map(([column, i]) => [column, i + offset])) });
    }
  }
  return { ref, ops };
}

/** Writes of one row (`refs` index into them), and the asserts that guard that row (none for a new row). */
export interface RowWrite {
  asserts: ProviderOp[];
  writes: ProviderOp[];
}

/**
 * Cuts row writes into groups of the budget, in order, a row never split:
 * each group starts with `guard`, the first also with `first`.
 */
function cutRows(ref: string, rows: readonly RowWrite[], guard: readonly ProviderOp[], first: readonly ProviderOp[] = []): OpGroup[] {
  const groups: OpGroup[] = [];
  let asserts: ProviderOp[] = [...guard, ...first];
  let blocks: ProviderOp[][] = [];
  let ops = asserts.length;
  let bytes = weight(asserts);
  for (const row of rows) {
    const n = row.asserts.length + row.writes.length;
    const b = weight(row.asserts) + weight(row.writes);
    if (blocks.length && (ops + n > GROUP_OPS || bytes + b > GROUP_BYTES)) {
      groups.push(assemble(ref, asserts, blocks));
      asserts = [...guard];
      blocks = [];
      ops = asserts.length;
      bytes = weight(asserts);
    }
    asserts.push(...row.asserts);
    blocks.push(row.writes);
    ops += n;
    bytes += b;
  }
  if (blocks.length) groups.push(assemble(ref, asserts, blocks));
  return groups;
}

function chained(groups: readonly OpGroup[]): OpGroup {
  const [first, ...next] = groups;
  return next.length ? { ...first, next } : first;
}

/**
 * The writes into an existing event as one group: asserts first (`master`,
 * the exception rows' `rows` in order, `count`), then the writes (`deletes`,
 * the master's `master`, `updates`, `inserts`). When that is more than a group
 * may hold, a chain: the exception rows' writes in groups of the budget, each
 * asserting the master row and the rows it writes, the first also the number
 * of exception rows; then the master's write, with its new shadow, last,
 * asserting the other rows. Cut off in between, the item is planned again
 * from the old shadow, so no server change to a row not written yet is taken
 * as done.
 */
export function eventWrite(
  ref: string,
  parts: {
    master: ProviderOp[];
    rows: Map<number, ProviderOp[]>;
    count: ProviderOp[];
    deletes: Array<RowWrite & { row: number }>;
    masterWrite: ProviderOp[];
    updates: Array<RowWrite & { row: number }>;
    inserts: RowWrite[];
  },
): OpGroup {
  const rowAsserts = [...parts.rows.values()].flat();
  const single = assemble(ref, [...parts.master, ...rowAsserts, ...parts.count], [
    ...parts.deletes.map((d) => d.writes),
    parts.masterWrite,
    ...parts.updates.map((u) => u.writes),
    ...parts.inserts.map((i) => i.writes),
  ]);
  if (single.ops.length <= GROUP_OPS && estimateBatchBytes(single.ops) <= GROUP_BYTES) return single;
  const writing = [...parts.deletes, ...parts.updates].filter((w) => w.writes.length);
  if (!writing.length && !parts.inserts.length) return single;
  const written = new Set(writing.map((w) => w.row));
  const rows: RowWrite[] = [
    ...writing.map((w) => ({ asserts: parts.rows.get(w.row) ?? [], writes: w.writes })),
    ...parts.inserts,
  ];
  // The master row's own assert guards every group; its attendees and reminders go with its write.
  const groups = cutRows(ref, rows, parts.master.slice(0, 1), parts.count);
  const rest = [...parts.rows].filter(([row]) => !written.has(row)).flatMap(([, asserts]) => asserts);
  groups.push(assemble(ref, [...parts.master, ...rest], [parts.masterWrite]));
  return chained(groups);
}

/**
 * A new event's rows as one group, or, when they are more than a group may
 * hold, as a chain: `master` (the master's insert with its identity but
 * without its shadow), its exception rows in groups of the budget, each
 * asserting the master by `masterRef` and linked to it by ORIGINAL_SYNC_ID
 * (the provider fills ORIGINAL_ID from it and CALENDAR_ID), then `shadow`.
 * Cut off in between, the next download finds the master by its identity and
 * writes what is missing; a master without a shadow merges like an adopted one.
 */
export function eventInsert(
  ref: string,
  single: OpGroup,
  partsOf: () => { masterRef: string; master: ProviderOp[]; exceptions: RowWrite[]; shadow: CalendarEventWire },
): OpGroup {
  if (single.ops.length <= GROUP_OPS && estimateBatchBytes(single.ops) <= GROUP_BYTES) return single;
  const parts = partsOf();
  const byIdentity = { table: 'events' as const, where: `${Events._SYNC_ID} = ?`, args: [parts.masterRef], expectCount: 1 };
  const groups = [assemble(ref, [], [parts.master]), ...cutRows(ref, parts.exceptions, [{ op: 'assert', ...byIdentity }])];
  groups.push({ ref, ops: [{ op: 'update', ...byIdentity, values: { [Events.SYNC_DATA1]: JSON.stringify(parts.shadow) } }] });
  return chained(groups);
}
