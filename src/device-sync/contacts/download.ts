/**
 * Server cards into rows (docs/device-sync.md, "Change detection and merge
 * rules"): inserts, writes that make a contact's rows the card's (a clean
 * contact, an accepted upload, a revert), and the per-unit merge of a dirty
 * contact with a new server version.
 *
 * Rows are matched to the shadow's units after its keys were mapped to the
 * new version's (Stalwart re-keys cards written over CardDAV). A clean write
 * then touches only rows that differ, so an echo of our own upload writes
 * nothing. A merge writes only units the server changed, and never gives a
 * key to a row of a kind an editor rewrote (all its rows keyless): a keyed
 * row there would later make the entries the editor could not show look
 * deleted.
 */
import { Data, MimeType, RawContacts } from '../android-columns';
import { canonicalJson } from '../common/json';
import { objectRef, parseCollectionKey, parseObjectRef } from '../common/ids';
import type { ContactCardWire, ContactsContext, DownloadPlan, LocalContact, LocalDataRow } from '../planner';
import type { ProviderOp, WriteRow } from '../types';
import { changedFromBaseline, encodeBaseline, sameCell } from './cells';
import { localChanges, sameUnit } from './diff';
import { deletionsInferred, inPlaceEvidence, matchKind, reconcileKeys, type KindMatch } from './matching';
import { editableGroups, planMemberships, remoteMemberships, shadowMemberOf, withMemberOf, withoutMemberOf } from './members';
import { assertContact, deleteData, insertUnit, updateData, updateRawContact, updateUnit } from './ops';
import { isPhotoAbsent, shadowOf, withPhotoAbsent } from './photo';
import { KIND_ORDER, projectCard, rowMatchesUnit, SPECS, type Unit } from './project';

const ENTRY_KINDS = KIND_ORDER.filter((k) => k !== MimeType.GROUP_MEMBERSHIP);

type Ctx = ContactsContext;

export function cardUnits(card: ContactCardWire | null, ctx: Pick<Ctx, 'nameForUid' | 'photoBytes' | 'groupRowIdBySourceId'>): Unit[] {
  return card ? projectCard(withoutMemberOf(card), ctx, { memberOf: null }) : [];
}

/** Raw contact columns that describe the server card: collections, shadow, read-only flag. */
function cardColumns(card: ContactCardWire, shadow: ContactCardWire, ctx: Ctx): WriteRow {
  return {
    [RawContacts.SYNC1]: ctx.selectedCollections(card).join(',') || null,
    [RawContacts.SYNC2]: JSON.stringify(shadow),
    [RawContacts.RAW_CONTACT_IS_READ_ONLY]: ctx.isReadOnly(card) ? 1 : 0,
  };
}

/** Only the raw contact columns that differ from what the local item holds. */
function changedRawColumns(local: LocalContact, values: WriteRow): WriteRow {
  const current: Record<string, unknown> = {
    [RawContacts.SOURCE_ID]: local.sourceId,
    [RawContacts.SYNC1]: local.collections.join(',') || null,
    [RawContacts.SYNC2]: local.shadow ? JSON.stringify(local.shadow) : null,
    [RawContacts.SYNC3]: local.pending ? JSON.stringify(local.pending) : null,
    [RawContacts.SYNC4]: local.poison ? JSON.stringify(local.poison) : null,
    [RawContacts.DIRTY]: local.dirty ? 1 : 0,
  };
  const out: WriteRow = {};
  for (const [column, value] of Object.entries(values)) {
    if (column === RawContacts.RAW_CONTACT_IS_READ_ONLY) continue;
    if (column === RawContacts.SYNC2) {
      const before = local.shadow ? canonicalJson(local.shadow) : null;
      const after = typeof value === 'string' ? canonicalJson(JSON.parse(value)) : null;
      if (before !== after) out[column] = value;
    } else if (!sameCell(current[column], value as unknown)) {
      out[column] = value;
    }
  }
  // The providers never return the read-only flag, so it can't be compared:
  // it goes along whenever the raw contact is written anyway.
  if (Object.keys(out).length && RawContacts.RAW_CONTACT_IS_READ_ONLY in values) {
    out[RawContacts.RAW_CONTACT_IS_READ_ONLY] = values[RawContacts.RAW_CONTACT_IS_READ_ONLY];
  }
  return out;
}

/** Row keys after the server re-keyed: mapped, or marked gone so they can't meet a new entry's key. */
function renameRows(rows: LocalDataRow[], base: Unit[], keyMap: Map<string, string>): LocalDataRow[] {
  const baseKeys = new Set(base.map((u) => u.key));
  return rows.map((r) => {
    if (!r.key) return r;
    const key = keyMap.get(r.key) ?? (baseKeys.has(r.key) ? `~gone:${r.key}` : r.key);
    return key === r.key ? r : { ...r, key };
  });
}

function renameUnits(base: Unit[], keyMap: Map<string, string>): Unit[] {
  return base.map((u) => ({ ...u, key: keyMap.get(u.key) ?? `~gone:${u.key}` }));
}

interface RowPlan {
  ops: ProviderOp[];
  conflicts: number;
  stillDirty: boolean;
  evidence: boolean;
  /** The card's photo is left without a row because it could not be written (the shadow's `~noPhoto`). */
  photoAbsent: boolean;
}

/**
 * Makes the rows of every entry kind the card's: rows matched to a unit are
 * rewritten when they differ (or only get their key and baseline), rows no
 * unit accounts for go, units without a row are inserted.
 */
function cleanRows(local: LocalContact, remote: Unit[], keyMap: Map<string, string>, base: Unit[], accepted: boolean): RowPlan {
  const ops: ProviderOp[] = [];
  let photoAbsent = false;
  const rows = renameRows(local.rows, base, keyMap);
  const kinds = ENTRY_KINDS.map((k) => matchKind(k, rows, remote));
  for (const kind of kinds) {
    for (const m of kind.matched) {
      const original = local.rows.find((r) => r.id === m.row.id)!;
      const { unit } = m;
      const columns = SPECS[unit.mimetype].columns;
      if (unit.mimetype === MimeType.PHOTO) {
        if (accepted && unit.photoHash && original.photoHash !== unit.photoHash && localChanges({ ...m, row: original }).length) {
          // The device's own photo just uploaded: record the server's hash, keep the picture.
          // (A photo that could not be sent keeps its old baseline, so it still counts as changed.)
          ops.push(updateData(m.row.id, {
            [Data.DATA_SYNC1]: unit.key,
            [Data.DATA_SYNC2]: unit.photoHash ?? null,
            [Data.DATA_SYNC3]: encodeBaseline(m.row.cells, columns),
          }));
        } else if (original.photoHash !== unit.photoHash && unit.extra) {
          ops.push(updateUnit(m.row.id, unit, true));
        } else if (original.key !== unit.key) {
          ops.push(updateData(m.row.id, { [Data.DATA_SYNC1]: unit.key }));
        }
        continue;
      }
      if (!rowMatchesUnit(unit, m.row.cells, sameCell)) ops.push(updateUnit(m.row.id, unit, true));
      else if (original.key !== unit.key || !original.baseline || changedFromBaseline(m.row.cells, original.baseline, columns).length) {
        // Same content: only the key and the baseline (what the provider holds now) are written.
        ops.push(updateData(m.row.id, { [Data.DATA_SYNC1]: unit.key, [Data.DATA_SYNC3]: encodeBaseline(m.row.cells, columns) }));
      }
    }
    for (const row of kind.fresh) ops.push(deleteData(row.id));
    for (const unit of kind.missing) {
      if (unit.mimetype === MimeType.PHOTO && !unit.extra) {
        photoAbsent = true;
        continue;
      }
      ops.push(insertUnit(local.rawContactId, unit, true));
    }
  }
  return { ops, conflicts: 0, stillDirty: false, evidence: inPlaceEvidence(kinds), photoAbsent };
}

/** Per-unit merge of a dirty contact's rows with a new server version; the server wins real conflicts. */
function mergeRows(local: LocalContact, base: Unit[], remote: Unit[], keyMap: Map<string, string>): RowPlan {
  const ops: ProviderOp[] = [];
  let conflicts = 0;
  let stillDirty = false;
  let photoAbsent = false;
  const rows = renameRows(local.rows, base, keyMap);
  const renamedBase = renameUnits(base, keyMap);
  const kinds: KindMatch[] = ENTRY_KINDS.map((k) => matchKind(k, rows, renamedBase));
  const evidence = inPlaceEvidence(kinds);
  const mapped = new Set(keyMap.values());

  for (const kind of kinds) {
    const start = ops.length;
    const remoteOf = new Map(remote.filter((u) => u.mimetype === kind.mimetype).map((u) => [u.key, u]));
    const hasKeyed = kind.matched.some((m) => m.how === 'key');
    const hasKeyless = kind.fresh.length > 0 || kind.matched.some((m) => m.how !== 'key');
    const keyed = hasKeyed || !hasKeyless;
    // A photo the device never held (`~noPhoto`) was not deleted there.
    const deletions = kind.mimetype !== MimeType.STRUCTURED_NAME && deletionsInferred(kind, evidence)
      && !(kind.mimetype === MimeType.PHOTO && isPhotoAbsent(local.shadow));
    const write = (row: LocalDataRow, unit: Unit) => {
      if (unit.mimetype === MimeType.PHOTO && !unit.extra) return;
      ops.push(updateUnit(row.id, unit, keyed));
    };

    for (const m of kind.matched) {
      const original = local.rows.find((r) => r.id === m.row.id)!;
      const remoteUnit = remoteOf.get(m.unit.key);
      const changedHere = localChanges({ ...m, row: original }).length > 0;
      if (!remoteUnit) {
        // Removed on the server: the delete wins, over a local edit too.
        if (changedHere) conflicts++;
        ops.push(deleteData(m.row.id));
      } else if (sameUnit(m.unit, remoteUnit)) {
        if (changedHere) stillDirty = true;
        if (m.how === 'key' && original.key !== remoteUnit.key) ops.push(updateData(m.row.id, { [Data.DATA_SYNC1]: remoteUnit.key }));
      } else if (!changedHere) {
        write(m.row, remoteUnit);
      } else if (remoteUnit.mimetype !== MimeType.PHOTO && rowMatchesUnit(remoteUnit, m.row.cells, sameCell)) {
        // Both sides made the same change: converged, new baseline.
        if (keyed) {
          ops.push(updateData(m.row.id, { [Data.DATA_SYNC1]: remoteUnit.key, [Data.DATA_SYNC3]: encodeBaseline(m.row.cells, SPECS[kind.mimetype].columns) }));
        }
      } else {
        conflicts++;
        write(m.row, remoteUnit);
      }
    }

    for (const unit of kind.missing) {
      const remoteUnit = remoteOf.get(unit.key);
      if (!deletions) continue;
      if (!remoteUnit) continue;
      if (sameUnit(unit, remoteUnit)) stillDirty = true;
      else if (!(remoteUnit.mimetype === MimeType.PHOTO && !remoteUnit.extra)) {
        conflicts++;
        ops.push(insertUnit(local.rawContactId, remoteUnit, keyed));
      }
    }

    // Entries the server added: a new local row with the same value converged with it.
    const fresh = [...kind.fresh];
    const spec = SPECS[kind.mimetype];
    for (const unit of remoteOf.values()) {
      if (mapped.has(unit.key)) continue;
      const p = spec.primary(unit.cells);
      const twin = p === null ? -1 : fresh.findIndex((r) => spec.primary(r.cells) === p);
      if (twin >= 0) {
        const [row] = fresh.splice(twin, 1);
        if (keyed) ops.push(updateUnit(row.id, unit, true));
      } else if (!(unit.mimetype === MimeType.PHOTO && !unit.extra)) {
        ops.push(insertUnit(local.rawContactId, unit, keyed));
      }
    }
    if (fresh.length) stillDirty = true;

    if (kind.mimetype === MimeType.PHOTO) {
      // The server's photo is left without a row it could not get, unless a local deletion of it waits for its upload.
      const photo = [...remoteOf.values()][0];
      const deletionWaits = !!photo && deletions && kind.missing.some((u) => sameUnit(u, photo));
      photoAbsent = !!photo && !kind.rows.length && !ops.slice(start).some((o) => o.op === 'insert') && !deletionWaits;
    }
  }
  return { ops, conflicts, stillDirty, evidence, photoAbsent };
}

export interface CleanWriteOptions {
  /** DIRTY the assert expects; null asserts VERSION only (an accepted upload, a revert). */
  assertDirty: boolean | null;
  /** Clear DIRTY (unless membership changes still wait for the server). */
  clearDirty: boolean;
  /** Extra raw contact columns: identity, SYNC3/SYNC4 resets, DELETED. */
  raw?: WriteRow;
  /** The rows' changes were just uploaded (planAccepted): a changed photo is the server's now. */
  accepted?: boolean;
  /** The memberships the rows held at the last write, when there is no shadow to say: a new contact's are none. */
  memberBase?: string[];
}

/** The JMAP account a local contact belongs to. */
export function accountOf(local: LocalContact, ctx: Ctx): string {
  return parseObjectRef(local.sourceId)?.accountId ?? parseCollectionKey(local.pending?.target)?.accountId ?? ctx.jmapAccountId;
}

/**
 * The ops that make a local contact's rows, shadow and raw columns the
 * server card's, behind the VERSION assert. Membership changes that the
 * server does not have yet stay (and keep the contact dirty), unless it can
 * never take them: those are put back (`revertedMembers`).
 */
export function cleanWrite(local: LocalContact, card: ContactCardWire, ctx: Ctx, options: CleanWriteOptions) {
  const server = withoutMemberOf(card);
  const base = cardUnits(local.shadow, ctx);
  const remote = cardUnits(server, ctx);
  const keyMap = reconcileKeys(base, remote);
  const rows = cleanRows(local, remote, keyMap, base, options.accepted ?? false);
  const members = planMemberships({
    rows: local.rows,
    base: shadowMemberOf(local.shadow) ?? options.memberBase ?? null,
    remote: remoteMemberships(server, ctx),
    evidence: rows.evidence,
    restore: true,
    parent: local.rawContactId,
    groupRowIdBySourceId: (g) => ctx.groupRowIdBySourceId(g),
    editable: editableGroups(ctx, accountOf(local, ctx)),
  });
  const shadow = withPhotoAbsent(withMemberOf(shadowOf(server), members.memberOf), rows.photoAbsent);
  const raw = changedRawColumns(local, {
    ...cardColumns(server, shadow, ctx),
    ...(options.raw ?? {}),
    ...(options.clearDirty && !members.pending ? { [RawContacts.DIRTY]: 0 } : {}),
  });
  const dataOps = [...rows.ops, ...members.ops];
  const ops: ProviderOp[] = [];
  if (Object.keys(raw).length) ops.push(updateRawContact(local.rawContactId, raw));
  ops.push(...dataOps);
  return {
    ops: ops.length ? [assertContact(local, options.assertDirty), ...ops] : [],
    writes: ops.length,
    pendingMembers: members.pending,
    revertedMembers: members.reverted,
  };
}

function insertPlan(card: ContactCardWire, ctx: Ctx): DownloadPlan {
  const identity = objectRef(ctx.jmapAccountId, card.id);
  const units = cardUnits(card, ctx);
  const remote = remoteMemberships(card, ctx);
  const members = planMemberships({
    rows: [],
    base: remote === null ? null : [],
    remote,
    evidence: false,
    restore: true,
    parent: { ref: 0 },
    groupRowIdBySourceId: (g) => ctx.groupRowIdBySourceId(g),
  });
  // A photo without bytes to write (too large, or not fetched) stays on the server only.
  const shadow = withPhotoAbsent(withMemberOf(shadowOf(card), members.memberOf), units.some((u) => u.mimetype === MimeType.PHOTO && !u.extra));
  const ops: ProviderOp[] = [
    { op: 'insert', table: 'raw_contacts', values: { [RawContacts.SOURCE_ID]: identity, [RawContacts.DIRTY]: 0, ...cardColumns(card, shadow, ctx) } },
    ...units.filter((u) => u.mimetype !== MimeType.PHOTO || u.extra).map((u) => insertUnit({ ref: 0 }, u, true)),
    ...members.ops,
  ];
  return { ops: { ref: identity, ops }, conflicts: 0, stillDirty: false, effect: 'insert', writes: ops.length };
}

export function planContactDownload(card: ContactCardWire, local: LocalContact | null, ctx: Ctx): DownloadPlan {
  const server = withoutMemberOf(card);
  const identity = objectRef(ctx.jmapAccountId, server.id);
  if (!local) return insertPlan(server, ctx);
  const none = (stillDirty: boolean): DownloadPlan => ({ ops: { ref: identity, ops: [] }, conflicts: 0, stillDirty, effect: 'none', writes: 0 });
  if (local.deleted) {
    // Deleted on the device: the delete wins over a server edit, so the rows stay as they are.
    // Only the shadow (and an identity never written) follows the card: the deletion uploads
    // against the card as it is now, which may also sit in books this device does not sync.
    const shadow = withMemberOf(shadowOf(server), shadowMemberOf(local.shadow));
    const raw = changedRawColumns(local, {
      ...(local.sourceId ? {} : { [RawContacts.SOURCE_ID]: identity, [RawContacts.SYNC3]: null }),
      [RawContacts.SYNC2]: JSON.stringify(shadow),
    });
    if (!Object.keys(raw).length) return none(true);
    const ops = [assertContact(local, local.dirty), updateRawContact(local.rawContactId, raw)];
    return { ops: { ref: identity, ops }, conflicts: 0, stillDirty: true, effect: 'update', writes: 1 };
  }

  if (!local.sourceId) {
    // Our own create whose identity was never written: adopt it. The rows stay
    // as they are and upload against the card as their new shadow.
    const members = shadowMemberOf(local.shadow) ?? [];
    const shadow = withMemberOf(shadowOf(server), remoteMemberships(server, ctx) === null ? null : members);
    const ops = [
      assertContact(local, local.dirty),
      updateRawContact(local.rawContactId, { [RawContacts.SOURCE_ID]: identity, [RawContacts.SYNC3]: null, ...cardColumns(server, shadow, ctx) }),
    ];
    return { ops: { ref: identity, ops }, conflicts: 0, stillDirty: true, effect: 'update', writes: 1 };
  }

  const uidChanged = typeof local.shadow?.uid === 'string' && typeof server.uid === 'string' && local.shadow!.uid !== server.uid;
  if (!local.dirty || uidChanged) {
    // A different object behind the same id is replaced, never merged into.
    const target = uidChanged ? { ...local, shadow: null, rows: local.rows.map((r) => ({ ...r, key: null })) } : local;
    const write = cleanWrite(target, server, ctx, { assertDirty: local.dirty, clearDirty: uidChanged });
    return {
      ops: { ref: identity, ops: write.ops },
      conflicts: 0,
      stillDirty: write.pendingMembers,
      effect: write.writes ? 'update' : 'none',
      writes: write.writes,
    };
  }

  const base = cardUnits(local.shadow, ctx);
  const remote = cardUnits(server, ctx);
  const keyMap = reconcileKeys(base, remote);
  const rows = mergeRows(local, base, remote, keyMap);
  const members = planMemberships({
    rows: local.rows,
    base: shadowMemberOf(local.shadow),
    remote: remoteMemberships(server, ctx),
    evidence: rows.evidence,
    restore: false,
    parent: local.rawContactId,
    groupRowIdBySourceId: (g) => ctx.groupRowIdBySourceId(g),
  });
  const shadow = withPhotoAbsent(withMemberOf(shadowOf(server), members.memberOf), rows.photoAbsent);
  const raw = changedRawColumns(local, cardColumns(server, shadow, ctx));
  const ops: ProviderOp[] = [];
  if (Object.keys(raw).length) ops.push(updateRawContact(local.rawContactId, raw));
  ops.push(...rows.ops, ...members.ops);
  return {
    ops: { ref: identity, ops: ops.length ? [assertContact(local, true), ...ops] : [] },
    conflicts: rows.conflicts,
    stillDirty: rows.stillDirty || members.pending,
    effect: ops.length ? 'update' : 'none',
    writes: ops.length,
  };
}
