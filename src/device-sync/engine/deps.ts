/**
 * Everything the sync engine reaches outside itself. The engine is pure
 * TypeScript: src/device-sync/task.ts wires these to the native module, a
 * detached JMAPClient and the app's stores; the tests wire them to the fake
 * provider, the fake JMAP server and test planners.
 */
import type { CalendarPlanner, ContactsPlanner } from '../planner';
import type { RandomSource } from '../common/ids';
import type { AccountSyncPrefs, Authority, ProviderPort, RunStatus } from '../types';
import type { JmapConnection } from '../jmap/connection';

export type { JmapConnection };

/** A calendar that mirrors an iCal feed (read-only on the device). */
export interface SubscriptionCalendar {
  /** JMAP account of the mirror calendar; null for subscriptions saved before accounts were recorded (the primary). */
  jmapAccountId: string | null;
  calendarId: string;
}

export interface EngineDeps {
  /** The provider of one Android account and authority. */
  provider(accountName: string, authority: Authority): ProviderPort;
  /** A JMAP connection for the registry account (rebuilt once on an auth failure); throws the client's errors. */
  jmap(registryId: string): Promise<JmapConnection>;
  /** The account's device-sync preferences (the store is hydrated first). */
  prefs(registryId: string): Promise<AccountSyncPrefs>;
  planners: { contacts: ContactsPlanner; calendar: CalendarPlanner };
  /** Epoch milliseconds. */
  now(): number;
  /** Whether the framework cancelled the run, or nobody waits for it any more. */
  isCancelled(runId: string): Promise<boolean>;
  random: RandomSource;
  /** Feed-subscription calendars (read-only on the device). */
  subscriptionCalendars(): Promise<SubscriptionCalendar[]>;
  /** Android's `getSyncAutomatically` for the account and authority. */
  isSyncEnabled(accountName: string, authority: Authority): Promise<boolean>;
  /** The device's IANA time zone (floating events are written in it). */
  deviceZone(): string;
  /** The last run's status for the settings UI. */
  recordStatus(registryId: string, authority: Authority, status: RunStatus): void | Promise<void>;
  /** The status `recordStatus` stored last, if any (a run that did nothing keeps its details). */
  lastStatus(registryId: string, authority: Authority): RunStatus | undefined | Promise<RunStatus | undefined>;
  /** The latest state the engine synced for a JMAP account and type, so the app skips the echo of our own writes. */
  recordKnownState(registryId: string, jmapAccountId: string, type: string, state: string): void | Promise<void>;
  /** One notification that deep-links to sign-in, after an auth failure the rebuild did not fix. */
  notifyAuthProblem(registryId: string, accountName: string, authority: Authority): void | Promise<void>;
  /** Lets the JS thread render between chunks (default: `setTimeout(0)`). */
  yieldThread?(): Promise<void>;
  /** Waits before a retry, e.g. the uid lookup's back-off (default: `setTimeout`). */
  sleep?(ms: number): Promise<void>;
  log?(message: string, detail?: unknown): void;
  /** Overrides for tests. */
  tuning?: Partial<Tuning>;
}

/** Sizes and limits from docs/device-sync.md ("Limits and performance", "Deletion threshold"). */
export interface Tuning {
  /** Raw contacts or events planned per chunk. */
  chunkSize: number;
  /** Provider ops per applyBatch, with a yield point at every item group. */
  maxBatchOps: number;
  /** Bytes per applyBatch as `estimateBatchBytes` counts them (the Binder budget is 1 MB for the whole transaction). */
  maxBatchBytes: number;
  /** Re-reads and re-plans of an item whose group failed an assert. */
  maxReplans: number;
  /** Creates per `/set` (a create batch is not interruptible). */
  maxCreatesPerSet: number;
  /** Serialized bytes per `/set` call (Stalwart splits bigger calls into several commits). */
  maxSetBytes: number;
  /** `stateMismatch` retries of an account's upload. */
  maxStateMismatchRetries: number;
  /** Stop starting work this long before the deadline. */
  deadlineMarginMs: number;
  /** A create batch starts only with this much budget left (two request timeouts). */
  createBudgetMs: number;
  /** A `Core/echo` when a local phase has gone this long without a JMAP request. */
  echoAfterMs: number;
  /** Deletions above this count … */
  deletionThresholdCount: number;
  /** … and above this share of the authority's synced objects set `tooManyDeletions`. */
  deletionThresholdRatio: number;
  /** A full reconcile that finds nothing while the device holds more than this aborts. */
  safetyAbortRows: number;
  /** Back-off of a poisoned item: first delay, doubling up to the cap. */
  poisonBackoffMs: number;
  poisonBackoffMaxMs: number;
  /** Retries of a uid lookup after a duplicate-uid error, with these delays. */
  uidLookupDelaysMs: number[];
  /** Objects scanned to tell a task-only calendar. */
  taskScanLimit: number;
  /** Item errors kept in a report. */
  maxItemErrors: number;
}

export const DEFAULT_TUNING: Tuning = {
  chunkSize: 50,
  maxBatchOps: 400,
  maxBatchBytes: 500_000,
  maxReplans: 3,
  maxCreatesPerSet: 50,
  maxSetBytes: 1_000_000,
  maxStateMismatchRetries: 3,
  deadlineMarginMs: 30_000,
  createBudgetMs: 60_000,
  echoAfterMs: 40_000,
  deletionThresholdCount: 50,
  deletionThresholdRatio: 0.2,
  safetyAbortRows: 10,
  poisonBackoffMs: 60 * 60_000,
  poisonBackoffMaxMs: 24 * 60 * 60_000,
  uidLookupDelaysMs: [500, 1500, 4000],
  taskScanLimit: 50,
  maxItemErrors: 50,
};
