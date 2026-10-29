/**
 * The engine's view of one kind of local item (a contact, a group, an event
 * master with its exceptions): what it needs to know about an item and the
 * planner calls it makes for it. The contacts and calendar sync plug their
 * planners in through this, so downloads, uploads, retries and the guards
 * are written once (engine/item-sync.ts).
 */
import type { AcceptedPlan, DownloadPlan, OpGroup, PendingCreate, PoisonMarker, UploadPlan } from '../planner';
import type { ProviderOp } from '../types';

export type KindName = 'contact' | 'group' | 'event';

/** A server object as `/get` returns it. */
export interface ServerObject {
  id: string;
  uid?: string;
  [property: string]: unknown;
}

export interface ItemMeta {
  rowId: number;
  /** `<jmapAccountId>/<id>` of the server object; null until created (events: a pending marker is no identity). */
  sourceId: string | null;
  pending: PendingCreate | null;
  /** Local changes wait for an upload (events: the master or one of its exceptions). */
  dirty: boolean;
  deleted: boolean;
  /** Never reached the server: no identity (docs/device-sync.md, "Identity"). */
  isNew: boolean;
  poison: PoisonMarker | null;
  /** Collection keys the server object was in when last seen. */
  collections: string[];
}

/** A decoded local item and its kind. */
export interface Held {
  kind: Kind;
  local: unknown;
}

export interface Kind<L = any, O extends ServerObject = any> {
  readonly name: KindName;
  readonly table: 'raw_contacts' | 'groups' | 'events';
  /** The column holding the identity, for the "not inserted yet" guard of a download insert. */
  readonly identityColumn: 'sourceid' | '_sync_id';
  readonly poisonColumn: 'sync4' | 'sync_data5';
  meta(local: L): ItemMeta;
  /** What an upload is computed from, for poison markers. */
  fingerprint(local: L): string;
  /** Items by identity, one per ref. */
  loadByRefs(refs: readonly string[]): Promise<Map<string, L>>;
  loadByRowIds(rowIds: readonly number[]): Promise<L[]>;
  /** Items without identity (new ones), for adoption by pending uid. */
  loadNew(): Promise<L[]>;
  planDownload(object: O, local: L | null, jmapAccountId: string): DownloadPlan;
  planLocalDelete(local: L): OpGroup;
  planBaselineHeal(local: L): OpGroup | null;
  planUpload(local: L, jmapAccountId: string): UploadPlan<O>;
  planAccepted(local: L, server: O, jmapAccountId: string): AcceptedPlan;
  /** The item without its pending create, so `planUpload` claims it again; absent when the target can't change. */
  unclaimed?(local: L): L;
}

export function refOf(jmapAccountId: string, id: string): string {
  return `${jmapAccountId}/${id}`;
}

/** The id part of a `<jmapAccountId>/<id>` ref of `jmapAccountId`, else null. */
export function idInAccount(ref: string | null, jmapAccountId: string): string | null {
  if (!ref) return null;
  const prefix = `${jmapAccountId}/`;
  return ref.startsWith(prefix) && !ref.includes('#') ? ref.slice(prefix.length) : null;
}

export function accountOfRef(ref: string | null): string | null {
  if (!ref) return null;
  const slash = ref.indexOf('/');
  return slash > 0 ? ref.slice(0, slash) : null;
}

/**
 * A download insert first asserts that no row has the identity yet: when a
 * failed batch was committed up to a yield point, the retry must not insert
 * the item twice.
 */
export function insertGuard(kind: Kind, ref: string): ProviderOp {
  return { op: 'assert', table: kind.table, where: `${kind.identityColumn} = ?`, args: [ref], expectCount: 0 };
}

export function poisonOp(kind: Kind, rowId: number, marker: PoisonMarker | null): ProviderOp {
  return {
    op: 'update',
    table: kind.table,
    id: rowId,
    values: { [kind.poisonColumn]: marker ? JSON.stringify(marker) : null },
  };
}
