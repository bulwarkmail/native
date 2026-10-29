/**
 * The SyncState blob (docs/device-sync.md, "SyncState"): one per Android
 * account and authority, versioned JSON the provider stores next to the
 * rows. It is only ever written as the last op of a batch whose rows it
 * describes, so a crash never leaves it ahead of them.
 */
import { clone } from '../common/json';
import type { ProviderOp, ReminderOwner } from '../types';

export const SYNC_STATE_VERSION = 1;

/** A full reconcile in progress. */
export interface ReconcileMarker {
  /** The item state taken before listing anything; null when a reconcile was asked for and has not started. */
  from: string | null;
  phase: 'ids' | 'objects';
  /** Objects processed so far, in the reconcile's order. */
  position: number;
  /** The last id processed in that (sorted) order: a resumed reconcile continues after it. */
  after: string | null;
  /** Keys of the collections the reconcile lists; one selected since is loaded after it. Absent: every synced one. */
  collections?: string[];
}

export interface AccountState {
  /** AddressBook / Calendar state of the last collections read. */
  collectionsState: string | null;
  /** ContactCard / CalendarEvent state the rows describe. */
  itemsState: string | null;
  /** Collection keys whose rows are all on the device. */
  selected: string[];
  /**
   * Collection keys whose rows may be on the device in part: a load or a drop that has not ended. Selected, such
   * a collection is loaded again; deselected, it is dropped again.
   */
  partial?: string[];
  /** Object ids whose rows could not be written; fetched again at the start of every run, nothing uploads for them meanwhile. */
  stale: string[];
  /**
   * Objects our uploads created after `itemsState`: fetched again at the start of the next run, since `/changes`
   * omits an object created and destroyed after its `sinceState`.
   */
  created?: string[];
  reconcile: ReconcileMarker | null;
  /** Contacts: refs of the group cards present on the device (a hard-deleted group is found by its absence). */
  groups?: string[];
  /** Calendar: ids of calendars found to hold only tasks. */
  taskOnly?: string[];
}

export interface SyncState {
  v: typeof SYNC_STATE_VERSION;
  /** The registry account and server origin the rows belong to. */
  owner: { registryId: string; origin: string } | null;
  accounts: Record<string, AccountState>;
  /** Calendar: the zone floating events were written in. */
  deviceZone?: string | null;
  /** Calendar: the zone a zone-change pass is moving floating events to. */
  deviceZonePending?: string | null;
  /** Calendar: who the Reminders rows were written for (a change rewrites them). */
  reminderOwner?: ReminderOwner | null;
}

export function emptySyncState(): SyncState {
  return { v: SYNC_STATE_VERSION, owner: null, accounts: {} };
}

export function emptyAccountState(): AccountState {
  return { collectionsState: null, itemsState: null, selected: [], stale: [], reconcile: null };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
const stringOrNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

function parseReconcile(value: unknown): ReconcileMarker | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const marker: ReconcileMarker = {
    from: stringOrNull(r.from),
    phase: r.phase === 'objects' ? 'objects' : 'ids',
    position: typeof r.position === 'number' && r.position >= 0 ? r.position : 0,
    after: stringOrNull(r.after),
  };
  if (Array.isArray(r.collections)) marker.collections = strings(r.collections);
  return marker;
}

function parseAccount(value: unknown): AccountState {
  const a = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const out: AccountState = {
    collectionsState: stringOrNull(a.collectionsState),
    itemsState: stringOrNull(a.itemsState),
    selected: strings(a.selected),
    stale: strings(a.stale),
    reconcile: parseReconcile(a.reconcile),
  };
  if (a.partial !== undefined) out.partial = strings(a.partial);
  if (a.created !== undefined) out.created = strings(a.created);
  if (a.groups !== undefined) out.groups = strings(a.groups);
  if (a.taskOnly !== undefined) out.taskOnly = strings(a.taskOnly);
  return out;
}

/**
 * The stored blob. `readable` is false when there was one that could not be
 * understood (another version, garbage): the rows are then treated as ours
 * and every account starts over with a full reconcile.
 */
export function parseSyncState(text: string | null): { state: SyncState; readable: boolean } {
  if (!text) return { state: emptySyncState(), readable: true };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { state: emptySyncState(), readable: false };
  }
  const r = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
  if (!r || r.v !== SYNC_STATE_VERSION) return { state: emptySyncState(), readable: false };
  const owner = r.owner as Record<string, unknown> | null | undefined;
  const state: SyncState = {
    v: SYNC_STATE_VERSION,
    owner:
      owner && typeof owner.registryId === 'string' && typeof owner.origin === 'string'
        ? { registryId: owner.registryId, origin: owner.origin }
        : null,
    accounts: {},
  };
  if (r.accounts && typeof r.accounts === 'object') {
    for (const [id, account] of Object.entries(r.accounts as Record<string, unknown>)) {
      state.accounts[id] = parseAccount(account);
    }
  }
  if ('deviceZone' in r) state.deviceZone = stringOrNull(r.deviceZone);
  if ('deviceZonePending' in r) state.deviceZonePending = stringOrNull(r.deviceZonePending);
  if (r.reminderOwner === 'device' || r.reminderOwner === 'bulwark') state.reminderOwner = r.reminderOwner;
  return { state, readable: true };
}

export function serializeSyncState(state: SyncState): string {
  return JSON.stringify(state);
}

/** The op that ends a batch and moves the stored state along with its rows. */
export interface Tail {
  op(): ProviderOp;
  /** Called once the batch carrying `op()` applied. */
  applied(): void;
}

/** A change of the SyncState that has to be stored together with the rows it describes. */
export type StateChange = (next: SyncState) => void;

/**
 * The committed SyncState of a run. Changes are proposed as a tail: the
 * batch writer calls `op()` right before sending the last batch (so the
 * change sees what earlier batches decided, e.g. items put on `stale`), and
 * the state is only adopted after that batch applied. Changes that describe
 * the rows of one batch (contacts: the groups present) are staged by the
 * batch writer while it sends that batch, so its state op carries them.
 */
export class StateStore {
  private state: SyncState;
  private readonly staged = new Map<object, StateChange>();

  constructor(
    initial: SyncState,
    private readonly owner: { registryId: string; origin: string } | null,
    private readonly onCommit?: (before: SyncState, after: SyncState) => void,
  ) {
    this.state = clone(initial);
  }

  get committed(): Readonly<SyncState> {
    return this.state;
  }

  account(jmapAccountId: string): Readonly<AccountState> {
    return this.state.accounts[jmapAccountId] ?? emptyAccountState();
  }

  /** Every state op built until `unstage(key)` applies `change` too, after its own changes. */
  stage(key: object, change: StateChange): void {
    this.staged.set(key, change);
  }

  unstage(key: object): void {
    this.staged.delete(key);
  }

  /** A tail applying `mutate` (then the staged changes) to a copy of the committed state (plus the owner). */
  tail(mutate: (next: SyncState) => void): Tail {
    let next: SyncState | null = null;
    return {
      op: () => {
        next = clone(this.state);
        if (this.owner) next.owner = { ...this.owner };
        mutate(next);
        for (const change of this.staged.values()) change(next);
        return { op: 'syncState', value: serializeSyncState(next) };
      },
      applied: () => {
        if (!next) return;
        const before = this.state;
        this.state = next;
        this.onCommit?.(before, next);
      },
    };
  }
}

/** The account's entry in a state being built, created when missing. */
export function accountOf(state: SyncState, jmapAccountId: string): AccountState {
  let account = state.accounts[jmapAccountId];
  if (!account) {
    account = emptyAccountState();
    state.accounts[jmapAccountId] = account;
  }
  return account;
}
