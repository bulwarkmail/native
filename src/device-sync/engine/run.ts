/**
 * One sync run of one Android account and authority (docs/device-sync.md,
 * "A sync run"): preflight, then the authority's phases, then the report.
 * Never throws: every failure becomes an outcome.
 */
import { makeKeyMinter, uuidFrom } from '../common/ids';
import { JmapCaller } from '../jmap/caller';
import type { JmapConnection } from '../jmap/connection';
import { accountsWithCapability } from '../jmap/session';
import {
  CALENDAR_AUTHORITY,
  CONTACTS_AUTHORITY,
  JMAP_CALENDARS,
  JMAP_CONTACTS,
  type Authority,
  type RunExtras,
  type RunPayload,
  type RunReport,
  type RunStatus,
  type Row,
} from '../types';
import { BatchWriter } from './batch';
import { CalendarSync } from './calendar-sync';
import { Checkpoints } from './checkpoint';
import { ContactsSync } from './contacts-sync';
import type { RunEnv } from './context';
import { DEFAULT_TUNING, type EngineDeps, type Tuning } from './deps';
import { classifyFailure, RunAbort } from './errors';
import { acquireLock, lockKey, stopRequested } from './mutex';
import { flag, ProviderReader, str } from './provider';
import { isQuietRun, ReportBuilder, statusOf, statusToRecord } from './report';
import { emptySyncState, parseSyncState, StateStore, type SyncState } from './sync-state';
import type { ItemSync } from './item-sync';

export function tuningOf(deps: EngineDeps): Tuning {
  return { ...DEFAULT_TUNING, ...deps.tuning };
}

const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function capabilityOf(authority: Authority): string {
  return authority === CONTACTS_AUTHORITY ? JMAP_CONTACTS : JMAP_CALENDARS;
}

function itemTypeOf(authority: Authority): string {
  return authority === CONTACTS_AUTHORITY ? 'ContactCard' : 'CalendarEvent';
}

/**
 * Whether a dirty, deleted or new raw contact or group has anything to
 * upload. One created and deleted on the device before a run claimed it (no
 * identity, no pending create) never reached the server: a run purges it.
 */
export function waitsForUpload(row: Row): boolean {
  return !!str(row.sourceid) || !!str(row.sync3) || !flag(row.deleted);
}

/** Rows waiting for an upload (dirty, deleted, new), or state work a run must do whatever its extras. */
export async function hasLocalWork(reader: ProviderReader, authority: Authority, state: SyncState): Promise<boolean> {
  for (const account of Object.values(state.accounts)) {
    if (account.reconcile || account.stale.length || account.created?.length) return true;
  }
  if (authority === CALENDAR_AUTHORITY) {
    const rows = await reader.rows('events', ['_id'], "dirty = 1 OR deleted = 1 OR _sync_id IS NULL OR _sync_id LIKE '~pending/%'");
    return rows.length > 0;
  }
  const contacts = await reader.rows('raw_contacts', ['_id', 'sourceid', 'deleted', 'sync3'], 'dirty = 1 OR deleted = 1 OR sourceid IS NULL');
  if (contacts.some(waitsForUpload)) return true;
  const groups = await reader.rows('groups', ['_id', 'sourceid', 'dirty', 'deleted', 'sync3']);
  const present = new Set(groups.map((g) => str(g.sourceid)).filter(Boolean));
  if (groups.some((g) => (!str(g.sourceid) || Number(g.dirty) === 1 || Number(g.deleted) === 1) && waitsForUpload(g))) return true;
  // A group an app hard-deleted is only found by its absence.
  return Object.values(state.accounts).some((a) => (a.groups ?? []).some((ref) => !present.has(ref)));
}

export interface EnvOptions {
  deps: EngineDeps;
  tuning: Tuning;
  mode: 'sync' | 'teardown';
  registryId: string;
  accountName: string;
  authority: Authority;
  extras: RunExtras;
  deadline: number;
  isCancelled(): Promise<boolean>;
  reader: ProviderReader;
  report: ReportBuilder;
  stored: SyncState;
  connection: JmapConnection;
}

/**
 * The run's environment once the preflight passed: the JMAP connection is
 * open and its accounts known. Throws RunAbort('unsupported') when no
 * account offers the authority's capability.
 */
export async function createEnv(options: EnvOptions): Promise<{ env: RunEnv; sync: ItemSync }> {
  const { deps, tuning, registryId, authority, connection } = options;
  const jmap = new JmapCaller(connection.port, () => deps.now());
  const accounts = accountsWithCapability(jmap.session(), capabilityOf(authority));
  if (!accounts.length) {
    throw new RunAbort('unsupported', `The server offers no ${authority === CONTACTS_AUTHORITY ? 'contacts' : 'calendars'} for this account`);
  }
  const prefs = await deps.prefs(registryId);
  const recordKnownState = (jmapAccountId: string, type: string, state: string) => {
    try {
      void Promise.resolve(deps.recordKnownState(registryId, jmapAccountId, type, state)).catch(() => undefined);
    } catch {
      // Only an echo hint for the app.
    }
  };
  const store = new StateStore(options.stored, { registryId, origin: connection.origin }, (before, after) => {
    for (const [acct, account] of Object.entries(after.accounts)) {
      const state = account.itemsState;
      if (state && state !== before.accounts[acct]?.itemsState) recordKnownState(acct, itemTypeOf(authority), state);
    }
  });
  const checkpoints = new Checkpoints({
    now: () => deps.now(),
    deadline: options.deadline,
    marginMs: tuning.deadlineMarginMs,
    echoAfterMs: tuning.echoAfterMs,
    isCancelled: options.isCancelled,
    yieldThread: deps.yieldThread ?? defaultYield,
  });
  checkpoints.attach(jmap);
  const mintKey = makeKeyMinter(deps.random);
  const env: RunEnv = {
    deps,
    tuning,
    mode: options.mode,
    registryId,
    accountName: options.accountName,
    authority,
    extras: options.extras,
    reader: options.reader,
    writer: new BatchWriter(
      options.reader.port,
      { maxOps: tuning.maxBatchOps, maxBytes: tuning.maxBatchBytes, maxReplans: tuning.maxReplans },
      store,
    ),
    report: options.report,
    checkpoints,
    store,
    jmap,
    accounts,
    prefs,
    now: () => deps.now(),
    mintKey: (taken) => mintKey(taken),
    mintUid: () => uuidFrom(deps.random),
    sleep: deps.sleep ?? defaultSleep,
    log: (message, detail) => deps.log?.(message, detail),
    recordKnownState,
  };
  const sync = authority === CONTACTS_AUTHORITY ? new ContactsSync(env) : new CalendarSync(env);
  return { env, sync };
}

/**
 * Runs one sync and returns its report. Holds the (registry account,
 * authority) lock for the whole run; a run that cannot get it before its
 * deadline reports `cancelled` and asks for another sync.
 */
export async function runDeviceSync(payload: RunPayload, deps: EngineDeps): Promise<RunReport> {
  const tuning = tuningOf(deps);
  const report = new ReportBuilder(payload.runId, payload.authority, deps.now(), tuning.maxItemErrors);
  const key = lockKey(payload.registryId, payload.authority);
  const release = await acquireLock(key, Math.max(0, payload.deadline - deps.now() - tuning.deadlineMarginMs));
  if (!release) {
    const result = report.build('cancelled', deps.now(), { message: 'Another sync of this account is still running', moreRecordsToGet: true });
    await recordStatus(payload, deps, statusOf(result, report.itemErrorCount));
    return result;
  }
  try {
    const result = await runLocked(payload, deps, tuning, report, key);
    // Still under the lock: no other run of the account and authority records between the read and the write.
    await recordStatus(payload, deps, statusOf(result, report.itemErrorCount));
    return result;
  } finally {
    release();
  }
}

/**
 * Stores the status the settings show. A run that did nothing (the upload
 * sync Android starts after a manual one, the follow-up of a run during which
 * changes arrived) keeps the details of the run before it (`statusToRecord`).
 */
async function recordStatus(payload: RunPayload, deps: EngineDeps, status: RunStatus): Promise<void> {
  try {
    const previous = isQuietRun(status) ? await deps.lastStatus(payload.registryId, payload.authority) : undefined;
    await deps.recordStatus(payload.registryId, payload.authority, statusToRecord(status, previous));
  } catch (error) {
    deps.log?.('recording the run status failed', error);
  }
}

async function runLocked(payload: RunPayload, deps: EngineDeps, tuning: Tuning, report: ReportBuilder, key: string): Promise<RunReport> {
  const finish = (outcome: RunReport['outcome'], extra: Parameters<ReportBuilder['build']>[2] = {}) =>
    report.build(outcome, deps.now(), extra);
  const extras = payload.extras ?? {};
  try {
    if (!(await deps.isSyncEnabled(payload.accountName, payload.authority))) {
      return finish('disabled', { message: 'Sync is off for this account' });
    }
    const reader = new ProviderReader(deps.provider(payload.accountName, payload.authority));
    const { state: stored, readable } = parseSyncState(await reader.readSyncState());
    if (!readable) deps.log?.('unreadable SyncState: starting over with a full reconcile');
    if (stored.owner && stored.owner.registryId !== payload.registryId) {
      return finish('internal', { message: 'The rows on this device were written for another account' });
    }
    // Providers schedule an upload sync for every account 30 s after any app write.
    if (extras.upload && !(await hasLocalWork(reader, payload.authority, stored))) return finish('ok');

    const connection = await deps.jmap(payload.registryId);
    if (stored.owner && stored.owner.origin !== connection.origin) {
      return finish('internal', { message: 'The rows on this device were written for another server' });
    }
    const { sync } = await createEnv({
      deps,
      tuning,
      mode: 'sync',
      registryId: payload.registryId,
      accountName: payload.accountName,
      authority: payload.authority,
      extras,
      deadline: payload.deadline,
      isCancelled: async () => stopRequested(key) || (await deps.isCancelled(payload.runId)),
      reader,
      report,
      stored: readable ? stored : emptySyncState(),
      connection,
    });
    await sync.sync();
    return finish(report.tooManyDeletions ? 'tooManyDeletions' : 'ok');
  } catch (error) {
    const failure = classifyFailure(error, deps.now());
    if (failure.authProblem) {
      try {
        await deps.notifyAuthProblem(payload.registryId, payload.accountName, payload.authority);
      } catch (notifyError) {
        deps.log?.('auth notification failed', notifyError);
      }
    }
    if (failure.outcome === 'internal') deps.log?.('device sync failed', error);
    return finish(failure.outcome, {
      message: failure.message,
      delayUntil: failure.delayUntil,
      moreRecordsToGet: failure.moreRecordsToGet,
      noProgress: failure.noProgress,
    });
  }
}
