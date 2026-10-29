/**
 * The engine's JMAP calls on one registry account's `JmapPort`: one request
 * in flight at a time, the time of the last request (for the keep-alive
 * echo), and the method helpers device sync needs, each sized by the
 * session's limits (docs/device-sync.md, "A sync run" and "Limits").
 *
 * Pure: the port is a detached JMAPClient on the device and the fake server
 * in tests.
 */
import { requireMethodResult } from '../../api/jmap-result';
import type { JMAPResponseBody } from '../../api/types';
import {
  JMAP_CALENDARS,
  JMAP_CONTACTS,
  JMAP_CORE,
  type JmapCoreLimits,
  type JmapInvocation,
  type JmapPort,
  type JmapResponse,
  type JmapSessionView,
} from '../types';
import type { PatchObject } from '../common/patch';

export type ItemType = 'ContactCard' | 'CalendarEvent';
export type ContainerType = 'AddressBook' | 'Calendar';
type DataType = ItemType | ContainerType;

/** `/changes` pages: Stalwart caps at 5000, a small page keeps every page a quick checkpoint. */
export const MAX_CHANGES = 256;
/** `/query` pages (Stalwart's `query_max_results`). */
export const QUERY_PAGE = 5000;
/** Ids re-read at the start of the next `/query` page, so a deletion that shifts the list skips nothing. */
const QUERY_OVERLAP = 100;

export function capabilityOf(type: DataType): string {
  return type === 'ContactCard' || type === 'AddressBook' ? JMAP_CONTACTS : JMAP_CALENDARS;
}

function using(type: DataType): string[] {
  return [JMAP_CORE, capabilityOf(type)];
}

export interface ChangesPage {
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: string[];
  updated: string[];
  destroyed: string[];
}

export interface SetErrorShape {
  type: string;
  description?: string;
  properties?: string[];
}

export interface SetResponse {
  oldState?: string;
  newState: string;
  created?: Record<string, { id: string } & Record<string, unknown>>;
  updated?: Record<string, unknown>;
  destroyed?: string[];
  notCreated?: Record<string, SetErrorShape>;
  notUpdated?: Record<string, SetErrorShape>;
  notDestroyed?: Record<string, SetErrorShape>;
}

export interface SetArgs {
  create?: Record<string, Record<string, unknown>>;
  update?: Record<string, PatchObject>;
  destroy?: string[];
  sendSchedulingMessages?: boolean;
}

export class JmapCaller {
  private chain: Promise<unknown> = Promise.resolve();
  private lastRequestAt: number;
  /** Requests sent, for tests and logs. */
  requestCount = 0;

  constructor(
    readonly port: JmapPort,
    private readonly now: () => number,
  ) {
    this.lastRequestAt = now();
  }

  session(): JmapSessionView {
    return this.port.session();
  }

  limits(): JmapCoreLimits {
    return this.port.limits();
  }

  /** Milliseconds since the last request started or ended. */
  idleMs(): number {
    return this.now() - this.lastRequestAt;
  }

  /**
   * One request at a time: the server's `maxConcurrentRequests` is a per-user
   * budget the UI shares, and a sync run has no reason to spend more than one.
   */
  request(calls: JmapInvocation[], usingCaps: string[]): Promise<JmapResponse> {
    const run = async () => {
      this.lastRequestAt = this.now();
      this.requestCount++;
      try {
        return await this.port.request(calls, usingCaps);
      } finally {
        this.lastRequestAt = this.now();
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** One method call; a method-level error throws `JMAPMethodError` with its `type`. */
  async call<T>(method: string, args: Record<string, unknown>, usingCaps: string[]): Promise<T> {
    const response = await this.request([[method, args, '0']], usingCaps);
    return requireMethodResult<T>(response as unknown as JMAPResponseBody, '0', method);
  }

  /** Network traffic for SyncManager's "no traffic for 60 s" monitor during long local phases. */
  async echo(): Promise<void> {
    await this.request([['Core/echo', { ping: this.now() }, '0']], [JMAP_CORE]);
  }

  /** Bytes of a blob (a blob-backed photo), in turn with the requests. */
  downloadBlob(accountId: string, blobId: string, type?: string): Promise<Uint8Array> {
    const run = async () => {
      this.lastRequestAt = this.now();
      try {
        return await this.port.downloadBlob(accountId, blobId, type);
      } finally {
        this.lastRequestAt = this.now();
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  // ── Reads ──

  /**
   * Objects by id with explicit properties, in calls of at most
   * `maxObjectsInGet` ids (never `ids: null`, which Stalwart silently caps).
   */
  async get<T>(
    type: DataType,
    accountId: string,
    ids: readonly string[],
    properties: readonly string[],
  ): Promise<{ list: T[]; notFound: string[]; state: string | null }> {
    const list: T[] = [];
    const notFound: string[] = [];
    let state: string | null = null;
    const size = Math.max(1, this.limits().maxObjectsInGet);
    for (let i = 0; i < ids.length; i += size) {
      const body = await this.call<{ list?: T[]; notFound?: string[]; state?: string }>(
        `${type}/get`,
        { accountId, ids: ids.slice(i, i + size), properties: [...properties] },
        using(type),
      );
      list.push(...(body.list ?? []));
      notFound.push(...(body.notFound ?? []));
      state = body.state ?? state;
    }
    return { list, notFound, state };
  }

  /** Every container of the account (there are few; Stalwart allows 250 per account). */
  async getContainers<T>(type: ContainerType, accountId: string, properties: readonly string[]): Promise<{ list: T[]; state: string | null }> {
    const body = await this.call<{ list?: T[]; state?: string }>(
      `${type}/get`,
      { accountId, ids: null, properties: [...properties] },
      using(type),
    );
    return { list: body.list ?? [], state: body.state ?? null };
  }

  /** The current state of a type, taken before a full reconcile lists anything. */
  async takeState(type: ItemType, accountId: string): Promise<string> {
    const body = await this.call<{ state?: string }>(`${type}/get`, { accountId, ids: [], properties: ['id'] }, using(type));
    return body.state ?? '';
  }

  async changes(type: ItemType, accountId: string, sinceState: string, maxChanges = MAX_CHANGES): Promise<ChangesPage> {
    const body = await this.call<Partial<ChangesPage>>(
      `${type}/changes`,
      { accountId, sinceState, maxChanges },
      using(type),
    );
    return {
      oldState: body.oldState ?? sinceState,
      newState: body.newState ?? sinceState,
      hasMoreChanges: Boolean(body.hasMoreChanges),
      created: body.created ?? [],
      updated: body.updated ?? [],
      destroyed: body.destroyed ?? [],
    };
  }

  /**
   * Every id matching `filter`, paged by `position` in pages of at most 5000.
   * Pages overlap a little: a deletion between two pages shifts the list and
   * would otherwise skip an object.
   */
  async queryAll(type: ItemType, accountId: string, filter: Record<string, unknown>, pageSize = QUERY_PAGE): Promise<string[]> {
    const seen = new Set<string>();
    let position = 0;
    for (let round = 0; round < 1000; round++) {
      const body = await this.call<{ ids?: string[]; total?: number; position?: number }>(
        `${type}/query`,
        { accountId, filter, position, limit: pageSize, calculateTotal: true },
        using(type),
      );
      const ids = body.ids ?? [];
      for (const id of ids) seen.add(id);
      const total = typeof body.total === 'number' ? body.total : null;
      const end = position + ids.length;
      if (ids.length === 0) break;
      // A server may cap the page below `pageSize`; the total says whether more follow.
      if (total !== null ? end >= total : ids.length < pageSize) break;
      position = end - Math.min(QUERY_OVERLAP, Math.floor(ids.length / 4));
    }
    return [...seen];
  }

  /** The first `limit` ids matching `filter` (task-only calendar detection). */
  async queryFirst(type: ItemType, accountId: string, filter: Record<string, unknown>, limit: number): Promise<string[]> {
    const body = await this.call<{ ids?: string[] }>(`${type}/query`, { accountId, filter, limit }, using(type));
    return body.ids ?? [];
  }

  /**
   * Ids of the objects carrying each uid, in `collectionId` when given
   * (contact uids are unique per address book, event uids per account). The
   * uid filter reads Stalwart's asynchronous search index, so a just-created
   * object can be missing.
   */
  async lookupUids(
    type: ItemType,
    accountId: string,
    uids: readonly string[],
    collectionId: string | null,
  ): Promise<Map<string, string[]>> {
    const found = new Map<string, string[]>();
    if (uids.length === 0) return found;
    const byUid: Record<string, unknown> =
      uids.length === 1 ? { uid: uids[0] } : { operator: 'OR', conditions: uids.map((uid) => ({ uid })) };
    const parentFilter = type === 'ContactCard' ? 'inAddressBook' : 'inCalendar';
    const filter = collectionId === null
      ? byUid
      : { operator: 'AND', conditions: [{ [parentFilter]: collectionId }, byUid] };
    const ids = await this.queryAll(type, accountId, filter);
    if (ids.length === 0) return found;
    const { list } = await this.get<{ id: string; uid?: string }>(type, accountId, ids, ['id', 'uid']);
    for (const object of list) {
      if (typeof object.uid !== 'string' || !uids.includes(object.uid)) continue;
      found.set(object.uid, [...(found.get(object.uid) ?? []), object.id]);
    }
    return found;
  }

  // ── Writes ──

  /**
   * One `/set` call, guarded by `ifInState` when there is one; with
   * `thenGet`, a `/get` of those ids in the same request (updates only:
   * Stalwart resolves no result reference to a `/set`, and a create's id is
   * only known from the response). A method-level error (`stateMismatch`, …)
   * throws `JMAPMethodError`.
   */
  async set<T>(
    type: ItemType,
    accountId: string,
    args: SetArgs,
    ifInState: string | null,
    thenGet?: { ids: string[]; properties: readonly string[] },
  ): Promise<{ response: SetResponse; got: T[] | null }> {
    const setArgs: Record<string, unknown> = { accountId };
    if (ifInState) setArgs.ifInState = ifInState;
    if (args.create && Object.keys(args.create).length) setArgs.create = args.create;
    if (args.update && Object.keys(args.update).length) setArgs.update = args.update;
    if (args.destroy?.length) setArgs.destroy = args.destroy;
    if (args.sendSchedulingMessages) setArgs.sendSchedulingMessages = true;
    const calls: JmapInvocation[] = [[`${type}/set`, setArgs, 's']];
    const withGet = !!thenGet && thenGet.ids.length > 0 && thenGet.ids.length <= this.limits().maxObjectsInGet;
    if (withGet) {
      calls.push([`${type}/get`, { accountId, ids: thenGet!.ids, properties: [...thenGet!.properties] }, 'g']);
    }
    const res = (await this.request(calls, using(type))) as unknown as JMAPResponseBody;
    const response = requireMethodResult<SetResponse>(res, 's', `${type}/set`);
    let got: T[] | null = null;
    if (withGet) {
      got = requireMethodResult<{ list?: T[] }>(res, 'g', `${type}/get`).list ?? [];
    } else if (thenGet && thenGet.ids.length > 0) {
      got = (await this.get<T>(type, accountId, thenGet.ids, thenGet.properties)).list;
    }
    return { response, got };
  }
}

// ── SetErrors ──

/**
 * What a SetError means for the item (docs/device-sync.md, "Uploads"):
 * - `notFound`: gone on the server (an update: a remote delete; a destroy: done);
 * - `forbidden`: not allowed (retried without scheduling messages, else reverted);
 * - `uidExists`: `invalidProperties` on `uid`: the object exists already (a
 *   lost response, or the client's automatic retry of a create);
 * - `poison`: the object itself is refused; back off until it changes.
 */
export type SetErrorClass = 'notFound' | 'forbidden' | 'uidExists' | 'poison';

export function classifySetError(error: SetErrorShape | undefined, op: 'create' | 'update' | 'destroy'): SetErrorClass {
  const type = error?.type;
  if (type === 'notFound') return 'notFound';
  if (type === 'forbidden') return 'forbidden';
  if (op === 'create' && type === 'invalidProperties' && error?.properties?.includes('uid')) return 'uidExists';
  return 'poison';
}

/** The existing card Stalwart names in a duplicate-uid error ("… already exists with id c5."). */
export function existingIdFromUidError(error: SetErrorShape | undefined): string | null {
  const m = /already exists with id ([A-Za-z0-9_-]+)/.exec(error?.description ?? '');
  return m ? m[1] : null;
}
