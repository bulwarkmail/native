/**
 * After the server accepted an upload (docs/device-sync.md, "Uploads",
 * "Afterwards"): when the rows were edited again while the upload was under
 * way, the clearing group's assert fails and `keepDirtyOps` apply instead.
 * They write the identity and the new shadow, and set the baselines of the
 * uploaded units to the values that were uploaded (the rows as read before
 * the upload), leaving the rows and DIRTY alone: the newer edit, or a revert
 * to the old value, uploads next time.
 */
import { Events } from '../android-columns';
import type { CalendarContext, EventBaseline, LocalEvent, LocalEventRow, OpGroup } from '../planner';
import type { CalendarEventWire } from '../wire';
import { exceptionRef, objectRef } from '../common/ids';
import { clone } from '../common/json';
import { EXCEPTION_CELLS, MASTER_CELLS, encodeBaseline, makeBaseline } from './columns';
import { COLUMN_UNITS } from './units';

export interface UploadedUnits {
  /** Everything was uploaded (a create). */
  all: boolean;
  master: Set<string>;
  /** By exception row id. */
  exceptions: Map<number, Set<string>>;
  /** Exception rows whose instance is excluded on the server now. */
  removed: Set<number>;
}

function unitColumns(unit: string): readonly string[] {
  return COLUMN_UNITS[unit] ?? (unit.startsWith('exdate:') ? [Events.EXDATE] : []);
}

function uploadedBaseline(row: LocalEventRow, isException: boolean, units: Set<string> | null, all: boolean): EventBaseline {
  const uploaded = makeBaseline(
    row.cells,
    isException ? EXCEPTION_CELLS : MASTER_CELLS,
    row.attendees.map((a) => a.cells),
    row.reminders.map((r) => r.cells),
  );
  if (all || !row.baseline) return uploaded;
  const next = clone(row.baseline);
  for (const unit of units ?? []) {
    for (const c of unitColumns(unit)) next.cells[c] = uploaded.cells[c] ?? null;
    if (unit === 'reminders') next.reminders = uploaded.reminders;
    if (unit.startsWith('attendee')) next.attendees = uploaded.attendees;
  }
  return next;
}

export function keepDirtyGroup(local: LocalEvent, server: CalendarEventWire, uploaded: UploadedUnits, ctx: CalendarContext): OpGroup {
  const masterRef = objectRef(ctx.jmapAccountId, server.id);
  const ops: OpGroup['ops'] = [
    {
      op: 'update',
      table: 'events',
      id: local.eventId,
      values: {
        [Events._SYNC_ID]: masterRef,
        [Events.UID_2445]: typeof server.uid === 'string' ? server.uid : null,
        [Events.SYNC_DATA1]: JSON.stringify(server),
        [Events.SYNC_DATA3]: null,
        [Events.SYNC_DATA4]: encodeBaseline(uploadedBaseline(local, false, uploaded.master, uploaded.all)),
        [Events.SYNC_DATA5]: null,
      },
      expectCount: 1,
    },
  ];
  for (const x of local.exceptions) {
    // An instance deleted on the device is an exclusion on the server now: its row has done its job.
    if (uploaded.removed.has(x.eventId)) {
      ops.push({ op: 'delete', table: 'events', id: x.eventId, expectCount: 1 });
      continue;
    }
    const units = uploaded.exceptions.get(x.eventId);
    if ((!uploaded.all && !units) || !x.recurrenceId) continue;
    const all = uploaded.all || !!units?.has('new');
    ops.push({
      op: 'update',
      table: 'events',
      id: x.eventId,
      values: {
        [Events._SYNC_ID]: exceptionRef(masterRef, x.recurrenceId),
        [Events.SYNC_DATA2]: x.recurrenceId,
        [Events.ORIGINAL_SYNC_ID]: masterRef,
        [Events.SYNC_DATA4]: encodeBaseline(uploadedBaseline(x, true, units ?? null, all)),
      },
      expectCount: 1,
    });
  }
  return { ref: masterRef, ops };
}
