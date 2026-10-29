/**
 * Contracts of Android device sync (#34): the native bridge, the provider row
 * and operation model, the headless payload and the run report. The design is
 * in docs/device-sync.md; this file is its machine-checked half.
 *
 * Pure types and constants. Nothing here, nor in the mappers and merge rules
 * built on it, may import react-native: vitest runs them in node.
 */

// ─── Authorities and the headless task ─────────────────

export const CONTACTS_AUTHORITY = 'com.android.contacts';
export const CALENDAR_AUTHORITY = 'com.android.calendar';
export type Authority = typeof CONTACTS_AUTHORITY | typeof CALENDAR_AUTHORITY;
export const AUTHORITIES: readonly Authority[] = [CONTACTS_AUTHORITY, CALENDAR_AUTHORITY];

/** The headless JS task the sync adapters start (registered in index.ts). */
export const DEVICE_SYNC_TASK = 'BulwarkDeviceSync';

/** Event the native module emits when accounts of our type change. */
export const ACCOUNTS_CHANGED_EVENT = 'BulwarkDeviceSync:accountsChanged';

// ─── Provider rows ─────────────────────────────────────

/** Tables the native side lets the engine touch, per authority. */
export type ContactsTable = 'raw_contacts' | 'data' | 'groups' | 'settings';
export type CalendarTable =
  | 'calendars'
  | 'events'
  | 'attendees'
  | 'reminders'
  | 'extended_properties'
  | 'colors';
export type ProviderTable = ContactsTable | CalendarTable;

export const CONTACTS_TABLES: readonly ContactsTable[] = ['raw_contacts', 'data', 'groups', 'settings'];
export const CALENDAR_TABLES: readonly CalendarTable[] = [
  'calendars',
  'events',
  'attendees',
  'reminders',
  'extended_properties',
  'colors',
];

/**
 * A cell as it crosses the bridge: text, a number (booleans are 0/1, times are
 * epoch milliseconds, ids fit a double) or null. Blob columns are written as
 * `{ b64 }` (the photo bytes) and never read back through `query`.
 */
export type Cell = string | number | null;
export type BlobCell = { b64: string };
export type WriteCell = Cell | BlobCell;
export type Row = Record<string, Cell>;
export type WriteRow = Record<string, WriteCell>;

export interface ProviderQuery {
  table: ProviderTable;
  columns: string[];
  /**
   * SQL WHERE clause with `?` placeholders. The native side ANDs the account
   * scope onto it, so it never needs (and must not rely on) account columns.
   */
  where?: string;
  args?: Array<string | number>;
  orderBy?: string;
}

/** Query results, column-major names and row-major cells. */
export interface ProviderRows {
  columns: string[];
  rows: Cell[][];
}

/**
 * One provider operation. `id` addresses one row of our account by `_id`;
 * `where`/`args` address a set (always ANDed with the account scope). With
 * both, the op addresses the id row if it matches `where`. An op with `id`
 * expects exactly one row unless `expectCount` says otherwise, so a row that
 * vanished fails the batch with `assert`.
 *
 * - `insert.refs` maps a column to the index of an earlier `insert` in the
 *   same batch whose new row id fills it (ContentProviderOperation
 *   back-references), so one batch can create a raw contact and its data rows,
 *   or an event and its attendees. A column in both `refs` and `values` takes
 *   the back-reference. Settings rows return no id and cannot be referenced.
 * - `assert` fails the whole batch unless the addressed rows hold `values`
 *   (compared as text, as ContentProviderOperation does) and, when given,
 *   their number is `expectCount`.
 * - `syncState` replaces this account's SyncState blob. It must be the last
 *   op of its batch and never a yield point (refused with `scope`).
 * - `yieldAllowed` marks the first op of an item group: the provider may
 *   commit everything before it and let other writers in. Contacts batches
 *   must mark one at least every 400 ops (ContactsProvider refuses a batch
 *   with 500 ops up to and including a yield point).
 *
 * What the real providers do with the cells (the fake provider copies it):
 * - contacts `data1`..`data14` are TEXT columns, so a number written there
 *   reads back as a string (`2` → `"2"`);
 * - `Events.dirty` and `Calendars.dirty` are NULL, not 0, after an insert by
 *   the sync adapter: write `dirty: 0` explicitly, and select dirty rows with
 *   `dirty = 1`;
 * - attendees, reminders and extended properties are read through a join,
 *   where `_id` is ambiguous: address one of their rows with `id`, never
 *   with `_id` in `where`. Extended properties are updated by `id` only.
 * - an insert (or an update) naming a parent row, exception master or group
 *   that no longer exists fails with `assert`, so the engine re-reads; one of
 *   another account fails with `scope`.
 */
export type ProviderOp =
  | { op: 'insert'; table: ProviderTable; values: WriteRow; refs?: Record<string, number>; yieldAllowed?: boolean }
  | {
      op: 'update';
      table: ProviderTable;
      id?: number;
      where?: string;
      args?: Array<string | number>;
      values: WriteRow;
      expectCount?: number;
      yieldAllowed?: boolean;
    }
  | {
      op: 'delete';
      table: ProviderTable;
      id?: number;
      where?: string;
      args?: Array<string | number>;
      expectCount?: number;
      yieldAllowed?: boolean;
    }
  | {
      op: 'assert';
      table: ProviderTable;
      id?: number;
      where?: string;
      args?: Array<string | number>;
      values?: Row;
      expectCount?: number;
      yieldAllowed?: boolean;
    }
  | { op: 'syncState'; value: string; yieldAllowed?: boolean };

export interface OpResult {
  /** New row id for an insert. */
  id?: number;
  /** Rows touched by an update or delete. */
  count?: number;
}

/**
 * Why a batch failed. Nothing of a failed batch is applied except item groups
 * the provider committed at yield points it actually took, which it does only
 * under contention; callers must therefore re-read before retrying.
 * - `assert`: an assert op did not hold (a concurrent edit), or an
 *   `expectCount` did not match.
 * - `tooLarge`: the batch exceeded the Binder transaction limit; split it.
 * - `scope`: the native side refused an op outside our account (an engine bug).
 * - `permission`: the runtime permission for the authority is gone.
 * - `provider`: anything else the provider threw.
 */
export type BatchFailure = 'assert' | 'tooLarge' | 'scope' | 'permission' | 'provider';

export type BatchResult =
  | { ok: true; results: OpResult[] }
  | { ok: false; reason: BatchFailure; message: string };

export interface PhotoData {
  /** JPEG, downscaled so its longer side is at most the requested size. */
  jpegBase64: string;
  /** `Photo.PHOTO_FILE_ID` of the display photo it was read from, if any. */
  fileId: number | null;
}

/**
 * The provider, bound to one Android account and one authority. Implemented
 * by src/device-sync/native.ts on the device and by the in-memory fake in
 * tests. All calls are scoped: rows of other accounts are invisible.
 */
export interface ProviderPort {
  readonly accountName: string;
  readonly authority: Authority;
  query(q: ProviderQuery): Promise<ProviderRows>;
  applyBatch(ops: ProviderOp[]): Promise<BatchResult>;
  readSyncState(): Promise<string | null>;
  /** Contacts only: the raw contact's display photo (or thumbnail), or null. */
  readPhoto(rawContactId: number, maxPx: number): Promise<PhotoData | null>;
}

// ─── Accounts and sync settings ────────────────────────

export interface AndroidAccount {
  /** Account name as Android shows it (the login, or the registry id on a clash). */
  name: string;
  /** `AccountEntry.id` of the app account it belongs to, from the account's userData. */
  registryId: string | null;
}

export interface AuthoritySyncSettings {
  /** `ContentResolver.getIsSyncable`: 1 yes, 0 no, -1 unknown. */
  syncable: number;
  /** `getSyncAutomatically`: the toggle in Settings → Accounts. */
  automatic: boolean;
  /** Period of our periodic sync in seconds, or 0 when there is none. */
  periodicSeconds: number;
  active: boolean;
  pending: boolean;
}

export interface AccountSyncSettings {
  /** `getMasterSyncAutomatically`: "Auto-sync data" for the whole device. */
  masterAutomatic: boolean;
  authorities: Record<Authority, AuthoritySyncSettings>;
}

export interface RequestSyncOptions {
  manual?: boolean;
  expedited?: boolean;
  upload?: boolean;
  overrideTooManyDeletions?: boolean;
  discardLocalDeletions?: boolean;
}

// ─── The headless run ──────────────────────────────────

/** SYNC_EXTRAS_* flags of the request that started a run. */
export interface RunExtras {
  manual?: boolean;
  upload?: boolean;
  expedited?: boolean;
  ignoreBackoff?: boolean;
  overrideTooManyDeletions?: boolean;
  discardLocalDeletions?: boolean;
}

/** Data of the BulwarkDeviceSync headless task, as Kotlin sends it. */
export interface RunPayload {
  runId: string;
  accountName: string;
  registryId: string;
  authority: Authority;
  extras: RunExtras;
  /** Epoch ms after which Kotlin stops waiting; the run must have finished. */
  deadline: number;
}

export type RunOutcome =
  /** Everything was synced; per-item errors may still be listed. */
  | 'ok'
  /** Network or server trouble: the framework retries with back-off. */
  | 'io'
  /** Credentials rejected even after rebuilding the client: sign in again. */
  | 'auth'
  /** The runtime permission for the authority is missing. */
  | 'permission'
  /** The server does not offer the capability for this account. */
  | 'unsupported'
  /** Local deletions above the threshold; waiting for the user's decision. */
  | 'tooManyDeletions'
  /** A full reconcile found an empty server but a full device, and stopped. */
  | 'safetyAbort'
  /** Cancelled by the framework, or out of time with work left. */
  | 'cancelled'
  /** Sync is off for this account/authority in the app or in Android. */
  | 'disabled'
  /** An exception the engine did not expect. */
  | 'internal';

export interface SideCounts {
  created: number;
  updated: number;
  deleted: number;
}

export interface RunStats {
  /** Server → device: objects applied to rows. */
  downloaded: SideCounts;
  /** Device → server: objects created, patched, destroyed. */
  uploaded: SideCounts;
  /** Objects looked at. */
  entries: number;
  /** Objects left for later (poisoned, backed off, read-only reverts). */
  skipped: number;
}

export interface ItemError {
  /** `SOURCE_ID`/`_SYNC_ID` when known, else `row:<_id>`. */
  ref: string;
  side: 'upload' | 'download';
  /** SetError type (`invalidProperties`, …) or an engine error code. */
  type: string;
  description?: string;
  /** Epoch ms before which the item is not retried unless it changes. */
  retryAt?: number;
}

export interface RunReport {
  v: 1;
  runId: string;
  authority: Authority;
  outcome: RunOutcome;
  message?: string;
  startedAt: number;
  durationMs: number;
  stats: RunStats;
  /** Units where both sides changed differently; the server won each. */
  conflicts: number;
  itemErrors: ItemError[];
  /** Set with outcome `tooManyDeletions`. */
  tooManyDeletions?: { count: number; threshold: number };
  /** Epoch seconds: do not sync before (a 429's Retry-After). */
  delayUntil?: number;
  /** The run stopped at its time budget with work left; run again soon. */
  moreRecordsToGet?: boolean;
}

// ─── Native module (the raw bridge) ────────────────────

/**
 * `NativeModules.BulwarkDeviceSync`. Large payloads cross as JSON strings,
 * which the bridge moves far faster than nested maps. Every provider call is
 * scoped to `accountName` of our account type by the native side.
 */
export interface DeviceSyncNativeModule {
  getInfo(): Promise<{ accountType: string; sdkInt: number }>;

  listAccounts(): Promise<AndroidAccount[]>;
  /**
   * Adds the account if missing. Resolves true when it was created, false
   * when it exists for `registryId` already (one left without a registryId
   * is adopted); rejects with code `conflict` when it belongs to another
   * registry id, whose rows and SyncState it holds.
   */
  ensureAccount(name: string, registryId: string): Promise<boolean>;
  /** Removes the account; the providers drop its rows. */
  removeAccount(name: string): Promise<boolean>;

  getSyncSettings(name: string): Promise<AccountSyncSettings>;
  /** Syncable = 1 plus `setSyncAutomatically(enabled)` for the authority. */
  setSyncEnabled(name: string, authority: Authority, enabled: boolean): Promise<void>;
  /** Replaces our periodic sync; 0 removes it. */
  setPeriodicSync(name: string, authority: Authority, seconds: number): Promise<void>;
  requestSync(name: string, authority: Authority, optionsJson: string): Promise<void>;
  /** Opens the account's sync screen in Android Settings. */
  openAccountSettings(name: string): Promise<void>;

  /** Hands the report to the waiting adapter. Resolves false for an unknown or finished run. */
  finishRun(runId: string, reportJson: string): Promise<boolean>;
  isRunCancelled(runId: string): Promise<boolean>;
  /**
   * Routes for the native push router: `{ [jmapAccountId]: [{ accountName,
   * authorities }] }`, JSON. A push whose `changed` map names one of these
   * accounts with a contact or calendar type requests those syncs.
   */
  setPushRoutes(routesJson: string): Promise<void>;
  /**
   * Posts (or replaces) the account's one sync-problem notification; a tap
   * opens `uri`, which must be a `bulwarkmobile://` link. `channelName` names
   * the notification channel in the app's language; null keeps English.
   */
  showSyncProblem(accountName: string, title: string, text: string, uri: string, channelName: string | null): Promise<void>;
  clearSyncProblem(accountName: string): Promise<void>;

  // Provider I/O runs on one native thread, a call at a time. `query`,
  // `readSyncState` and `readPhoto` reject with code `scope`, `permission` or
  // `provider` (as `BatchFailure`).
  /** `ProviderQuery` JSON in, `ProviderRows` JSON out. */
  query(name: string, authority: Authority, queryJson: string): Promise<string>;
  /** `ProviderOp[]` JSON in, `BatchResult` JSON out (failures resolve, they do not reject). */
  applyBatch(name: string, authority: Authority, opsJson: string): Promise<string>;
  readSyncState(name: string, authority: Authority): Promise<string | null>;
  /** `PhotoData` JSON, or null when the raw contact has no photo. */
  readPhoto(name: string, rawContactId: number, maxPx: number): Promise<string | null>;

  // NativeEventEmitter bookkeeping.
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

// ─── The JMAP side ─────────────────────────────────────

/** A method call or response as on the wire: `[name, arguments, callId]`. */
export type JmapInvocation = [name: string, args: Record<string, unknown>, callId: string];

export interface JmapResponse {
  methodResponses: JmapInvocation[];
  sessionState?: string;
}

export interface JmapAccountView {
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
  accountCapabilities: Record<string, unknown>;
}

export interface JmapSessionView {
  username: string;
  accounts: Record<string, JmapAccountView>;
  primaryAccounts: Record<string, string>;
  capabilities: Record<string, unknown>;
}

/** The core capability's limits the engine sizes its requests by. */
export interface JmapCoreLimits {
  maxObjectsInGet: number;
  maxObjectsInSet: number;
  maxCallsInRequest: number;
  maxConcurrentRequests: number;
  maxSizeRequest: number;
}

/**
 * The engine's view of one registry account's JMAP server: a detached
 * JMAPClient on the device (src/device-sync/jmap/client-port.ts), the fake
 * server in tests. Transport failures throw an Error whose `name` is
 * `AuthenticationError`, `NetworkError`, `RequestTimeoutError` or
 * `RateLimitError` (with `retryAfterMs`), as jmap-client.ts does; after a
 * `NetworkError` or `RequestTimeoutError` the server may have applied the
 * request. Any other thrown Error (jmap-client.ts throws plain ones for a
 * non-OK HTTP status, e.g. `JMAP request failed: 503 - …`, and for a body that
 * is not JSON) means no usable response and counts as `io`; a 400 for a limit
 * is an engine bug. Method-level errors come back as
 * `['error', { type }, callId]` responses.
 */
export interface JmapPort {
  session(): JmapSessionView;
  /** The session's core limits, with the RFC 8620 fallbacks where the server gives none. */
  limits(): JmapCoreLimits;
  request(calls: JmapInvocation[], using: string[]): Promise<JmapResponse>;
  /** Bytes of a blob-backed `media` entry (other servers; Stalwart keeps photos as `data:` URIs). */
  downloadBlob(accountId: string, blobId: string, type?: string): Promise<Uint8Array>;
}

export const JMAP_CORE = 'urn:ietf:params:jmap:core';
export const JMAP_CONTACTS = 'urn:ietf:params:jmap:contacts';
export const JMAP_CALENDARS = 'urn:ietf:params:jmap:calendars';

// ─── App-side preferences the engine reads ─────────────

/** Collections are keyed `<jmapAccountId>/<collectionId>` everywhere. */
export type CollectionKey = string;

export type ReminderOwner = 'device' | 'bulwark';

/**
 * What the engine needs from the app's device-sync store for one registry
 * account. Selections list explicit choices only; a collection the user never
 * touched follows the default rule: collections of the personal account on,
 * shared ones off.
 */
export interface AccountSyncPrefs {
  contactsSelection: Record<CollectionKey, boolean>;
  calendarSelection: Record<CollectionKey, boolean>;
  /** Where contacts created on the device go; unset means the server's default book. */
  newContactsAddressBook?: CollectionKey;
  reminderOwner: ReminderOwner;
}

/** Last run per authority, as the settings UI shows it. */
export interface RunStatus {
  at: number;
  outcome: RunOutcome;
  message?: string;
  durationMs: number;
  conflicts: number;
  itemErrors: number;
  stats: RunStats;
}
