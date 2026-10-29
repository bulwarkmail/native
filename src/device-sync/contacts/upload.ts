/**
 * Device changes to the server (docs/device-sync.md, "Uploads"): per changed
 * unit a patch of the sub-fields whose columns changed; a whole map only
 * where Stalwart needs one (the first entry of a map, and deletions, which
 * resend the map from the fresh shadow minus the entry, except `addresses`,
 * where `addresses/<k>: null` is clean); never a property Android can't
 * represent. New contacts are claimed (a uid and a target book, written
 * before anything is sent) and then created.
 */
import { Data, MimeType, RawContacts } from '../android-columns';
import { collectionKey, parseCollectionKey, parseObjectRef, objectRef } from '../common/ids';
import { jsonHash } from '../common/json';
import { applyPatch, ptr, setInPatch, type PatchObject } from '../common/patch';
import type {
  AcceptedPlan,
  ContactCardWire,
  ContactsContext,
  LocalContact,
  OpGroup,
  UploadAction,
  UploadPlan,
} from '../planner';
import type { ProviderOp } from '../types';
import { encodeBaseline } from './cells';
import { localChanges, uploadCells } from './diff';
import { accountOf, cardUnits, cleanWrite } from './download';
import { newEntries, unitEdits, unitEntries, type Edit, type NewEntry } from './entries';
import { parseEntryKey } from './keys';
import { deletionsInferred, inPlaceEvidence, matchKind, type KindMatch } from './matching';
import { shadowMemberOf, withMemberOf, withoutMemberOf } from './members';
import { NAME_COLUMNS, namePatch } from './name';
import { assertContact, deleteWhereId, updateRawContact, updateWhereId } from './ops';
import { isHashUri, isPhotoAbsent, jpegDataUri, photoEntry, shadowOf, withPhotoAbsent } from './photo';
import { isEmptyRow, KIND_ORDER, SPECS } from './project';

type Ctx = ContactsContext;

const ENTRY_KINDS = KIND_ORDER.filter((k) => k !== MimeType.GROUP_MEMBERSHIP);

/**
 * What a poison marker's `fp` is taken of: the engine writes the markers
 * (engine/poison.ts) with this same content, so a skip here agrees with them.
 */
export function contactFingerprint(local: LocalContact): string {
  return jsonHash({
    deleted: local.deleted,
    shadow: local.shadow,
    rows: local.rows.map((r) => JSON.stringify([r.mimetype, r.cells])).sort(),
  });
}

function backedOff(local: LocalContact, ctx: Ctx, actions?: UploadAction<ContactCardWire>[]): boolean {
  const p = local.poison;
  if (!p || !(p.until > ctx.now)) return false;
  return p.fp === contactFingerprint(local) || (actions !== undefined && p.fp === jsonHash(actions));
}

interface Changes {
  edits: Edit[];
  added: NewEntry[];
  removed: Array<{ map: string; key: string }>;
  name: Record<string, unknown>;
  /** Rows whose keyed units uploaded, for the keep-dirty baselines. */
  uploadedRows: number[];
}

/** Everything the rows changed against a shadow (an empty card for a new contact). */
function collectChanges(local: LocalContact, shadow: ContactCardWire, ctx: Ctx): Changes {
  const base = cardUnits(shadow, ctx);
  const kinds: KindMatch[] = ENTRY_KINDS.map((k) => matchKind(k, local.rows, base));
  const evidence = inPlaceEvidence(kinds);
  const out: Changes = { edits: [], added: [], removed: [], name: {}, uploadedRows: [] };
  for (const kind of kinds) {
    if (kind.mimetype === MimeType.STRUCTURED_NAME) {
      const m = kind.matched[0];
      const row = m?.row ?? kind.fresh[0];
      if (!row) continue;
      const changed = m ? localChanges(m) : [...NAME_COLUMNS];
      out.name = namePatch(m ? shadow.name : undefined, row.cells, new Set(changed));
      if (m && changed.length) out.uploadedRows.push(row.id);
      continue;
    }
    if (kind.mimetype === MimeType.PHOTO) {
      photoChanges(local, kind, evidence, ctx, out);
      continue;
    }
    for (const m of kind.matched) {
      const changed = localChanges(m);
      if (!changed.length) continue;
      const shown = kind.mimetype === MimeType.RELATION ? (m.unit.cells[Data.DATA1] as string | null) : null;
      const e = unitEdits(kind.mimetype, m.unit.key, shadow, uploadCells(m), m.unit.cells, new Set(changed), shown, m.how === 'key');
      out.edits.push(...e.edits);
      out.added.push(...e.added);
      out.removed.push(...e.removed);
      if (m.how === 'key') out.uploadedRows.push(m.row.id);
    }
    for (const row of kind.fresh) out.added.push(...newEntries(kind.mimetype, row.cells));
    if (deletionsInferred(kind, evidence)) {
      for (const unit of kind.missing) out.removed.push(...unitEntries(kind.mimetype, unit.key));
    }
  }
  return out;
}

function photoChanges(local: LocalContact, kind: KindMatch, evidence: boolean, ctx: Ctx, out: Changes): void {
  const m = kind.matched[0];
  const row = m?.row ?? kind.fresh[0];
  if (row && (!m || localChanges(m).length)) {
    const jpeg = ctx.devicePhoto(local.rawContactId);
    if (!jpeg) return;
    const uri = jpegDataUri(jpeg);
    if (m) {
      const key = parseEntryKey(m.unit.key)!.key;
      out.edits.push({ path: ['media', key, 'uri'], value: uri }, { path: ['media', key, 'mediaType'], value: 'image/jpeg' });
      out.uploadedRows.push(row.id);
    } else {
      out.added.push({ map: 'media', value: { kind: 'photo', uri, mediaType: 'image/jpeg' } });
    }
  } else if (!row && deletionsInferred(kind, evidence) && !isPhotoAbsent(local.shadow)) {
    // (A photo the device could not be given was never there to delete.)
    for (const unit of kind.missing) out.removed.push(...unitEntries(kind.mimetype, unit.key));
  }
}

const mapOf = (card: ContactCardWire, map: string): Record<string, unknown> | null => {
  const v = card[map];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
};

/** The PatchObject for a set of changes against the shadow. */
function assemble(changes: Changes, shadow: ContactCardWire, ctx: Ctx): PatchObject {
  const patch: PatchObject = {};
  for (const [pointer, value] of Object.entries(changes.name)) setInPatch(patch, pointer, value);

  // Keys for new entries; titles may point at an organization minted here.
  const minted = new Map<NewEntry, string>();
  const taken = new Map<string, Set<string>>();
  const takenOf = (map: string) => {
    if (!taken.has(map)) taken.set(map, new Set(Object.keys(mapOf(shadow, map) ?? {})));
    return taken.get(map)!;
  };
  const added = changes.added.filter((e) => {
    const keys = takenOf(e.map);
    if (e.key !== undefined) {
      if (keys.has(e.key) && !changes.removed.some((r) => r.map === e.map && r.key === e.key)) return false;
      minted.set(e, e.key);
    } else {
      minted.set(e, ctx.mintKey(keys));
    }
    keys.add(minted.get(e)!);
    return true;
  });
  const resolve = (value: unknown): unknown => (value && typeof value === 'object' && minted.has(value as NewEntry) ? minted.get(value as NewEntry) : value);
  const entryValue = (e: NewEntry) => {
    const v: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(e.value)) v[k] = resolve(x);
    return v;
  };

  const maps = new Set([...added.map((e) => e.map), ...changes.removed.map((r) => r.map)]);
  for (const map of maps) {
    const current = mapOf(shadow, map);
    const removed = changes.removed.filter((r) => r.map === map).map((r) => r.key);
    const adds = added.filter((e) => e.map === map);
    const remaining = Object.keys(current ?? {}).filter((k) => !removed.includes(k));
    // A map with a placeholder photo URI (the shadow keeps hashes) can't be resent whole.
    const resendable = map !== 'media' || remaining.every((k) => !isHashUri((current![k] as { uri?: unknown })?.uri));
    const empty = !current || !Object.keys(current).length;
    if (!empty && (map === 'addresses' || (removed.length && !resendable))) {
      for (const key of removed) setInPatch(patch, ptr(map, key), null);
      for (const e of adds) setInPatch(patch, ptr(map, minted.get(e)!), entryValue(e));
      continue;
    }
    if (removed.length || empty) {
      const whole: Record<string, unknown> = {};
      for (const k of remaining) whole[k] = current![k];
      for (const e of adds) whole[minted.get(e)!] = entryValue(e);
      setInPatch(patch, ptr(map), Object.keys(whole).length ? whole : null);
      continue;
    }
    for (const e of adds) setInPatch(patch, ptr(map, minted.get(e)!), entryValue(e));
  }

  for (const edit of changes.edits) {
    const [map, key] = edit.path;
    if (changes.removed.some((r) => r.map === map && r.key === key)) continue;
    setInPatch(patch, ptr(...edit.path), resolve(edit.value));
  }
  return patch;
}

/** A new contact's card from its rows: only RFC 9553 properties. */
export function createObject(local: LocalContact, uid: string, bookId: string, ctx: Ctx): Partial<ContactCardWire> {
  const empty = {} as ContactCardWire;
  const changes = collectChanges(local, empty, ctx);
  changes.removed = [];
  const body = applyPatch(empty, assemble(changes, empty, ctx)) ?? {};
  return { '@type': 'Card', version: '1.0', ...body, uid, addressBookIds: { [bookId]: true } };
}

/** The patch for a dirty contact against its shadow; empty when nothing mapped changed. */
function updatePatch(local: LocalContact, ctx: Ctx): PatchObject {
  const shadow = withoutMemberOf(local.shadow!);
  return assemble(collectChanges(local, shadow, ctx), shadow, ctx);
}

const group = (local: LocalContact, ops: ProviderOp[]): OpGroup => ({ ref: local.sourceId ?? `row:${local.rawContactId}`, ops });

/**
 * Whether the card's address books take no writes now. Asked of the server's
 * rights, not of RAW_CONTACT_IS_READ_ONLY on the device, which the providers
 * never return (and which lags when only the rights changed).
 */
function readOnlyOnServer(local: LocalContact, ctx: Ctx): boolean {
  return !!local.shadow && ctx.isReadOnly(withoutMemberOf(local.shadow));
}

/**
 * Whether the server moved the card out of every book its rows were written
 * for (SYNC1), and into none this device syncs, before the device's deletion
 * reached it: the deletion is moot then, and the card stays where it is now.
 * A book deselected since still counts as the rows' own, so that deletion
 * goes up; so does one of a card moved into another synced book.
 */
function movedAway(local: LocalContact, accountId: string, ctx: Ctx): boolean {
  if (!local.shadow || !local.collections.length) return false;
  const books = Object.entries(local.shadow.addressBookIds ?? {}).filter(([, on]) => on).map(([id]) => collectionKey(accountId, id));
  return !books.some((key) => local.collections.includes(key) || ctx.isSelected(key));
}

function deletedPlan(local: LocalContact, ctx: Ctx): UploadPlan<ContactCardWire> {
  const purge = (): OpGroup => group(local, [deleteWhereId('raw_contacts', local.rawContactId)]);
  const ref = parseObjectRef(local.sourceId);
  if (ref) {
    if (movedAway(local, ref.accountId, ctx)) return { kind: 'purge', ops: purge() };
    if (readOnlyOnServer(local, ctx)) return { kind: 'revert', ops: purge(), refetch: true, reason: 'readOnly' };
    const books = Object.entries(local.shadow?.addressBookIds ?? {}).filter(([, on]) => on).map(([id]) => id);
    const selected = books.filter((id) => ctx.isSelected(collectionKey(ref.accountId, id)));
    // A card that is also in books this device does not sync only leaves the synced ones.
    if (selected.length && selected.length < books.length) {
      const patch: PatchObject = {};
      for (const id of selected) patch[ptr('addressBookIds', id)] = null;
      return { kind: 'upload', actions: [{ kind: 'update', id: ref.id, patch }] };
    }
    return { kind: 'upload', actions: [{ kind: 'destroy', id: ref.id, uid: typeof local.shadow?.uid === 'string' ? local.shadow.uid : null }] };
  }
  if (local.pending) return { kind: 'upload', actions: [{ kind: 'destroy', id: null, uid: local.pending.uid }] };
  return { kind: 'purge', ops: purge() };
}

export function planContactUpload(local: LocalContact, ctx: Ctx): UploadPlan<ContactCardWire> {
  if (!local.deleted && !local.dirty && local.sourceId) return { kind: 'clean', ops: group(local, []) };
  if (backedOff(local, ctx)) return { kind: 'skip', reason: `poisoned:${local.poison!.type}` };
  if (local.deleted) return deletedPlan(local, ctx);
  if (local.sourceId && !parseObjectRef(local.sourceId)) return { kind: 'skip', reason: 'invalidSourceId' };

  if (!local.sourceId) {
    if (!local.pending) {
      const target = ctx.createTarget();
      if (!target) return { kind: 'skip', reason: 'noWritableAddressBook' };
      const pending = { uid: ctx.mintUid(), target };
      return { kind: 'claim', ops: group(local, [assertContact(local, null), updateRawContact(local.rawContactId, { [RawContacts.SYNC3]: JSON.stringify(pending) })]) };
    }
    const target = parseCollectionKey(local.pending.target);
    if (!target) return { kind: 'skip', reason: 'invalidPendingTarget' };
    const object = createObject(local, local.pending.uid, target.id, ctx);
    const actions: UploadAction<ContactCardWire>[] = [{ kind: 'create', uid: local.pending.uid, collectionId: target.id, object }];
    return { kind: 'upload', actions };
  }

  if (!local.shadow) return { kind: 'skip', reason: 'noShadow' };
  if (readOnlyOnServer(local, ctx)) {
    const write = cleanWrite(local, local.shadow, ctx, { assertDirty: null, clearDirty: true });
    const ops = group(local, write.ops.length ? write.ops : [assertContact(local, null)]);
    // Reported when an edit is put back (joining a writable group is no edit of the card: it still uploads).
    const reason = Object.keys(updatePatch(local, ctx)).length ? 'readOnly' : write.revertedMembers ? 'groupNotWritable' : null;
    return reason ? { kind: 'revert', ops, reason } : { kind: 'revert', ops };
  }
  const patch = updatePatch(local, ctx);
  if (!Object.keys(patch).length) {
    // Nothing mapped changed (a star, a ringtone, an edit the server can't take): the rows
    // become the shadow's again and DIRTY is cleared behind the VERSION assert.
    const write = cleanWrite(local, local.shadow, ctx, { assertDirty: true, clearDirty: true });
    const ops = group(local, write.ops.length ? write.ops : [assertContact(local, true)]);
    // A membership the server can't take was put back, as a read-only edit is.
    return write.revertedMembers ? { kind: 'revert', ops, reason: 'groupNotWritable' } : { kind: 'clean', ops };
  }
  const actions: UploadAction<ContactCardWire>[] = [{ kind: 'update', id: parseObjectRef(local.sourceId)!.id, patch }];
  if (backedOff(local, ctx, actions)) return { kind: 'skip', reason: `poisoned:${local.poison!.type}` };
  return { kind: 'upload', actions };
}

export function planContactAccepted(local: LocalContact, server: ContactCardWire, ctx: Ctx): AcceptedPlan {
  if (local.deleted) {
    const purge = group(local, [deleteWhereId('raw_contacts', local.rawContactId)]);
    return { ops: purge, keepDirtyOps: purge };
  }
  const identity = objectRef(accountOf(local, ctx), server.id);
  const raw = { [RawContacts.SOURCE_ID]: identity, [RawContacts.SYNC3]: null, [RawContacts.SYNC4]: null };
  // Just created: the groups it was put in on the device are all still to upload.
  const memberBase = local.shadow ? undefined : [];
  const write = cleanWrite(local, server, ctx, { assertDirty: null, clearDirty: true, accepted: true, raw, memberBase });
  const ops = group(local, write.ops.length ? write.ops : [assertContact(local, null)]);
  ops.ref = identity;

  // Edited again during the upload: identity and shadow, and the baselines of
  // the uploaded units set to what was uploaded; rows and DIRTY stay.
  const changes = local.shadow ? collectChanges(local, withoutMemberOf(local.shadow), ctx) : null;
  // The rows stay, so a photo the device could not be given is still not there.
  const photoRow = local.rows.some((r) => r.mimetype === MimeType.PHOTO && !isEmptyRow(MimeType.PHOTO, r.cells));
  const shadow = withPhotoAbsent(
    withMemberOf(shadowOf(withoutMemberOf(server)), shadowMemberOf(local.shadow) ?? (local.shadow ? null : [])),
    isPhotoAbsent(local.shadow) && !photoRow && photoEntry(server) !== null,
  );
  const keep: ProviderOp[] = [
    updateRawContact(local.rawContactId, { ...raw, [RawContacts.SYNC2]: JSON.stringify(shadow) }),
  ];
  for (const id of changes?.uploadedRows ?? []) {
    const row = local.rows.find((r) => r.id === id)!;
    keep.push(updateWhereId('data', id, { [Data.DATA_SYNC3]: encodeBaseline(row.cells, SPECS[row.mimetype].columns) }));
  }
  return { ops, keepDirtyOps: { ref: identity, ops: keep } };
}
