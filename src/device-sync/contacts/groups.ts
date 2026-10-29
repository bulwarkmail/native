/**
 * Group cards (`kind: "group"`) ↔ Groups rows, and membership edits made on
 * the device ↔ the group cards' `members` (docs/device-sync.md, "Contacts
 * mapping", "Groups"). Group rows are written before the contacts' plans run,
 * so memberships can name them. `members` takes `members/<uid>: null` as a
 * clean delete; the first member of a group without any is sent as the whole
 * map.
 */
import type { ContactName } from '../../api/types';
import { deriveFullName } from '../../lib/contact-utils';
import { Groups } from '../android-columns';
import { collectionKey, objectRef, parseCollectionKey, parseObjectRef } from '../common/ids';
import { canonicalJson, jsonHash } from '../common/json';
import { ptr, type PatchObject } from '../common/patch';
import type {
  AcceptedPlan,
  ContactCardWire,
  ContactsContext,
  DownloadPlan,
  LocalContact,
  LocalGroup,
  OpGroup,
  UploadAction,
  UploadPlan,
} from '../planner';
import type { ProviderOp, WriteRow } from '../types';
import { sameCell } from './cells';
import { cardUnits } from './download';
import { inPlaceEvidence, matchKind } from './matching';
import { planMemberships, shadowMemberOf } from './members';
import { deleteWhereId } from './ops';
import { shadowOf } from './photo';
import { KIND_ORDER } from './project';

type Ctx = ContactsContext;

/** The title a group card shows. */
function groupTitle(card: ContactCardWire | null): string | null {
  const name = card?.name as ContactName | undefined;
  if (typeof name?.full === 'string' && name.full.trim()) return name.full;
  return deriveFullName(name?.components) || null;
}

const ref = (local: LocalGroup) => local.sourceId ?? `group:${local.groupId}`;

function assertGroup(local: LocalGroup, dirty: boolean | null): ProviderOp {
  const values: Record<string, number> = { [Groups.VERSION]: local.version };
  if (dirty !== null) values[Groups.DIRTY] = dirty ? 1 : 0;
  return { op: 'assert', table: 'groups', id: local.groupId, values, expectCount: 1 };
}

const updateGroup = (local: LocalGroup, values: WriteRow): ProviderOp => ({
  op: 'update', table: 'groups', id: local.groupId, values, expectCount: 1,
});

function cardColumns(card: ContactCardWire, ctx: Ctx): WriteRow {
  return {
    [Groups.SYNC2]: JSON.stringify(shadowOf(card)),
    [Groups.GROUP_IS_READ_ONLY]: ctx.isReadOnly(card) ? 1 : 0,
  };
}

/**
 * Only the values that differ from what the local group holds. The read-only
 * flag is not decoded (LocalGroup has no field for it), so it only goes along
 * with other writes, which keeps an echo free of writes.
 */
function changed(local: LocalGroup, values: WriteRow): WriteRow {
  const out: WriteRow = {};
  for (const [column, value] of Object.entries(values)) {
    if (column === Groups.SYNC2) {
      const before = local.shadow ? canonicalJson(local.shadow) : null;
      if (typeof value !== 'string' || before !== canonicalJson(JSON.parse(value))) out[column] = value;
    } else if (column === Groups.TITLE) {
      if (!sameCell(local.title, value as unknown)) out[column] = value;
    } else if (column !== Groups.GROUP_IS_READ_ONLY) {
      out[column] = value;
    }
  }
  if (Object.keys(out).length && Groups.GROUP_IS_READ_ONLY in values) out[Groups.GROUP_IS_READ_ONLY] = values[Groups.GROUP_IS_READ_ONLY];
  return out;
}

export function planGroupDownload(card: ContactCardWire, local: LocalGroup | null, ctx: Ctx): DownloadPlan {
  const identity = objectRef(ctx.jmapAccountId, card.id);
  const remoteTitle = groupTitle(card);
  const plan = (ops: ProviderOp[], effect: DownloadPlan['effect'], conflicts = 0, stillDirty = false): DownloadPlan => ({
    ops: { ref: identity, ops }, conflicts, stillDirty, effect, writes: ops.filter((o) => o.op !== 'assert').length,
  });
  if (!local) {
    return plan([{
      op: 'insert',
      table: 'groups',
      values: { [Groups.SOURCE_ID]: identity, [Groups.TITLE]: remoteTitle ?? '', [Groups.GROUP_VISIBLE]: 1, [Groups.DIRTY]: 0, ...cardColumns(card, ctx) },
    }], 'insert');
  }
  if (local.deleted) {
    // Deleted on the device: the delete wins over a server edit. Only the shadow (and an identity
    // never written) follows the card, so the deletion uploads against the card as it is now.
    const diff = changed(local, { ...(local.sourceId ? {} : { [Groups.SOURCE_ID]: identity, [Groups.SYNC3]: null }), ...cardColumns(card, ctx) });
    if (!Object.keys(diff).length) return plan([], 'none', 0, true);
    return plan([assertGroup(local, local.dirty), updateGroup(local, diff)], 'update', 0, true);
  }
  if (!local.sourceId) {
    // Our own create whose identity was never written.
    return plan([
      assertGroup(local, local.dirty),
      updateGroup(local, { [Groups.SOURCE_ID]: identity, [Groups.SYNC3]: null, ...cardColumns(card, ctx) }),
    ], 'update', 0, true);
  }
  const base = groupTitle(local.shadow);
  const localChanged = local.dirty && !sameCell(local.title, base);
  const remoteChanged = !sameCell(remoteTitle, base);
  let conflicts = 0;
  const values: WriteRow = { ...cardColumns(card, ctx) };
  if (remoteChanged && (!localChanged || !sameCell(local.title, remoteTitle))) {
    if (localChanged) conflicts++;
    values[Groups.TITLE] = remoteTitle ?? '';
  }
  const diff = changed(local, values);
  if (!Object.keys(diff).length) return plan([], 'none', 0, localChanged && !remoteChanged);
  return plan([assertGroup(local, local.dirty), updateGroup(local, diff)], 'update', conflicts, localChanged && !remoteChanged);
}

export function planGroupLocalDelete(local: LocalGroup): OpGroup {
  return { ref: ref(local), ops: [deleteWhereId('groups', local.groupId)] };
}

/** A poison marker's `fp` for a group, as the engine takes it (engine/poison.ts). */
export function groupFingerprint(local: LocalGroup): string {
  return jsonHash({ deleted: local.deleted, title: local.title, shadow: local.shadow });
}

export function planGroupUpload(local: LocalGroup, ctx: Ctx): UploadPlan<ContactCardWire> {
  const group: OpGroup = { ref: ref(local), ops: [] };
  if (!local.deleted && !local.dirty && local.sourceId) return { kind: 'clean', ops: group };
  const p = local.poison;
  if (p && p.until > ctx.now && p.fp === groupFingerprint(local)) return { kind: 'skip', reason: `poisoned:${p.type}` };
  const parsed = parseObjectRef(local.sourceId);
  const readOnly = !!local.shadow && ctx.isReadOnly(local.shadow);

  if (local.deleted) {
    if (parsed) {
      if (readOnly) return { kind: 'revert', ops: { ...group, ops: [deleteWhereId('groups', local.groupId)] }, refetch: true, reason: 'readOnly' };
      const books = Object.entries(local.shadow?.addressBookIds ?? {}).filter(([, on]) => on).map(([id]) => id);
      const selected = books.filter((id) => ctx.isSelected(collectionKey(parsed.accountId, id)));
      if (selected.length && selected.length < books.length) {
        const patch: PatchObject = {};
        for (const id of selected) patch[ptr('addressBookIds', id)] = null;
        return { kind: 'upload', actions: [{ kind: 'update', id: parsed.id, patch }] };
      }
      return { kind: 'upload', actions: [{ kind: 'destroy', id: parsed.id, uid: typeof local.shadow?.uid === 'string' ? local.shadow.uid : null }] };
    }
    if (local.pending) return { kind: 'upload', actions: [{ kind: 'destroy', id: null, uid: local.pending.uid }] };
    return { kind: 'purge', ops: { ...group, ops: [deleteWhereId('groups', local.groupId)] } };
  }
  if (local.sourceId && !parsed) return { kind: 'skip', reason: 'invalidSourceId' };

  const title = local.title?.trim() ? local.title : null;
  if (!local.sourceId) {
    if (!local.pending) {
      const target = ctx.createTarget();
      if (!target) return { kind: 'skip', reason: 'noWritableAddressBook' };
      const pending = { uid: ctx.mintUid(), target };
      return { kind: 'claim', ops: { ...group, ops: [assertGroup(local, null), updateGroup(local, { [Groups.SYNC3]: JSON.stringify(pending) })] } };
    }
    const target = parseCollectionKey(local.pending.target);
    if (!target) return { kind: 'skip', reason: 'invalidPendingTarget' };
    const object: Partial<ContactCardWire> = {
      '@type': 'Card', version: '1.0', uid: local.pending.uid, kind: 'group', addressBookIds: { [target.id]: true },
      ...(title ? { name: { full: title } } : {}),
    };
    return { kind: 'upload', actions: [{ kind: 'create', uid: local.pending.uid, collectionId: target.id, object }] };
  }

  const shadowTitle = groupTitle(local.shadow);
  if (readOnly) {
    const ops = { ...group, ops: [assertGroup(local, null), updateGroup(local, { [Groups.TITLE]: shadowTitle ?? '', [Groups.DIRTY]: 0 })] };
    // Reported when a rename is put back.
    return sameCell(local.title, shadowTitle) ? { kind: 'revert', ops } : { kind: 'revert', ops, reason: 'readOnly' };
  }
  if (sameCell(title, shadowTitle) || title === null) {
    return { kind: 'clean', ops: { ...group, ops: [assertGroup(local, true), updateGroup(local, { [Groups.DIRTY]: 0 })] } };
  }
  const patch: PatchObject = local.shadow?.name && typeof local.shadow.name === 'object' ? { 'name/full': title } : { name: { full: title } };
  return { kind: 'upload', actions: [{ kind: 'update', id: parsed!.id, patch }] };
}

export function planGroupAccepted(local: LocalGroup, server: ContactCardWire, ctx: Ctx): AcceptedPlan {
  if (local.deleted) {
    const purge = planGroupLocalDelete(local);
    return { ops: purge, keepDirtyOps: purge };
  }
  const account = parseObjectRef(local.sourceId)?.accountId ?? parseCollectionKey(local.pending?.target)?.accountId ?? ctx.jmapAccountId;
  const identity = objectRef(account, server.id);
  const raw: WriteRow = { [Groups.SOURCE_ID]: identity, [Groups.SYNC3]: null, [Groups.SYNC4]: null, ...cardColumns(server, ctx) };
  const title = groupTitle(server);
  const keepDirtyOps = { ref: identity, ops: [updateGroup(local, raw)] };
  // A rename the server still lacks (the upload it accepted was another one, a membership
  // patch) stays the device's: title and DIRTY are kept, and it uploads against the new shadow.
  const shadowTitle = groupTitle(local.shadow);
  const renamed = local.dirty && !!local.title?.trim() && !sameCell(local.title, shadowTitle);
  if (renamed && sameCell(title, shadowTitle)) {
    return { ops: { ref: identity, ops: [assertGroup(local, null), updateGroup(local, raw)] }, keepDirtyOps };
  }
  const ops: WriteRow = { ...raw, [Groups.DIRTY]: 0 };
  if (!sameCell(local.title, title)) ops[Groups.TITLE] = title ?? '';
  return { ops: { ref: identity, ops: [assertGroup(local, null), updateGroup(local, ops)] }, keepDirtyOps };
}

/**
 * Membership edits of the given contacts as patches of the group cards'
 * `members`. A contact's edits are its rows against the base kept in its
 * shadow; what the group shadows already show is not sent again.
 */
export function planMembershipUploads(contacts: LocalContact[], groups: LocalGroup[], ctx: Ctx): UploadAction<ContactCardWire>[] {
  const bySource = new Map(groups.filter((g) => g.sourceId).map((g) => [g.sourceId!, g]));
  const members = (g: LocalGroup) => {
    const m = g.shadow?.members;
    return m && typeof m === 'object' ? (m as Record<string, boolean>) : {};
  };
  const edits = new Map<LocalGroup, Map<string, boolean>>();
  for (const contact of contacts) {
    if (contact.deleted) continue;
    const uid = typeof contact.shadow?.uid === 'string' ? contact.shadow.uid : contact.pending?.uid;
    const account = parseObjectRef(contact.sourceId)?.accountId;
    if (!uid || !account) continue;
    const remote = groups
      .filter((g) => g.sourceId && !g.deleted && members(g)[uid] === true)
      .map((g) => g.sourceId!);
    const base = contact.shadow ? shadowMemberOf(contact.shadow) : [];
    if (base === null) continue;
    const units = cardUnits(contact.shadow, ctx);
    const evidence = inPlaceEvidence(KIND_ORDER.map((k) => matchKind(k, contact.rows, units)));
    const plan = planMemberships({
      rows: contact.rows, base, remote, evidence, restore: false, parent: contact.rawContactId,
      groupRowIdBySourceId: () => null,
    });
    const put = (gsid: string, on: boolean) => {
      const g = bySource.get(gsid);
      const gref = parseObjectRef(gsid);
      if (!g || g.deleted || !g.shadow || !gref || gref.accountId !== account) return;
      if (ctx.isReadOnly(g.shadow)) return;
      if (!edits.has(g)) edits.set(g, new Map());
      edits.get(g)!.set(uid, on);
    };
    for (const g of plan.added) put(g, true);
    for (const g of plan.removed) put(g, false);
  }
  const actions: UploadAction<ContactCardWire>[] = [];
  for (const [g, changes] of edits) {
    const current = members(g);
    const patch: PatchObject = {};
    if (!Object.keys(current).length) {
      const whole: Record<string, boolean> = {};
      for (const [uid, on] of changes) if (on) whole[uid] = true;
      if (!Object.keys(whole).length) continue;
      patch.members = whole;
    } else {
      for (const [uid, on] of changes) patch[ptr('members', uid)] = on ? true : null;
    }
    actions.push({ kind: 'update', id: parseObjectRef(g.sourceId)!.id, patch });
  }
  return actions;
}
