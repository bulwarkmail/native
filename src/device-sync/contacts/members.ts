/**
 * Group memberships of a contact: one GroupMembership row per group card
 * whose `members` holds the card's uid (docs/device-sync.md, "Contacts
 * mapping"). The server keeps them on the group cards, so the rows are
 * compared with three sets:
 *
 * - base: the memberships the rows held after our last write, kept in the
 *   contact's shadow under `~memberOf` (the card itself has no such field);
 * - local: the rows now;
 * - remote: the group cards that list the uid now (`groupsOf`, from the
 *   engine's group shadows).
 *
 * Per group, a local change wins where the server did not change, the server
 * wins elsewhere; both sides can only flip a membership the same way, so
 * memberships never conflict. A local change stays in the base until the
 * server has it, which keeps it visible to `planMembershipUploads`; one the
 * server can't take (a group in read-only books, or in another JMAP account)
 * is put back by the next clean write instead.
 */
import { Data, GroupMembership, MimeType } from '../android-columns';
import { parseObjectRef } from '../common/ids';
import type { ContactCardWire, ContactsContext, LocalDataRow } from '../planner';
import type { ProviderOp } from '../types';
import { text } from './cells';
import { entryKey } from './keys';
import { deleteData, insertUnit, updateData } from './ops';
import { NO_PHOTO } from './photo';
import { MEMBER_OF, type Unit } from './project';

/**
 * The groups whose members an upload for a contact of `account` can change:
 * that account's groups outside read-only books (`groupReadOnly`). A
 * membership change of any other group can never reach the server
 * (`planMembershipUploads` skips it).
 */
export function editableGroups(ctx: ContactsContext, account: string): (sourceId: string) => boolean {
  return (sourceId) => parseObjectRef(sourceId)?.accountId === account && !(ctx.groupReadOnly?.(sourceId) ?? false);
}

/** Remote memberships of a card, or null when the engine can't tell (memberships are then left alone). */
export function remoteMemberships(card: ContactCardWire, ctx: ContactsContext): string[] | null {
  if (typeof ctx.groupsOf !== 'function' || typeof card.uid !== 'string' || !card.uid) return null;
  return [...new Set(ctx.groupsOf(card.uid).filter((g) => typeof g === 'string'))].sort();
}

export function shadowMemberOf(shadow: ContactCardWire | null): string[] | null {
  const v = shadow?.[MEMBER_OF];
  return Array.isArray(v) && v.every((g) => typeof g === 'string') ? [...v] : null;
}

/** A card without the device-only members a shadow carries: `~memberOf`, and `~noPhoto` (photo.ts). */
export function withoutMemberOf(card: ContactCardWire): ContactCardWire {
  if (!(MEMBER_OF in card) && !(NO_PHOTO in card)) return card;
  const { [MEMBER_OF]: _drop, [NO_PHOTO]: _photo, ...rest } = card;
  return rest as ContactCardWire;
}

export function withMemberOf(shadow: ContactCardWire, memberOf: string[] | null): ContactCardWire {
  const out = withoutMemberOf(shadow);
  return memberOf === null ? out : { ...out, [MEMBER_OF]: [...memberOf].sort() };
}

function membershipUnit(gsid: string, groupRowId: number): Unit {
  return {
    mimetype: MimeType.GROUP_MEMBERSHIP,
    key: entryKey('members', gsid),
    cells: { [GroupMembership.GROUP_SOURCE_ID]: gsid },
    extra: { [GroupMembership.GROUP_ROW_ID]: groupRowId },
    source: JSON.stringify(gsid),
  };
}

/** The group SOURCE_ID a membership row points at; null for a group not yet on the server. */
export function rowGroup(row: LocalDataRow): string | null {
  return text(row.cells[GroupMembership.GROUP_SOURCE_ID]);
}

export interface MemberPlan {
  ops: ProviderOp[];
  writes: number;
  /** The new base (`~memberOf`); null when memberships are not synced. */
  memberOf: string[] | null;
  /** Local membership changes the server does not have yet. */
  pending: boolean;
  /** Groups the device added the contact to, or removed it from, that the server does not show yet. */
  added: string[];
  removed: string[];
  /** Local changes of groups that are not `editable` were put back to what the server has. */
  reverted: boolean;
}

export interface MemberInput {
  rows: LocalDataRow[];
  base: string[] | null;
  remote: string[] | null;
  /** Deleted rows count as removals (keyed rows of the kind, or in-place evidence). */
  evidence: boolean;
  /** Clean writes put back memberships an editor did not show; merges leave them. */
  restore: boolean;
  parent: number | { ref: number };
  groupRowIdBySourceId(sourceId: string): number | null;
  /**
   * Groups whose members the device may change (see `editableGroups`); a local
   * change of another group is put back to what the server has rather than
   * waiting for an upload that never comes. Without it every group counts.
   */
  editable?(sourceId: string): boolean;
}

export function planMemberships(input: MemberInput): MemberPlan {
  const live = input.rows.filter((r) => r.mimetype === MimeType.GROUP_MEMBERSHIP);
  if (input.remote === null) {
    // Without the engine's group index memberships are not synced: nothing is written or kept pending.
    return { ops: [], writes: 0, memberOf: input.base, pending: false, added: [], removed: [], reverted: false };
  }
  const ops: ProviderOp[] = [];
  const rowOf = new Map<string, LocalDataRow>();
  let unsynced = false;
  for (const r of live) {
    const g = rowGroup(r);
    if (g === null) unsynced = true;
    else if (!rowOf.has(g)) rowOf.set(g, r);
  }
  const keyed = live.some((r) => r.key !== null && r.key === entryKey('members', rowGroup(r) ?? ''));
  const deletions = keyed || (live.length === 0 && input.evidence);
  const base = new Set(input.base ?? rowOf.keys());
  const remote = new Set(input.remote);
  const after = new Set<string>();
  const pendingAdded = new Set<string>();
  const pendingRemoved = new Set<string>();

  const keep = (g: string, row: LocalDataRow) => {
    after.add(g);
    const key = entryKey('members', g);
    if (row.key !== key) ops.push(updateData(row.id, { [Data.DATA_SYNC1]: key }));
  };
  const insert = (g: string) => {
    const groupRowId = input.groupRowIdBySourceId(g);
    if (groupRowId === null) return;
    ops.push(insertUnit(input.parent, membershipUnit(g, groupRowId), true));
    after.add(g);
  };

  let reverted = false;
  for (const g of [...new Set([...base, ...remote, ...rowOf.keys()])].sort()) {
    const inBase = base.has(g);
    const inRemote = remote.has(g);
    const row = rowOf.get(g);
    let change = inBase ? (!row && deletions ? 'removed' : null) : row ? 'added' : null;
    if (change && input.editable && !input.editable(g)) {
      // A change the server can't take (a group in read-only books, or another account's): its state comes back.
      if (change === 'added' ? !inRemote : inRemote) reverted = true;
      change = null;
    }
    if (change === 'added') {
      keep(g, row!);
      if (!inRemote) pendingAdded.add(g);
    } else if (change === 'removed') {
      if (inRemote) pendingRemoved.add(g);
    } else if (row) {
      if (inRemote) keep(g, row);
      else ops.push(deleteData(row.id));
    } else if (inRemote && (!inBase || input.restore)) {
      insert(g);
    }
  }
  const memberOf = [...after].filter((g) => !pendingAdded.has(g));
  for (const g of pendingRemoved) memberOf.push(g);
  return {
    ops,
    writes: ops.length,
    memberOf: memberOf.sort(),
    pending: unsynced || pendingAdded.size > 0 || pendingRemoved.size > 0,
    added: [...pendingAdded],
    removed: [...pendingRemoved],
    reverted,
  };
}
