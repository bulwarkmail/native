/**
 * Provider ops the contacts planner emits. Every write into an existing item
 * is guarded: the group asserts the VERSION (and DIRTY) the plan was made
 * from, and ops that address one row by id expect exactly one row
 * (docs/device-sync.md, "Merge rules").
 */
import { Data, GroupMembership, MimeType, RawContacts } from '../android-columns';
import type { LocalContact } from '../planner';
import type { ProviderOp, WriteRow } from '../types';
import { encodeBaseline } from './cells';
import { predictStored, SPECS, type Unit } from './project';

export function assertContact(local: LocalContact, dirty: boolean | null): ProviderOp {
  const values: Record<string, number> = { [RawContacts.VERSION]: local.version };
  if (dirty !== null) values[RawContacts.DIRTY] = dirty ? 1 : 0;
  return { op: 'assert', table: 'raw_contacts', id: local.rawContactId, values, expectCount: 1 };
}

export function updateRawContact(id: number, values: WriteRow): ProviderOp {
  return { op: 'update', table: 'raw_contacts', id, values, expectCount: 1 };
}

/** The cells a unit writes (a membership names its group by row id: GROUP_SOURCE_ID is read-only here). */
function unitValues(u: Unit): WriteRow {
  const out: WriteRow = {};
  for (const [column, value] of Object.entries(u.cells)) {
    if (column !== GroupMembership.GROUP_SOURCE_ID) out[column] = value;
  }
  return { ...out, ...(u.extra ?? {}) };
}

/** DATA_SYNC1..3 for a row written from a unit: key, photo hash and the predicted stored cells. */
export function syncValues(u: Unit): WriteRow {
  const out: WriteRow = {
    [Data.DATA_SYNC1]: u.key,
    [Data.DATA_SYNC3]: encodeBaseline(predictStored(u), SPECS[u.mimetype].columns),
  };
  if (u.mimetype === MimeType.PHOTO) out[Data.DATA_SYNC2] = u.photoHash ?? null;
  return out;
}

/** Inserts a unit's row; `parent` is the raw contact id, or `{ ref }` to an insert earlier in the group. */
export function insertUnit(parent: number | { ref: number }, u: Unit, keyed: boolean): ProviderOp {
  const values: WriteRow = { [Data.MIMETYPE]: u.mimetype, ...unitValues(u), ...(keyed ? syncValues(u) : {}) };
  if (typeof parent === 'number') {
    values[Data.RAW_CONTACT_ID] = parent;
    return { op: 'insert', table: 'data', values };
  }
  return { op: 'insert', table: 'data', values, refs: { [Data.RAW_CONTACT_ID]: parent.ref } };
}

/** Rewrites a row from a unit; photo bytes only go when the hash differs. */
export function updateUnit(rowId: number, u: Unit, keyed: boolean, withBytes = true): ProviderOp {
  const values = unitValues(u);
  if (!withBytes) delete values[Data.DATA15];
  return { op: 'update', table: 'data', id: rowId, values: { ...values, ...(keyed ? syncValues(u) : {}) }, expectCount: 1 };
}

export function updateData(rowId: number, values: WriteRow): ProviderOp {
  return { op: 'update', table: 'data', id: rowId, values, expectCount: 1 };
}

export function deleteData(rowId: number): ProviderOp {
  return { op: 'delete', table: 'data', id: rowId, expectCount: 1 };
}

/** A delete that tolerates a row that is already gone (purges, server deletes). */
export function deleteWhereId(table: 'raw_contacts' | 'groups' | 'data', id: number): ProviderOp {
  return { op: 'delete', table, where: '_id = ?', args: [id] };
}

/** A write that tolerates a row that is already gone (keep-dirty baselines of rows edited meanwhile). */
export function updateWhereId(table: 'data', id: number, values: WriteRow): ProviderOp {
  return { op: 'update', table, where: '_id = ?', args: [id], values };
}
