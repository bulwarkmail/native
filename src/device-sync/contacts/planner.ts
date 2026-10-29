/**
 * The contacts planner (docs/device-sync.md, "Contacts mapping" and "Change
 * detection and merge rules"): JSContact cards ↔ ContactsContract rows for
 * individual and org cards, group cards ↔ Groups rows. Pure: the engine does
 * every query, batch and request.
 *
 * Memberships are synced only when the context has `groupsOf`.
 */
import { Data, MimeType } from '../android-columns';
import type { ContactsPlanner, LocalContact, OpGroup } from '../planner';
import type { ProviderOp } from '../types';
import { changedFromBaseline, encodeBaseline } from './cells';
import { DATA_COLUMNS, decodeContact, decodeGroup, GROUP_COLUMNS, RAW_CONTACT_COLUMNS } from './columns';
import { cardUnits, planContactDownload } from './download';
import {
  groupFingerprint,
  planGroupAccepted,
  planGroupDownload,
  planGroupLocalDelete,
  planGroupUpload,
  planMembershipUploads,
} from './groups';
import { entryKey } from './keys';
import { rowGroup } from './members';
import { assertContact, deleteWhereId, updateData } from './ops';
import { SPECS } from './project';
import { contactFingerprint, planContactAccepted, planContactUpload } from './upload';

export { contactFingerprint, groupFingerprint };

/** Enough context to project a shadow for its keys. */
const OFFLINE = { nameForUid: () => null, photoBytes: () => null, groupRowIdBySourceId: () => null };

function planLocalDelete(local: LocalContact): OpGroup {
  return { ref: local.sourceId ?? `row:${local.rawContactId}`, ops: [deleteWhereId('raw_contacts', local.rawContactId)] };
}

/**
 * Baselines of a clean contact's rows that no longer describe the rows (the
 * provider normalised a write, or the read-back after a chunk never ran):
 * rewritten to the rows' current cells. Photo rows get the file id the
 * provider assigned.
 */
function planBaselineHeal(local: LocalContact): OpGroup | null {
  if (local.dirty || local.deleted || !local.sourceId) return null;
  const known = new Set(cardUnits(local.shadow, OFFLINE).map((u) => u.key));
  const ops: ProviderOp[] = [];
  for (const row of local.rows) {
    const spec = SPECS[row.mimetype];
    if (!spec || !row.key) continue;
    const ours = row.mimetype === MimeType.GROUP_MEMBERSHIP ? row.key === entryKey('members', rowGroup(row) ?? '') : known.has(row.key);
    if (!ours) continue;
    const stale = !row.baseline
      || changedFromBaseline(row.cells, row.baseline, spec.columns).length > 0
      || spec.columns.some((c) => !(c in row.baseline!));
    if (stale) ops.push(updateData(row.id, { [Data.DATA_SYNC3]: encodeBaseline(row.cells, spec.columns) }));
  }
  if (!ops.length) return null;
  return { ref: local.sourceId, ops: [assertContact(local, false), ...ops] };
}

export const contactsPlanner: ContactsPlanner = {
  rawContactColumns: RAW_CONTACT_COLUMNS,
  dataColumns: DATA_COLUMNS,
  groupColumns: GROUP_COLUMNS,
  decodeContact,
  decodeGroup,
  planDownload: planContactDownload,
  planLocalDelete,
  planBaselineHeal,
  planUpload: planContactUpload,
  planAccepted: planContactAccepted,
  planGroupDownload,
  planGroupLocalDelete,
  planGroupUpload,
  planGroupAccepted,
  planMembershipUploads,
};
