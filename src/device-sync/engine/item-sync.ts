/**
 * The download and upload machinery shared by the contacts and calendar sync
 * (docs/device-sync.md, "A sync run", "Change detection and merge rules",
 * "Uploads"). The authorities plug in their kinds of local items, their
 * collections and their extra phases; everything that talks to the server,
 * the batching, the retries and the guards is here.
 */
import type { OpGroup, UploadAction } from '../planner';
import { collectionKey } from '../common/ids';
import {
  classifySetError,
  existingIdFromUidError,
  type ItemType,
  type SetArgs,
  type SetErrorShape,
  type SetResponse,
} from '../jmap/caller';
import { isMethodError } from '../jmap/errors';
import { appendToLast, chainHasWrites, concatGroups, prependOps, type Work } from './batch';
import type { RunEnv } from './context';
import { RunAbort, StateMismatch } from './errors';
import {
  accountOfRef,
  idInAccount,
  insertGuard,
  poisonOp,
  refOf,
  type Held,
  type ItemMeta,
  type Kind,
  type ServerObject,
} from './kinds';
import { isBackedOff, nextMarker } from './poison';
import { hasWrites } from './provider';
import { accountOf, type StateChange, type SyncState, type Tail } from './sync-state';

type Action = UploadAction<ServerObject>;

function both(first: StateChange | undefined, second: StateChange | undefined): StateChange | undefined {
  if (!first || !second) return first ?? second;
  return (next) => {
    first(next);
    second(next);
  };
}

/** The work with one more state change, also after a re-plan. */
function withState(work: Work, change: StateChange): Work {
  const replan = work.replan;
  return {
    ...work,
    state: both(work.state, change),
    replan: replan && (async () => {
      const next = await replan();
      return next && withState(next, change);
    }),
  };
}

/** An item's upload, on its way to the server. */
export interface Pending {
  held: Held;
  meta: ItemMeta;
  fingerprint: string;
  actions: Action[];
  /** Resent without scheduling messages after a `forbidden`. */
  noScheduling?: boolean;
  /** Custom handling once every action was accepted (pairs, memberships); replaces `planAccepted`. */
  accept?(objects: Map<string, ServerObject>): Promise<Work[]>;
}

type Outcome =
  | { action: Action; ok: true; id: string }
  | { action: Action; ok: false; error: SetErrorShape; scheduling: boolean };

interface SetCallPlan {
  args: { create: Record<string, Record<string, unknown>>; update: Record<string, Record<string, unknown>>; destroy: string[]; sendSchedulingMessages: boolean };
  entries: Array<{ pending: Pending; action: Action; key: string }>;
  touched: Set<string>;
  updateIds: string[];
  creates: number;
  bytes: number;
}

type Removal = 'destroyed' | 'outside';

/** Method-level refusals of a whole `/set` that concern the account, not the objects. */
const ACCOUNT_REFUSALS = new Set(['accountReadOnly', 'forbidden', 'accountNotFound', 'accountNotSupportedByMethod']);

/** Refusals to list an account's collections: the account is not readable for this user. */
const ACCOUNT_UNREADABLE = new Set(['forbidden', 'accountNotFound', 'accountNotSupportedByMethod']);

export abstract class ItemSync {
  /** Per account: object ids put on `stale` (true) or fetched fine again (false), for the next state op. */
  private readonly staleMarks = new Map<string, Map<string, boolean>>();
  /** Per account: refs of dirty items whose object left every synced collection; dropped once uploaded. */
  protected readonly outside = new Map<string, Set<string>>();
  /** Per account: objects our uploads created for other rows (a series split), adopted by the download. */
  private readonly extraCreated = new Map<string, Set<string>>();
  /** Per account: `ifInState` of the next `/set` (the download's state, then our last `newState`). */
  private readonly setStates = new Map<string, string | null>();
  /** Accounts that refused to list their collections this run: left out of it (see `containersOf`). */
  private readonly unreadable = new Set<string>();

  constructor(protected readonly env: RunEnv) {}

  // ── What the authority provides ──

  protected abstract readonly itemType: ItemType;
  protected abstract readonly itemProperties: readonly string[];
  protected abstract readonly parentFilter: 'inAddressBook' | 'inCalendar';
  protected abstract readonly parentProperty: 'addressBookIds' | 'calendarIds';

  protected abstract kinds(): Kind[];
  /** The kind whose rows hold the object; null when it does not sync (a task). */
  protected abstract kindOf(object: ServerObject): Kind | null;
  /** Whether the object is in a collection that syncs. */
  protected abstract inSelection(jmapAccountId: string, object: ServerObject): boolean;
  /** Ids of the collections of the account that sync now. */
  protected abstract syncedCollections(jmapAccountId: string): string[];
  /** Reads the collections, and (`write`) brings the collection rows up to date. */
  protected abstract collections(write: boolean): Promise<void>;
  /** Local identities of the account: object id → local flags, for reconcile deletions. */
  protected abstract localIdentities(jmapAccountId: string): Promise<Map<string, { dirty: boolean; deleted: boolean }>>;
  /** Every item with local changes: dirty, deleted, or new. */
  protected abstract loadUploadItems(): Promise<Held[]>;
  /** The JMAP account a new item without a pending create is claimed in. */
  protected abstract claimAccount(held: Held): string | null;
  /** Local deletions waiting for an upload, synced objects, and the accounts concerned. */
  protected abstract countDeletions(items: Held[]): Promise<{ count: number; synced: number; accounts: Set<string> }>;
  /** Drops the clean rows of deselected collections and of objects that left the selection. */
  protected abstract dropOutsideSelection(jmapAccountId: string): Promise<void>;

  // ── Hooks ──

  /** Processing order of a download: `first` completely before `rest` (group cards before contacts); `missing` are gone. */
  protected async order(_acct: string, ids: string[]): Promise<{ first: string[]; rest: string[]; missing: string[] }> {
    return { first: [], rest: ids, missing: [] };
  }
  protected async beforePlanning(_acct: string, _objects: ServerObject[]): Promise<void> {}
  protected async beforeUploadPlanning(_items: Held[]): Promise<void> {}
  protected async beforeReconcile(_acct: string): Promise<void> {}
  /** Authority changes folded into a state op of the account; the callback runs once that op is stored. */
  protected decorateState(_acct: string, _next: SyncState): (() => void) | void {}
  protected onDownloaded(_kind: Kind, _acct: string, _object: ServerObject): void {}
  /** A download found the object's rows as they should be already. */
  protected onEcho(_kind: Kind, _acct: string, _object: ServerObject): void {}
  protected onRemoved(_kind: Kind, _acct: string, _id: string): void {}
  protected onAccepted(_kind: Kind, _acct: string, _server: ServerObject): void {}
  /**
   * What the SyncState lists changes when a row of `kind` is inserted
   * (`present`) or deleted (contacts: `groups`): stored by the batch that
   * writes the row, so the list never disagrees with the rows.
   */
  protected listing(_kind: Kind, _acct: string, _id: string, _present: boolean): StateChange | undefined {
    return undefined;
  }
  /**
   * Objects whose rows a download of `object` makes outdated (contacts: the
   * members a group card gained or lost). They go on `stale` in the batch
   * that writes it, so a stop before their own chunk leaves them to the next
   * run's first fetch.
   */
  protected dependents(_kind: Kind, _acct: string, _object: ServerObject): string[] {
    return [];
  }
  protected onDiscard(_next: SyncState, _accounts: Set<string>): void {}
  /**
   * Local items that go with the rows of objects the server destroyed
   * (calendar: the new row of a move the device made of a deleted event; the
   * server's deletion wins over the move). Written with those rows.
   */
  protected async alongDestroyed(_acct: string, _removed: Held[]): Promise<Work[]> {
    return [];
  }
  /** Whether a pending create of `target` may adopt this object (contacts: the target book holds it). */
  protected adoptionTargetMatches(acct: string, _object: ServerObject, target: string): boolean {
    return accountOfRef(target) === acct;
  }
  /** Where a uid is looked up for a create in `collectionId`: that collection, or null for the whole account. */
  protected lookupScope(_acct: string, _collectionId: string): string | null {
    return null;
  }
  /** Whether a new item is claimed with the others (calendar: a split clone waits for its source). */
  protected claimable(_held: Held): boolean {
    return true;
  }
  /** Whether a collection key names a collection its account no longer has (listed this run). */
  protected collectionGone(_key: string): boolean {
    return false;
  }
  /** The JMAP account an item uploads to. */
  protected accountOfItem(held: Held): string | null {
    const meta = held.kind.meta(held.local);
    return accountOfRef(meta.sourceId) ?? accountOfRef(meta.pending?.target ?? null);
  }
  /** Before new rows are claimed (calendar: deleted and new rows that are one edit, uploaded as patches). */
  protected async pairPhase(_acct: string): Promise<void> {}
  /** Before the creates (calendar: split series). */
  protected async prePhase(_acct: string): Promise<void> {}
  /** After the deletions (contacts: groups deleted by absence, memberships). */
  protected async extraPhase(_acct: string, _deletionsAllowed: boolean): Promise<void> {}
  /** After uploads and deselection (calendar: zone and reminder-owner passes). */
  protected async afterSync(): Promise<void> {}

  // ── Runs ──

  /** A sync run's phases after the preflight. */
  async sync(): Promise<void> {
    await this.collections(true);
    for (const acct of this.accountIds()) await this.refetchStale(acct);
    for (const acct of this.accountIds()) {
      await this.changesLoop(acct);
      await this.loadNewlySelected(acct);
    }
    await this.uploadAll();
    for (const acct of this.knownAccountIds()) {
      await this.env.checkpoints.check('deselect');
      await this.dropOutsideSelection(acct);
    }
    await this.afterSync();
    await this.flushState();
  }

  /** A teardown's upload: everything waiting on the device, nothing else. */
  async uploadOnly(): Promise<void> {
    await this.collections(false);
    await this.uploadAll();
    await this.flushState();
  }

  protected accountIds(): string[] {
    return this.env.accounts.map((a) => a.id).filter((id) => !this.unreadable.has(id));
  }

  /** The session's accounts plus accounts the rows were written for that are gone from it. */
  protected knownAccountIds(): string[] {
    return [...new Set([...this.accountIds(), ...Object.keys(this.env.store.committed.accounts)])]
      .filter((id) => !this.unreadable.has(id));
  }

  /**
   * One account's collections, or null when the account refuses to list them
   * (`forbidden`, `accountNotFound`, `accountNotSupportedByMethod`): Stalwart
   * lists an account shared for mail only with every capability, and access
   * can go away. Such an account is left out of the run, and not reported
   * as a problem: for a mail-only share there is nothing to fix, and the
   * warning would never go away. The rows written for it stay as they are,
   * since a refusal can pass and must not drop anything from the device.
   */
  protected async containersOf<T>(
    type: 'AddressBook' | 'Calendar',
    accountId: string,
    properties: readonly string[],
  ): Promise<{ list: T[]; state: string | null } | null> {
    try {
      return await this.env.jmap.getContainers<T>(type, accountId, properties);
    } catch (error) {
      if (!isMethodError(error) || !ACCOUNT_UNREADABLE.has(error.type)) throw error;
      this.unreadable.add(accountId);
      this.env.log(`account ${accountId} left out: ${error.type}`);
      return null;
    }
  }

  // ── State ──

  private marks(acct: string): Map<string, boolean> {
    let marks = this.staleMarks.get(acct);
    if (!marks) this.staleMarks.set(acct, (marks = new Map()));
    return marks;
  }

  protected markStale(acct: string, id: string): void {
    this.marks(acct).set(id, true);
  }

  protected markResolved(acct: string, id: string): void {
    if (this.marks(acct).has(id) || this.env.store.account(acct).stale.includes(id)) this.marks(acct).set(id, false);
  }

  /** Puts `ids` on `stale` in the batch whose rows make them outdated (see `dependents`). */
  private staleWith(acct: string, ids: string[]): StateChange | undefined {
    if (!ids.length) return undefined;
    return (next) => {
      const account = accountOf(next, acct);
      account.stale = [...new Set([...account.stale, ...ids])];
    };
  }

  protected isStale(acct: string, sourceId: string | null): boolean {
    const id = idInAccount(sourceId, acct);
    if (!id) return false;
    return this.marks(acct).get(id) ?? this.env.store.account(acct).stale.includes(id);
  }

  /**
   * A planner threw on one item (a bug, or data it cannot handle): that
   * item is reported and left alone, the rest of the run goes on. A
   * download's object goes on `stale`, so the state still moves and the
   * object is tried again next run.
   */
  protected plannerFailed(acct: string, ref: string, side: 'download' | 'upload', error: unknown, staleId?: string): void {
    if (staleId) this.markStale(acct, staleId);
    if (side === 'upload') this.env.report.stats.skipped++;
    const description = error instanceof Error ? error.message : String(error);
    this.env.report.itemError({ ref, side, type: 'plannerError', description: description.slice(0, 300) });
    this.env.log(`planner failed on ${ref}`, error);
  }

  protected outsideOf(acct: string): Set<string> {
    let set = this.outside.get(acct);
    if (!set) this.outside.set(acct, (set = new Set()));
    return set;
  }

  /** A state op for `accts`, carrying their stale marks and the authority's changes along with `mutate`. */
  protected tail(accts: readonly string[], mutate?: (next: SyncState) => void): Tail {
    const consumed: Array<[string, string, boolean]> = [];
    const commits: Array<() => void> = [];
    const base = this.env.store.tail((next) => {
      consumed.length = 0;
      commits.length = 0;
      mutate?.(next);
      for (const acct of accts) {
        const account = accountOf(next, acct);
        const marks = this.staleMarks.get(acct);
        if (marks?.size) {
          const stale = new Set(account.stale);
          for (const [id, isStale] of marks) {
            consumed.push([acct, id, isStale]);
            if (isStale) stale.add(id);
            else stale.delete(id);
          }
          account.stale = [...stale];
        }
        const commit = this.decorateState(acct, next);
        if (commit) commits.push(commit);
      }
    });
    return {
      op: base.op,
      applied: () => {
        base.applied();
        for (const [acct, id, isStale] of consumed) {
          const marks = this.staleMarks.get(acct);
          if (marks?.get(id) === isStale) marks.delete(id);
        }
        for (const commit of commits) commit();
      },
    };
  }

  /** Stores what is still pending (stale marks, collection states, …) at the end of a run. */
  protected async flushState(): Promise<void> {
    const accts = this.knownAccountIds();
    const probe = this.tail(accts);
    const before = JSON.stringify(this.env.store.committed);
    const op = probe.op();
    if (op.op === 'syncState' && op.value === before) return;
    await this.env.writer.write([], { op: () => op, applied: probe.applied });
  }

  // ── Downloads ──

  /**
   * Objects put on `stale` by an earlier run (invariant 10), and objects our
   * uploads created since the stored state (`/changes` from it omits one that
   * was created and destroyed since): fetched again first.
   */
  protected async refetchStale(acct: string): Promise<void> {
    const account = this.env.store.account(acct);
    const created = account.created ?? [];
    const ids = [...new Set([...account.stale, ...created])];
    if (!ids.length) return;
    await this.processIds(acct, ids, [], (next) => {
      const a = accountOf(next, acct);
      a.created = (a.created ?? []).filter((id) => !created.includes(id));
    });
  }

  /** `/changes` pages from the stored state; a full reconcile without one or after `cannotCalculateChanges`. */
  protected async changesLoop(acct: string): Promise<void> {
    let reconciled = false;
    for (let round = 0; round < 10_000; round++) {
      const account = this.env.store.account(acct);
      if (!account.itemsState || account.reconcile) {
        if (reconciled) return;
        await this.fullReconcile(acct);
        reconciled = true;
        continue;
      }
      const since = account.itemsState;
      await this.env.checkpoints.check('changes');
      let page;
      try {
        page = await this.env.jmap.changes(this.itemType, acct, since);
      } catch (error) {
        if (isMethodError(error, 'cannotCalculateChanges') && !reconciled) {
          this.env.log(`cannotCalculateChanges for ${acct}: full reconcile`);
          await this.requestReconcile(acct);
          continue;
        }
        throw error;
      }
      const ids = [...new Set([...page.created, ...page.updated])];
      const newState = page.newState;
      if (!ids.length && !page.destroyed.length && newState === since) return;
      await this.processIds(acct, ids, page.destroyed, (next) => {
        accountOf(next, acct).itemsState = newState;
      });
      if (!page.hasMoreChanges || newState === since) return;
    }
  }

  protected async requestReconcile(acct: string): Promise<void> {
    await this.env.writer.write(
      [],
      this.tail([acct], (next) => {
        accountOf(next, acct).reconcile = { from: null, phase: 'ids', position: 0, after: null };
      }),
    );
  }

  /**
   * A full reconcile, checkpointed in `reconcile`: the state first, then the
   * ids of every synced collection, then the objects in chunks; deletions
   * only once the complete id list is known. Zero objects on the server
   * against a full device stops the run (`safetyAbort`).
   */
  protected async fullReconcile(acct: string): Promise<void> {
    let marker = this.env.store.account(acct).reconcile;
    const synced = this.syncedCollections(acct);
    if (!marker?.from) {
      await this.env.checkpoints.check('reconcile');
      const from = await this.env.jmap.takeState(this.itemType, acct);
      const started = { from, phase: 'ids' as const, position: 0, after: null, collections: synced.map((c) => collectionKey(acct, c)) };
      await this.env.writer.write([], this.tail([acct], (next) => {
        accountOf(next, acct).reconcile = { ...started };
      }));
      marker = started;
    }
    const from = marker.from as string;
    await this.beforeReconcile(acct);
    // A resumed reconcile lists the collections it started with (their ids up to `after` are done):
    // one selected since then is loaded afterwards, from its first id.
    const keys = marker.collections;
    const collections = keys ? synced.filter((c) => keys.includes(collectionKey(acct, c))) : synced;
    const listed = new Set<string>();
    for (const collection of collections) {
      await this.env.checkpoints.check('reconcile:ids');
      for (const id of await this.env.jmap.queryAll(this.itemType, acct, { [this.parentFilter]: collection })) listed.add(id);
    }
    const local = await this.localIdentities(acct);
    if (listed.size === 0 && collections.length > 0 && local.size > this.env.tuning.safetyAbortRows) {
      throw new RunAbort(
        'safetyAbort',
        `The server lists no objects in ${acct} while this device holds ${local.size}; nothing was changed`,
      );
    }
    const { first, rest, missing } = await this.order(acct, [...listed].sort());
    const size = this.env.tuning.chunkSize;
    for (let i = 0; i < first.length; i += size) {
      await this.env.checkpoints.check('reconcile:objects');
      await this.processChunk(acct, first.slice(i, i + size), [], undefined);
    }
    const resumeAfter = marker.after;
    const todo = resumeAfter ? rest.filter((id) => id > resumeAfter) : rest;
    let position = rest.length - todo.length;
    for (let i = 0; i < todo.length; i += size) {
      await this.env.checkpoints.check('reconcile:objects');
      const part = todo.slice(i, i + size);
      position += part.length;
      const mark = { from, phase: 'objects' as const, position, after: part[part.length - 1], ...(keys ? { collections: keys } : {}) };
      await this.processChunk(acct, part, [], (next) => {
        accountOf(next, acct).reconcile = { ...mark };
      });
    }
    const gone = new Set(missing);
    const verify: string[] = [];
    for (const [id, flags] of local) {
      if (listed.has(id)) continue;
      if (flags.dirty || flags.deleted) verify.push(id);
      else gone.add(id);
    }
    const outside: string[] = [];
    if (verify.length) {
      // Destroyed, or moved out of the synced collections? Only a destroy takes dirty rows; the
      // others are downloaded like any change, so a dirty item merges the server's version.
      const { list, notFound } = await this.env.jmap.get<ServerObject>(this.itemType, acct, verify, ['id']);
      for (const id of notFound) gone.add(id);
      for (const object of list) outside.push(object.id);
    }
    const selected = collections.map((c) => collectionKey(acct, c));
    await this.processIds(acct, outside, [...gone], (next) => {
      const account = accountOf(next, acct);
      account.itemsState = from;
      account.reconcile = null;
      account.selected = selected;
      if (account.partial) account.partial = account.partial.filter((key) => !selected.includes(key));
    });
  }

  /**
   * Collections selected since the rows were written (or loaded or dropped
   * only in part): loaded once the account is up to date. A collection is
   * `partial` from before its first chunk until its last one makes it
   * `selected`, so deselected again after a stop, its rows are dropped.
   */
  protected async loadNewlySelected(acct: string): Promise<void> {
    const account = this.env.store.account(acct);
    if (!account.itemsState || account.reconcile) return;
    for (const collection of this.syncedCollections(acct)) {
      const key = collectionKey(acct, collection);
      if (this.env.store.account(acct).selected.includes(key)) continue;
      await this.env.checkpoints.check('select');
      const ids = await this.env.jmap.queryAll(this.itemType, acct, { [this.parentFilter]: collection });
      if (!(this.env.store.account(acct).partial ?? []).includes(key)) {
        await this.env.writer.write([], this.tail([acct], (next) => {
          const a = accountOf(next, acct);
          a.partial = [...new Set([...(a.partial ?? []), key])];
        }));
      }
      await this.processIds(acct, ids, [], (next) => {
        const a = accountOf(next, acct);
        if (!a.selected.includes(key)) a.selected.push(key);
        a.partial = (a.partial ?? []).filter((k) => k !== key);
      });
    }
  }

  /** Downloads `ids` and removes the rows of `destroyed`, in chunks; `mutate` rides with the last one. */
  protected async processIds(
    acct: string,
    ids: readonly string[],
    destroyed: readonly string[],
    mutate?: (next: SyncState) => void,
  ): Promise<void> {
    const { first, rest, missing } = ids.length ? await this.order(acct, [...ids]) : { first: [], rest: [], missing: [] };
    const size = this.env.tuning.chunkSize;
    const chunks: Array<{ ids: string[]; gone: string[] }> = [];
    for (const part of [first, rest]) {
      for (let i = 0; i < part.length; i += size) chunks.push({ ids: part.slice(i, i + size), gone: [] });
    }
    const gone = [...new Set([...destroyed, ...missing])];
    for (let i = 0; i < gone.length; i += size) chunks.push({ ids: [], gone: gone.slice(i, i + size) });
    if (chunks.length === 0) {
      if (mutate) await this.env.writer.write([], this.tail([acct], mutate));
      return;
    }
    for (let i = 0; i < chunks.length; i++) {
      await this.env.checkpoints.check('download');
      await this.processChunk(acct, chunks[i].ids, chunks[i].gone, i === chunks.length - 1 ? mutate : undefined);
    }
  }

  /** One chunk: fetch, find the local items (adopting pending creates by uid), plan, write, read back. */
  protected async processChunk(
    acct: string,
    ids: readonly string[],
    gone: readonly string[],
    mutate?: (next: SyncState) => void,
  ): Promise<void> {
    let objects: ServerObject[] = [];
    let notFound: string[] = [];
    if (ids.length) {
      ({ list: objects, notFound } = await this.env.jmap.get<ServerObject>(this.itemType, acct, ids, this.itemProperties));
    }
    await this.beforePlanning(acct, objects);
    const allGone = [...new Set([...gone, ...notFound])];
    const held = await this.heldByRefs([...objects.map((o) => refOf(acct, o.id)), ...allGone.map((id) => refOf(acct, id))]);
    let candidates: Held[] | null = null;
    const works: Work[] = [];
    const written = new Map<Kind, Set<string>>();
    for (const object of objects) {
      this.env.report.stats.entries++;
      const kind = this.kindOf(object);
      let found = held.get(refOf(acct, object.id)) ?? null;
      if (!found && kind && this.inSelection(acct, object)) {
        candidates ??= await this.adoptionCandidates(acct);
        found = this.takeAdoptable(candidates, kind, acct, object);
      }
      let work: Work | null;
      try {
        work = this.downloadDecision(acct, object, kind, found, written);
      } catch (error) {
        this.plannerFailed(acct, refOf(acct, object.id), 'download', error, object.id);
        continue;
      }
      if (work) works.push(work);
      else this.markResolved(acct, object.id);
    }
    const removed: Held[] = [];
    for (const id of allGone) {
      const found = held.get(refOf(acct, id));
      let work: Work | null;
      try {
        work = found ? this.removeWork(acct, id, found, 'destroyed') : null;
      } catch (error) {
        this.plannerFailed(acct, refOf(acct, id), 'download', error, id);
        continue;
      }
      if (work && found) {
        works.push(work);
        removed.push(found);
      } else this.markResolved(acct, id);
    }
    if (removed.length) works.push(...(await this.alongDestroyed(acct, removed)));
    await this.env.writer.write(works, mutate ? this.tail([acct], mutate) : undefined);
    await this.readBack(written);
  }

  private async heldByRefs(refs: readonly string[]): Promise<Map<string, Held>> {
    const out = new Map<string, Held>();
    if (!refs.length) return out;
    for (const kind of this.kinds()) {
      for (const [ref, local] of await kind.loadByRefs(refs)) if (!out.has(ref)) out.set(ref, { kind, local });
    }
    return out;
  }

  private async adoptionCandidates(acct: string): Promise<Held[]> {
    const out: Held[] = [];
    for (const kind of this.kinds()) {
      for (const local of await kind.loadNew()) {
        const meta = kind.meta(local);
        if (meta.pending && accountOfRef(meta.pending.target) === acct) out.push({ kind, local });
      }
    }
    return out;
  }

  /** A new local item whose pending create carries the object's uid: our own create whose identity was never written. */
  private takeAdoptable(candidates: Held[], kind: Kind, acct: string, object: ServerObject): Held | null {
    if (typeof object.uid !== 'string') return null;
    const index = candidates.findIndex((c) => {
      if (c.kind !== kind) return false;
      const pending = kind.meta(c.local).pending;
      return !!pending && pending.uid === object.uid && this.adoptionTargetMatches(acct, object, pending.target);
    });
    return index < 0 ? null : candidates.splice(index, 1)[0];
  }

  private downloadDecision(
    acct: string,
    object: ServerObject,
    kind: Kind | null,
    found: Held | null,
    written: Map<Kind, Set<string>> | null,
  ): Work | null {
    if (!kind || !this.inSelection(acct, object)) {
      if (!found) return null;
      const meta = found.kind.meta(found.local);
      if (found.kind === kind && (meta.dirty || meta.deleted) && !meta.isNew) {
        // Uploaded first, dropped afterwards: merged like any changed item (a deleted one's shadow follows
        // too), so the upload builds on the server's version.
        this.outsideOf(acct).add(refOf(acct, object.id));
        if (!meta.deleted) return this.downloadWork(kind, acct, object, found.local, written);
        try {
          return this.downloadWork(kind, acct, object, found.local, written);
        } catch (error) {
          // A planner that cannot take the server version leaves the deletion as it was planned.
          this.env.log(`deleted ${refOf(acct, object.id)} outside the selection keeps its shadow`, error);
          return null;
        }
      }
      return this.removeWork(acct, object.id, found, 'outside');
    }
    if (found && found.kind !== kind) {
      const meta = found.kind.meta(found.local);
      if (meta.dirty || meta.deleted) {
        this.env.report.itemError({ ref: refOf(acct, object.id), side: 'download', type: 'kindChanged' });
        return null;
      }
      return this.replaceWork(acct, object, kind, found);
    }
    return this.downloadWork(kind, acct, object, found ? found.local : null, written);
  }

  /** The object merged into its rows (inserted, updated, or adopted); an echo writes nothing but heals the baselines. */
  protected downloadWork(
    kind: Kind,
    acct: string,
    object: ServerObject,
    local: unknown,
    written: Map<Kind, Set<string>> | null,
  ): Work | null {
    const ref = refOf(acct, object.id);
    const plan = kind.planDownload(object, local ?? null, acct);
    if (plan.effect === 'none' || !chainHasWrites(plan.ops)) {
      if (local) this.onEcho(kind, acct, object);
      if (!local || kind.meta(local).dirty) return null;
      const heal = kind.planBaselineHeal(local);
      return heal && hasWrites(heal.ops) ? { group: heal } : null;
    }
    const group = local ? plan.ops : prependOps(plan.ops, [insertGuard(kind, ref)]);
    return {
      group,
      state: both(this.listing(kind, acct, object.id, true), this.staleWith(acct, this.dependents(kind, acct, object))),
      fresh: true,
      applied: () => {
        if (plan.effect === 'insert') this.env.report.stats.downloaded.created++;
        else this.env.report.stats.downloaded.updated++;
        this.env.report.conflicts += plan.conflicts;
        this.markResolved(acct, object.id);
        this.onDownloaded(kind, acct, object);
        if (written) {
          let refs = written.get(kind);
          if (!refs) written.set(kind, (refs = new Set()));
          refs.add(ref);
        }
      },
      replan: async () => {
        const current = local ? await this.reload(kind, local) : ((await kind.loadByRefs([ref])).get(ref) ?? null);
        try {
          return this.downloadWork(kind, acct, object, current, written);
        } catch (error) {
          this.plannerFailed(acct, ref, 'download', error, object.id);
          return null;
        }
      },
      failed: (reason, message) => {
        this.markStale(acct, object.id);
        this.env.report.itemError({ ref, side: 'download', type: reason, description: message });
      },
    };
  }

  /** An object that changed kind (a card that became a group): its old rows go, new ones come, atomically. */
  private replaceWork(acct: string, object: ServerObject, kind: Kind, found: Held): Work {
    const ref = refOf(acct, object.id);
    const plan = kind.planDownload(object, null, acct);
    return {
      group: concatGroups(ref, found.kind.planLocalDelete(found.local), plan.ops),
      state: both(
        both(this.listing(found.kind, acct, object.id, false), this.listing(kind, acct, object.id, true)),
        this.staleWith(acct, this.dependents(kind, acct, object)),
      ),
      applied: () => {
        this.env.report.stats.downloaded.updated++;
        this.markResolved(acct, object.id);
        this.onRemoved(found.kind, acct, object.id);
        this.onDownloaded(kind, acct, object);
      },
      failed: (reason, message) => {
        this.markStale(acct, object.id);
        this.env.report.itemError({ ref, side: 'download', type: reason, description: message });
      },
    };
  }

  /**
   * Rows of an object the server destroyed (the server delete wins over a
   * local edit: a conflict), or that left every synced collection (only
   * clean rows go; dirty ones upload first and are dropped afterwards).
   */
  protected removeWork(acct: string, id: string, found: Held, reason: Removal): Work | null {
    const ref = refOf(acct, id);
    const meta = found.kind.meta(found.local);
    if (reason === 'outside' && (meta.dirty || meta.deleted || meta.isNew)) {
      this.outsideOf(acct).add(ref);
      return null;
    }
    const conflict = reason === 'destroyed' && meta.dirty && !meta.deleted;
    return {
      group: found.kind.planLocalDelete(found.local),
      state: this.listing(found.kind, acct, id, false),
      applied: () => {
        this.env.report.stats.downloaded.deleted++;
        if (conflict) this.env.report.conflicts++;
        this.markResolved(acct, id);
        this.onRemoved(found.kind, acct, id);
      },
      replan: async () => {
        const again = (await found.kind.loadByRefs([ref])).get(ref);
        try {
          return again === undefined ? null : this.removeWork(acct, id, { kind: found.kind, local: again }, reason);
        } catch (error) {
          this.plannerFailed(acct, ref, 'download', error, id);
          return null;
        }
      },
      failed: (failure, message) => {
        this.markStale(acct, id);
        this.env.report.itemError({ ref, side: 'download', type: failure, description: message });
      },
    };
  }

  protected async reload(kind: Kind, local: unknown): Promise<unknown | null> {
    const meta = kind.meta(local);
    if (meta.sourceId) return (await kind.loadByRefs([meta.sourceId])).get(meta.sourceId) ?? null;
    const [again] = await kind.loadByRowIds([meta.rowId]);
    return again ?? null;
  }

  /** Rows as the provider stored them: clean items whose baselines drifted (normalisation) get them rewritten. */
  private async readBack(written: Map<Kind, Set<string>>): Promise<void> {
    const works: Work[] = [];
    for (const [kind, refs] of written) {
      for (const local of (await kind.loadByRefs([...refs])).values()) {
        if (kind.meta(local).dirty) continue;
        const heal = kind.planBaselineHeal(local);
        if (heal && hasWrites(heal.ops)) works.push({ group: heal });
      }
    }
    if (works.length) await this.env.writer.write(works);
  }

  // ── Uploads ──

  /**
   * Local changes to the server, per phase across the accounts: pairs, the
   * claims of new rows, splits, creates, updates, deletions, then
   * memberships. Pairs go first: the new row of a pair takes the deleted
   * row's identity, so it must not have claimed a uid of its own, and a
   * paired deletion is a move, not a deletion. Creates of every account come
   * before deletions of any, so a move between accounts never destroys
   * first. A `stateMismatch` downloads the account again and repeats the
   * phase, at most three times.
   */
  protected async uploadAll(): Promise<void> {
    const accounts = this.accountIds();
    // A teardown downloads nothing first: `ifInState` is what keeps its uploads from overwriting a server change.
    // An account without a stored state (its first sync never ended) uploads only new items; the rest waits.
    const guarded = accounts.filter((acct) => this.env.mode !== 'teardown' || !!this.env.store.account(acct).itemsState);
    for (const acct of guarded) await this.withRetries(acct, () => this.pairPhase(acct));
    await this.claimNewItems();
    const deletionsAllowed = await this.deletionPolicy(await this.loadUploadItems());
    for (const acct of guarded) await this.withRetries(acct, () => this.prePhase(acct));
    for (const phase of ['create', 'update', 'delete'] as const) {
      for (const acct of phase === 'create' ? accounts : guarded) {
        await this.withRetries(acct, () => this.phase(acct, phase, deletionsAllowed));
      }
    }
    for (const acct of guarded) await this.withRetries(acct, () => this.extraPhase(acct, deletionsAllowed));
    for (const acct of accounts) await this.adoptExtraCreated(acct);
  }

  private async withRetries(acct: string, run: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await run();
        return;
      } catch (error) {
        if (isMethodError(error) && ACCOUNT_REFUSALS.has(error.type)) {
          // The account takes no writes (a shared account turned read-only, or gone): its items wait, the others go on.
          this.env.report.itemError({ ref: acct, side: 'upload', type: error.type, description: error.message });
          return;
        }
        if (!(error instanceof StateMismatch) || error.jmapAccountId !== acct) throw error;
        if (attempt >= this.env.tuning.maxStateMismatchRetries) {
          throw new RunAbort('io', 'The server kept changing while this device uploaded', { noProgress: true });
        }
        await this.catchUp(acct);
      }
    }
  }

  /**
   * After a `stateMismatch`: download what changed, then guard the next
   * `/set` with the type's current state when nothing changed after the
   * stored one. Stalwart can name one point of the history two ways (a
   * `/changes` state against the type's state, e.g. `s…` against `n` before
   * the first item change), and `ifInState` compares them as text.
   */
  private async catchUp(acct: string): Promise<void> {
    this.setStates.delete(acct);
    await this.changesLoop(acct);
    const since = this.env.store.account(acct).itemsState;
    if (!since) return;
    const current = await this.env.jmap.takeState(this.itemType, acct);
    if (!current || current === since) return;
    const page = await this.env.jmap.changes(this.itemType, acct, since);
    // Anything new since `since` is downloaded by the next attempt; `current` may predate it.
    if (!page.created.length && !page.updated.length && !page.destroyed.length && !page.hasMoreChanges) {
      this.setStates.set(acct, current);
    }
  }

  protected ifInState(acct: string): string | null {
    if (!this.setStates.has(acct)) this.setStates.set(acct, this.env.store.account(acct).itemsState);
    return this.setStates.get(acct) ?? null;
  }

  /**
   * New items get their uid and target written before anything is sent. A
   * claim whose collection is gone from the server is made again where the
   * kind allows it (contacts: nothing of it can exist in a deleted book). A
   * new item deleted before it was claimed never reached the server, and no
   * upload phase takes it (it has no account): its plan is a purge.
   */
  private async claimNewItems(): Promise<void> {
    const works: Work[] = [];
    for (const held of await this.loadUploadItems()) {
      const meta = held.kind.meta(held.local);
      if (!meta.isNew || (meta.deleted && meta.pending) || !this.claimable(held)) continue;
      const reclaim = !!meta.pending && !!held.kind.unclaimed && this.collectionGone(meta.pending.target);
      if (meta.pending && !reclaim) continue;
      const ref = `row:${meta.rowId}`;
      const acct = this.claimAccount(held);
      if (!acct) {
        this.env.report.stats.skipped++;
        this.env.report.itemError({ ref, side: 'upload', type: 'noTargetCollection' });
        continue;
      }
      let plan;
      try {
        plan = held.kind.planUpload(reclaim ? held.kind.unclaimed!(held.local) : held.local, acct);
      } catch (error) {
        this.plannerFailed(acct, ref, 'upload', error);
        continue;
      }
      if (plan.kind === 'skip') {
        this.env.report.stats.skipped++;
        this.env.report.itemError({ ref, side: 'upload', type: plan.reason });
      } else if (plan.kind === 'revert') {
        // It may not be created where it was made (a read-only calendar): the row goes, and the report says why.
        this.env.report.stats.skipped++;
        if (plan.reason) this.env.report.itemError({ ref, side: 'upload', type: plan.reason });
        works.push(this.planWork(acct, held, 'revert', plan.ops));
      } else if (plan.kind === 'claim' || plan.kind === 'purge' || plan.kind === 'clean') {
        works.push(this.planWork(acct, held, plan.kind, plan.ops));
      }
    }
    await this.env.writer.write(works);
  }

  /**
   * The deletion threshold: more than 50 local deletions and more than 20 %
   * of the synced objects hold every deletion back (`tooManyDeletions`)
   * unless the run overrides it; `discardLocalDeletions` restores them.
   */
  private async deletionPolicy(items: Held[]): Promise<boolean> {
    const { count, synced, accounts } = await this.countDeletions(items);
    if (count === 0) return true;
    if (this.env.extras.discardLocalDeletions) {
      await this.discardDeletions(items, accounts);
      return false;
    }
    if (this.env.extras.overrideTooManyDeletions) return true;
    const t = this.env.tuning;
    if (count > t.deletionThresholdCount && count > synced * t.deletionThresholdRatio) {
      this.env.report.tooManyDeletions = {
        count,
        threshold: Math.max(t.deletionThresholdCount, Math.floor(synced * t.deletionThresholdRatio)),
      };
      return false;
    }
    return true;
  }

  /**
   * "Undo" in the too-many-deletions notification: the deleted rows go and
   * the accounts get a reconcile marker, so the next runs download the
   * objects again whatever their extras. The marker is stored first: a crash
   * in between only asks the question again.
   */
  private async discardDeletions(items: Held[], accounts: Set<string>): Promise<void> {
    await this.env.writer.write([], this.tail([...accounts], (next) => {
      for (const acct of accounts) accountOf(next, acct).reconcile = { from: null, phase: 'ids', position: 0, after: null };
      this.onDiscard(next, accounts);
    }));
    const works: Work[] = [];
    for (const held of items) {
      const meta = held.kind.meta(held.local);
      if (!meta.deleted || meta.isNew) continue;
      const acct = accountOfRef(meta.sourceId);
      if (acct) works.push(this.purgeWork(acct, held, false));
    }
    await this.env.writer.write(works);
    this.env.report.note('local deletions discarded; the objects are downloaded again');
  }

  private async phase(acct: string, phase: 'create' | 'update' | 'delete', deletionsAllowed: boolean): Promise<void> {
    const items = (await this.loadUploadItems()).filter((held) => {
      if (this.accountOfItem(held) !== acct) return false;
      const m = held.kind.meta(held.local);
      if (phase === 'create') return m.isNew && !m.deleted && !!m.pending;
      if (phase === 'update') return !m.isNew && !m.deleted && m.dirty;
      return m.deleted && (deletionsAllowed || m.isNew);
    });
    this.noteUploadItems(acct, items);
    const size = this.env.tuning.chunkSize;
    for (let i = 0; i < items.length; i += size) {
      await this.env.checkpoints.check(`upload:${phase}`);
      // From a create's /set to its identity write nothing is interruptible; start only with time for it.
      if (phase === 'create') this.env.checkpoints.requireBudget(this.env.tuning.createBudgetMs);
      const ready = await this.prepare(acct, items.slice(i, i + size));
      const toSend = phase === 'create' ? await this.lookupBeforeCreate(acct, ready) : ready;
      if (toSend.length) await this.send(acct, toSend);
    }
  }

  /** Items an upload phase looked at (contacts: their memberships are uploaded afterwards). */
  protected noteUploadItems(_acct: string, _items: Held[]): void {}

  /** Plans the items' uploads; plans that need no request are applied here. */
  protected async prepare(acct: string, items: Held[]): Promise<Pending[]> {
    await this.beforeUploadPlanning(items);
    const works: Work[] = [];
    const ready: Pending[] = [];
    for (const held of items) {
      const pending = await this.planItem(acct, held, works);
      if (pending) ready.push(pending);
    }
    await this.env.writer.write(works);
    return ready;
  }

  protected async planItem(acct: string, held: Held, works: Work[]): Promise<Pending | null> {
    const { kind, local } = held;
    const meta = kind.meta(local);
    const ref = meta.sourceId ?? `row:${meta.rowId}`;
    const report = this.env.report;
    report.stats.entries++;
    if (this.isStale(acct, meta.sourceId)) {
      report.stats.skipped++;
      report.itemError({ ref, side: 'upload', type: 'stale', description: 'Waits until the server version could be stored' });
      return null;
    }
    if (meta.isNew && !meta.deleted && meta.pending && this.collectionGone(meta.pending.target)) {
      // Nothing can be created there (an event stays in its calendar until the user moves it).
      report.stats.skipped++;
      report.itemError({ ref, side: 'upload', type: 'collectionGone', description: `${meta.pending.target} no longer exists on the server` });
      return null;
    }
    const fingerprint = kind.fingerprint(local);
    if (meta.poison && isBackedOff(meta.poison, fingerprint, this.env.now())) {
      report.stats.skipped++;
      report.itemError({ ref, side: 'upload', type: meta.poison.type, description: meta.poison.description, retryAt: meta.poison.until });
      return null;
    }
    let plan;
    try {
      plan = kind.planUpload(local, acct);
    } catch (error) {
      this.plannerFailed(acct, ref, 'upload', error);
      return null;
    }
    switch (plan.kind) {
      case 'upload': {
        const actions = await this.resolveDestroysByUid(acct, meta, plan.actions);
        if (actions.length === 0) {
          works.push(this.purgeWork(acct, held, false));
          return null;
        }
        return { held, meta, fingerprint, actions };
      }
      case 'revert':
        report.stats.skipped++;
        if (plan.reason) report.itemError({ ref, side: 'upload', type: plan.reason });
        works.push(this.planWork(acct, held, 'revert', plan.ops));
        if (plan.refetch) {
          const id = idInAccount(meta.sourceId, acct);
          if (id) this.markStale(acct, id);
        }
        return null;
      case 'skip':
        report.stats.skipped++;
        report.itemError({ ref, side: 'upload', type: plan.reason });
        return null;
      default:
        works.push(this.planWork(acct, held, plan.kind, plan.ops));
        return null;
    }
  }

  /** A plan applied locally (clean, claim, purge, revert); replanned once more after an assert failure. */
  private planWork(acct: string, held: Held, kind: 'clean' | 'claim' | 'purge' | 'revert', group: OpGroup): Work {
    return {
      group,
      replan: async () => {
        const again = await this.reload(held.kind, held.local);
        if (again === null) return null;
        const plan = held.kind.planUpload(again, acct);
        return plan.kind === kind && 'ops' in plan ? this.planWork(acct, { kind: held.kind, local: again }, kind, plan.ops) : null;
      },
    };
  }

  /** The rows of an item whose deletion reached the server (or never had to). */
  protected purgeWork(acct: string, held: Held, uploaded: boolean): Work {
    const meta = held.kind.meta(held.local);
    const id = idInAccount(meta.sourceId, acct);
    return {
      group: held.kind.planLocalDelete(held.local),
      state: id ? this.listing(held.kind, acct, id, false) : undefined,
      applied: () => {
        if (uploaded) this.env.report.stats.uploaded.deleted++;
        if (id) this.onRemoved(held.kind, acct, id);
      },
      replan: async () => {
        const again = await this.reload(held.kind, held.local);
        return again === null ? null : this.purgeWork(acct, { kind: held.kind, local: again }, uploaded);
      },
    };
  }

  /** A destroy of "whatever carries this uid" (the create's outcome is unknown) becomes destroys of what the lookup finds. */
  private async resolveDestroysByUid(acct: string, meta: ItemMeta, actions: Action[]): Promise<Action[]> {
    const out: Action[] = [];
    for (const action of actions) {
      if (action.kind !== 'destroy' || action.id !== null) {
        out.push(action);
        continue;
      }
      if (!action.uid) continue;
      const collection = meta.pending ? meta.pending.target.slice(meta.pending.target.indexOf('/') + 1) : '';
      const found = await this.env.jmap.lookupUids(this.itemType, acct, [action.uid], this.lookupScope(acct, collection));
      for (const id of found.get(action.uid) ?? []) out.push({ ...action, id });
    }
    return out;
  }

  /** The uid lookup before a create: a hit is adopted (the row takes its identity and uploads as an update). */
  private async lookupBeforeCreate(acct: string, ready: Pending[]): Promise<Pending[]> {
    const scopes = new Map<string | null, Set<string>>();
    for (const p of ready) {
      for (const a of p.actions) {
        if (a.kind !== 'create') continue;
        const scope = this.lookupScope(acct, a.collectionId);
        let uids = scopes.get(scope);
        if (!uids) scopes.set(scope, (uids = new Set()));
        uids.add(a.uid);
      }
    }
    const found = new Map<string, string>();
    const keyOf = (collectionId: string, uid: string) => `${this.lookupScope(acct, collectionId) ?? ''}\u0000${uid}`;
    for (const [scope, uids] of scopes) {
      const hits = await this.env.jmap.lookupUids(this.itemType, acct, [...uids], scope);
      for (const [uid, ids] of hits) found.set(`${scope ?? ''}\u0000${uid}`, ids[0]);
    }
    if (!found.size) return ready;
    const out: Pending[] = [];
    const works: Work[] = [];
    for (const p of ready) {
      const own = p.actions.find((a) => a.kind === 'create' && a.uid === p.meta.pending?.uid);
      const ownId = own?.kind === 'create' ? found.get(keyOf(own.collectionId, own.uid)) : undefined;
      if (ownId) {
        works.push(...(await this.adoptWorks(acct, p, ownId)));
        continue;
      }
      const actions = p.actions.filter((a) => a.kind !== 'create' || !found.has(keyOf(a.collectionId, a.uid)));
      if (actions.length) out.push({ ...p, actions });
    }
    await this.env.writer.write(works);
    return out;
  }

  /**
   * The row takes the server object's identity and is merged as a dirty
   * item (the planner adopts by pending uid). Only an object in the
   * create's target collection can be the row's own earlier create: event
   * uids are unique per account, and an unrelated event elsewhere with the
   * same uid must not receive this row's content (the item is poisoned).
   */
  private async adoptWorks(acct: string, p: Pending, id: string): Promise<Work[]> {
    const { list } = await this.env.jmap.get<ServerObject>(this.itemType, acct, [id], this.itemProperties);
    const object = list[0];
    if (!object) return [];
    const target = p.meta.pending?.target;
    if (!target || !this.adoptionTargetMatches(acct, object, target)) {
      return [this.poisonWork(p, { type: 'uidConflict', description: `Another object (${refOf(acct, id)}) has this uid` })];
    }
    await this.beforePlanning(acct, [object]);
    const work = this.downloadWork(p.held.kind, acct, object, p.held.local, null);
    // Our own earlier create: remembered like one of this run.
    return work ? [withState(work, this.rememberCreated(acct, id))] : [];
  }

  /** Sends the items' actions in `/set` calls and settles each item once all its actions have an answer. */
  protected async send(acct: string, pending: Pending[]): Promise<void> {
    const calls = this.packCalls(pending);
    const objects = new Map<string, ServerObject>();
    const outcomes = new Map<Pending, Outcome[]>();
    const remaining = new Map<Pending, number>(pending.map((p) => [p, p.actions.length]));
    const retry: Pending[] = [];
    for (const call of calls) {
      const response = await this.setCall(acct, call, objects);
      const settled: Pending[] = [];
      for (const entry of call.entries) {
        const outcome = this.outcomeOf(response, entry.action, entry.key, call.args.sendSchedulingMessages);
        // No answer for it at all: left as it is, the next run looks again.
        if (!outcome) continue;
        let list = outcomes.get(entry.pending);
        if (!list) outcomes.set(entry.pending, (list = []));
        list.push(outcome);
        const left = (remaining.get(entry.pending) ?? 1) - 1;
        remaining.set(entry.pending, left);
        if (left === 0) settled.push(entry.pending);
      }
      // Identities of this call's creates are written before anything else runs.
      const works: Work[] = [];
      for (const p of settled) works.push(...(await this.settle(acct, p, outcomes.get(p) ?? [], objects, retry)));
      await this.env.writer.write(works);
    }
    if (retry.length) await this.send(acct, retry);
  }

  private packCalls(pending: Pending[]): SetCallPlan[] {
    const limits = this.env.jmap.limits();
    const maxObjects = Math.max(1, limits.maxObjectsInSet);
    const maxCreates = Math.max(1, Math.min(this.env.tuning.maxCreatesPerSet, maxObjects));
    const maxBytes = Math.min(this.env.tuning.maxSetBytes, Math.max(1, limits.maxSizeRequest - 10_000));
    const calls: SetCallPlan[] = [];
    const open = new Map<boolean, SetCallPlan>();
    let creation = 0;
    const fresh = (scheduling: boolean): SetCallPlan => ({
      args: { create: {}, update: {}, destroy: [], sendSchedulingMessages: scheduling },
      entries: [],
      touched: new Set(),
      updateIds: [],
      creates: 0,
      bytes: 0,
    });
    for (const p of pending) {
      for (const action of p.actions) {
        // `sendSchedulingMessages` is a request-level flag: one value per call.
        const scheduling = !p.noScheduling && !!action.sendSchedulingMessages;
        const size = JSON.stringify(action).length;
        const id = action.kind === 'create' ? null : action.id;
        let call = open.get(scheduling);
        const fits =
          !!call &&
          call.entries.length + 1 <= maxObjects &&
          (action.kind !== 'create' || call.creates + 1 <= maxCreates) &&
          call.bytes + size <= maxBytes &&
          (id === null || !call.touched.has(id));
        if (!call || !fits) {
          call = fresh(scheduling);
          calls.push(call);
          open.set(scheduling, call);
        }
        let key: string;
        if (action.kind === 'create') {
          key = `k${++creation}`;
          call.args.create[key] = this.createObject(action);
          call.creates++;
        } else if (action.kind === 'update') {
          key = action.id;
          call.args.update[key] = action.patch;
          call.updateIds.push(key);
        } else {
          key = action.id as string;
          call.args.destroy.push(key);
        }
        call.touched.add(key);
        call.bytes += size;
        call.entries.push({ pending: p, action, key });
      }
    }
    return calls;
  }

  private createObject(action: Extract<Action, { kind: 'create' }>): Record<string, unknown> {
    const object: Record<string, unknown> = { ...(action.object as Record<string, unknown>), uid: action.uid };
    if (!object[this.parentProperty]) object[this.parentProperty] = { [action.collectionId]: true };
    return object;
  }

  /**
   * One `/set` of the authority's type, guarded by `ifInState`; our
   * `newState` guards the next one. `stateMismatch` (and Stalwart's
   * `serverUnavailable`, a concurrent write that failed the whole call)
   * throws StateMismatch: the phase downloads again and repeats.
   */
  protected async setChecked(
    acct: string,
    args: SetArgs,
    thenGet?: { ids: string[]; properties: readonly string[] },
  ): Promise<{ response: SetResponse; got: ServerObject[] | null }> {
    let result;
    try {
      result = await this.env.jmap.set<ServerObject>(this.itemType, acct, args, this.ifInState(acct), thenGet);
    } catch (error) {
      if (isMethodError(error, 'stateMismatch') || isMethodError(error, 'serverUnavailable')) throw new StateMismatch(acct);
      throw error;
    }
    if (result.response.newState) {
      this.setStates.set(acct, result.response.newState);
      this.env.recordKnownState(acct, this.itemType, result.response.newState);
    }
    return result;
  }

  private async setCall(acct: string, call: SetCallPlan, objects: Map<string, ServerObject>): Promise<SetResponse> {
    const { response, got } = await this.setChecked(
      acct,
      {
        create: call.args.create,
        update: call.args.update,
        destroy: call.args.destroy,
        sendSchedulingMessages: call.args.sendSchedulingMessages,
      },
      call.updateIds.length ? { ids: call.updateIds, properties: this.itemProperties } : undefined,
    );
    for (const object of got ?? []) objects.set(object.id, object);
    // Stalwart resolves no result reference to a /set: created objects are fetched in a request of their own.
    const createdIds = Object.values(response.created ?? {}).map((c) => c?.id).filter((id): id is string => !!id);
    if (createdIds.length) {
      const { list } = await this.env.jmap.get<ServerObject>(this.itemType, acct, createdIds, this.itemProperties);
      for (const object of list) objects.set(object.id, object);
    }
    return response;
  }

  private outcomeOf(response: SetResponse, action: Action, key: string, scheduling: boolean): Outcome | null {
    if (action.kind === 'create') {
      const created = response.created?.[key];
      if (created?.id) return { action, ok: true, id: created.id };
      const error = response.notCreated?.[key];
      return error ? { action, ok: false, error, scheduling } : null;
    }
    if (action.kind === 'update') {
      if (response.updated && key in response.updated) return { action, ok: true, id: key };
      const error = response.notUpdated?.[key];
      return error ? { action, ok: false, error, scheduling } : null;
    }
    if (response.destroyed?.includes(key)) return { action, ok: true, id: key };
    const error = response.notDestroyed?.[key];
    return error ? { action, ok: false, error, scheduling } : null;
  }

  /** What the server's answers mean for one item (docs/device-sync.md, "Uploads", SetErrors). */
  private async settle(
    acct: string,
    p: Pending,
    outcomes: Outcome[],
    objects: Map<string, ServerObject>,
    retry: Pending[],
  ): Promise<Work[]> {
    const failure = outcomes.find((o): o is Extract<Outcome, { ok: false }> => !o.ok);
    if (!failure) {
      // Stored without the scheduling messages it asked for (see `forbidden` below).
      if (p.noScheduling) this.env.report.note('invitations not sent');
      return this.succeeded(acct, p, outcomes, objects);
    }
    switch (classifySetError(failure.error, failure.action.kind)) {
      case 'notFound':
        if (failure.action.kind === 'destroy') {
          // Gone already: the deletion is done.
          const done = outcomes.map((o): Outcome => (o === failure ? { action: o.action, ok: true, id: (o.action as { id: string }).id } : o));
          return this.succeeded(acct, p, done, objects);
        }
        if (failure.action.kind === 'update') {
          // Deleted on the server meanwhile: the server delete wins, the rows go (a pair's new row too).
          const id = idInAccount(p.meta.sourceId, acct);
          const work = id ? this.removeWork(acct, id, p.held, 'destroyed') : null;
          return work ? [work, ...(await this.alongDestroyed(acct, [p.held]))] : [];
        }
        return [this.poisonWork(p, failure.error)];
      case 'forbidden':
        if (failure.scheduling && !p.noScheduling) {
          // Scheduling is off, the account has no calendar address, or no permission: store the change without it.
          // A second refusal is about rights, not invitations: the note waits for the change to be stored.
          retry.push({ ...p, noScheduling: true });
          return [];
        }
        if (failure.action.kind === 'create') return [this.poisonWork(p, failure.error)];
        return this.revertWorks(acct, p, failure.error);
      case 'uidExists':
        return this.adoptAfterUidError(acct, p, failure);
      default:
        return [this.poisonWork(p, failure.error)];
    }
  }

  private async succeeded(acct: string, p: Pending, outcomes: Outcome[], objects: Map<string, ServerObject>): Promise<Work[]> {
    const ownUid = p.meta.pending?.uid;
    let ownId = idInAccount(p.meta.sourceId, acct);
    let created = false;
    for (const o of outcomes) {
      if (!o.ok || o.action.kind !== 'create') continue;
      if (!ownId && o.action.uid === ownUid) {
        ownId = o.id;
        created = true;
      } else {
        let set = this.extraCreated.get(acct);
        if (!set) this.extraCreated.set(acct, (set = new Set()));
        set.add(o.id);
      }
    }
    if (p.accept) return p.accept(objects);
    const server = ownId ? objects.get(ownId) : undefined;
    if (!p.meta.deleted && !server) {
      // Accepted, but its new version could not be read: fetched again next run, nothing uploads for it meanwhile.
      if (ownId) this.markStale(acct, ownId);
      return [];
    }
    try {
      return [p.meta.deleted ? this.purgeWork(acct, p.held, true) : this.acceptWork(acct, p, server as ServerObject, created)];
    } catch (error) {
      // Uploaded, but the rows could not be planned: the shadow is behind, fetch it again.
      this.plannerFailed(acct, p.meta.sourceId ?? `row:${p.meta.rowId}`, 'upload', error, ownId ?? undefined);
      return [];
    }
  }

  /**
   * The accepted version becomes the shadow and the baselines, DIRTY is
   * cleared, behind the assert the upload was read under; edited again
   * meanwhile, only identity, shadow and the uploaded baselines are written
   * and DIRTY stays (the newer edit uploads next).
   */
  protected acceptWork(acct: string, p: Pending, server: ServerObject, created: boolean): Work {
    const { kind, local } = p.held;
    const plan = kind.planAccepted(local, server, acct);
    const extra = p.meta.poison ? [poisonOp(kind, p.meta.rowId, null)] : [];
    // With the item's last group: a big one comes in several (OpGroup.next).
    const withExtra = (group: OpGroup): OpGroup => appendToLast(group, extra);
    const counted = () => {
      if (created) this.env.report.stats.uploaded.created++;
      else this.env.report.stats.uploaded.updated++;
      // In no synced collection any more (moved away on the server): the rows go after the upload.
      if (!this.inSelection(acct, server)) this.outsideOf(acct).add(refOf(acct, server.id));
      this.onAccepted(kind, acct, server);
    };
    const failed = (reason: string, message: string) => {
      this.markStale(acct, server.id);
      this.env.report.itemError({ ref: refOf(acct, server.id), side: 'upload', type: reason, description: message });
    };
    const state = both(this.listing(kind, acct, server.id, true), created ? this.rememberCreated(acct, server.id) : undefined);
    return {
      group: withExtra(plan.ops),
      state,
      applied: counted,
      replan: async () => ({ group: withExtra(plan.keepDirtyOps), state, applied: counted, failed }),
      failed,
    };
  }

  /** An object our upload created is remembered with its identity until the next run fetched it (see `refetchStale`). */
  private rememberCreated(acct: string, id: string): StateChange {
    return (next) => {
      const account = accountOf(next, acct);
      account.created = [...new Set([...(account.created ?? []), id])];
    };
  }

  private poisonWork(p: Pending, error: SetErrorShape): Work {
    const marker = nextMarker(p.meta.poison, p.fingerprint, error, this.env.now(), {
      firstMs: this.env.tuning.poisonBackoffMs,
      maxMs: this.env.tuning.poisonBackoffMaxMs,
    });
    const ref = p.meta.sourceId ?? `row:${p.meta.rowId}`;
    this.env.report.stats.skipped++;
    this.env.report.itemError({ ref, side: 'upload', type: error.type, description: error.description, retryAt: marker.until });
    return { group: { ref, ops: [poisonOp(p.held.kind, p.meta.rowId, marker)] } };
  }

  /** Not allowed after all (read-only on the server): the rows are rewritten from the server's version. */
  private async revertWorks(acct: string, p: Pending, error: SetErrorShape): Promise<Work[]> {
    const { kind, local } = p.held;
    const ref = p.meta.sourceId ?? `row:${p.meta.rowId}`;
    this.env.report.stats.skipped++;
    this.env.report.itemError({ ref, side: 'upload', type: error.type, description: error.description });
    const id = idInAccount(p.meta.sourceId, acct);
    const remove = kind.planLocalDelete(local);
    const object = id ? (await this.env.jmap.get<ServerObject>(this.itemType, acct, [id], this.itemProperties)).list[0] : undefined;
    const objectKind = object ? this.kindOf(object) : null;
    if (!object || !objectKind || !this.inSelection(acct, object)) {
      return [{
        group: remove,
        state: id ? this.listing(kind, acct, id, false) : undefined,
        applied: () => (id ? this.onRemoved(kind, acct, id) : undefined),
      }];
    }
    await this.beforePlanning(acct, [object]);
    // An edit is undone in place, so what only the device keeps stays: a star, a ringtone, a joined contact, row ids.
    if (objectKind === kind && !p.meta.deleted) return [this.overwriteWork(acct, kind, local, object)];
    const insert = objectKind.planDownload(object, null, acct);
    return [{
      group: concatGroups(ref, remove, insert.ops),
      state: both(this.listing(kind, acct, object.id, false), this.listing(objectKind, acct, object.id, true)),
      applied: () => this.onDownloaded(objectKind, acct, object),
    }];
  }

  /** The rows become `object` where they are and DIRTY is cleared (the planner's write of an accepted version). */
  private overwriteWork(acct: string, kind: Kind, local: unknown, object: ServerObject): Work {
    return {
      group: kind.planAccepted(local, object, acct).ops,
      state: this.listing(kind, acct, object.id, true),
      applied: () => this.onDownloaded(kind, acct, object),
      replan: async () => {
        const again = await this.reload(kind, local);
        return again === null ? null : this.overwriteWork(acct, kind, again, object);
      },
      failed: (reason, message) => {
        this.markStale(acct, object.id);
        this.env.report.itemError({ ref: refOf(acct, object.id), side: 'upload', type: reason, description: message });
      },
    };
  }

  /**
   * `invalidProperties` on `uid`: the object exists (a lost response, or the
   * client's automatic retry of the create). Cards name it in the error;
   * events are looked up again with back-off (the uid index lags), else the
   * next download adopts the row by uid.
   */
  private async adoptAfterUidError(acct: string, p: Pending, failure: Extract<Outcome, { ok: false }>): Promise<Work[]> {
    const action = failure.action as Extract<Action, { kind: 'create' }>;
    if (action.uid !== p.meta.pending?.uid) return [];
    let id = existingIdFromUidError(failure.error);
    if (!id) {
      const scope = this.lookupScope(acct, action.collectionId);
      for (const delay of [0, ...this.env.tuning.uidLookupDelaysMs]) {
        if (delay) await this.env.sleep(delay);
        const ids = (await this.env.jmap.lookupUids(this.itemType, acct, [action.uid], scope)).get(action.uid);
        if (ids?.length) {
          id = ids[0];
          break;
        }
      }
    }
    return id ? this.adoptWorks(acct, p, id) : [];
  }

  /** Objects our uploads created for other rows come back through the download, which adopts them by uid. */
  private async adoptExtraCreated(acct: string): Promise<void> {
    const ids = [...(this.extraCreated.get(acct) ?? [])];
    this.extraCreated.delete(acct);
    if (ids.length) await this.processIds(acct, ids, []);
  }
}
