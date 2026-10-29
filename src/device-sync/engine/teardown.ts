/**
 * Turning device sync off for an authority, or signing out
 * (docs/device-sync.md, "App integration", Lifecycle): under the run lock,
 * the device's dirty, deleted and new items are uploaded first (bounded in
 * time, failures ignored), then every row of the authority and its SyncState
 * go. When changes are still waiting, nothing is deleted unless the user
 * confirmed losing them (`force`).
 */
import { CALENDAR_AUTHORITY, type Authority, type ProviderOp } from '../types';
import { BatchWriter } from './batch';
import type { EngineDeps } from './deps';
import { acquireLock, clearStopRequest, lockKey, requestStop } from './mutex';
import { ProviderReader, str } from './provider';
import { ReportBuilder } from './report';
import { createEnv, tuningOf, waitsForUpload } from './run';
import { parseSyncState } from './sync-state';

export interface TeardownOptions {
  /** Upload waiting changes first (default true). */
  uploadFirst?: boolean;
  /** Time for the upload (default 30 s). */
  timeoutMs?: number;
  /** Delete even when changes could not be uploaded (the user confirmed). */
  force?: boolean;
}

/** Items still waiting for an upload: dirty, deleted, new, and groups deleted by absence. */
export async function countPending(reader: ProviderReader, authority: Authority): Promise<number> {
  const { state } = parseSyncState(await reader.readSyncState());
  if (authority === CALENDAR_AUTHORITY) {
    const rows = await reader.rows(
      'events',
      ['_id', 'original_id', 'original_sync_id'],
      "dirty = 1 OR deleted = 1 OR _sync_id IS NULL OR _sync_id LIKE '~pending/%'",
    );
    const masters = new Set(rows.map((r) => str(r.original_id) ?? str(r.original_sync_id) ?? `row:${String(r._id)}`));
    return masters.size;
  }
  const contacts = await reader.rows('raw_contacts', ['_id', 'sourceid', 'deleted', 'sync3'], 'dirty = 1 OR deleted = 1 OR sourceid IS NULL');
  const groups = await reader.rows('groups', ['_id', 'sourceid', 'dirty', 'deleted', 'sync3']);
  const present = new Set(groups.map((g) => str(g.sourceid)).filter(Boolean));
  const waitingGroups = groups.filter((g) => (!str(g.sourceid) || Number(g.dirty) === 1 || Number(g.deleted) === 1) && waitsForUpload(g)).length;
  const absent = Object.values(state.accounts).reduce((n, a) => n + (a.groups ?? []).filter((ref) => !present.has(ref)).length, 0);
  return contacts.filter(waitsForUpload).length + waitingGroups + absent;
}

function deleteEverything(authority: Authority): ProviderOp[] {
  // Sync-adapter deletes: raw contacts take their data rows along, calendar rows their events.
  return authority === CALENDAR_AUTHORITY
    ? [{ op: 'delete', table: 'calendars' }]
    : [
        { op: 'delete', table: 'raw_contacts' },
        { op: 'delete', table: 'groups' },
        { op: 'delete', table: 'settings' },
      ];
}

export async function teardownAuthority(
  deps: EngineDeps,
  registryId: string,
  accountName: string,
  authority: Authority,
  options: TeardownOptions = {},
): Promise<{ pending: number }> {
  const tuning = tuningOf(deps);
  const key = lockKey(registryId, authority);
  // A sync holding the lock stops at its next checkpoint instead of running to its deadline.
  requestStop(key);
  const release = await acquireLock(key);
  clearStopRequest(key);
  try {
    const reader = new ProviderReader(deps.provider(accountName, authority));
    if (options.uploadFirst !== false) {
      const started = deps.now();
      try {
        const { state: stored, readable } = parseSyncState(await reader.readSyncState());
        // Rows written for another registry account are never uploaded to this one.
        if (!stored.owner || stored.owner.registryId === registryId) {
          const connection = await deps.jmap(registryId);
          if (!stored.owner || stored.owner.origin === connection.origin) {
            const report = new ReportBuilder('teardown', authority, started, tuning.maxItemErrors);
            const { sync } = await createEnv({
              // Started from the UI: JS timers stop while the app is in the background and no headless task
              // runs, so the teardown's own waits (checkpoint yields, retry back-offs) must not need one.
              deps: { ...deps, yieldThread: deps.yieldThread ?? (async () => undefined), sleep: deps.sleep ?? (async () => undefined) },
              tuning: { ...tuning, deadlineMarginMs: 0, createBudgetMs: 0 },
              mode: 'teardown',
              registryId,
              accountName,
              authority,
              extras: {},
              deadline: started + (options.timeoutMs ?? 30_000),
              isCancelled: async () => false,
              reader,
              report,
              stored: readable ? stored : parseSyncState(null).state,
              connection,
            });
            await sync.uploadOnly();
          }
        }
      } catch (error) {
        // Offline, signed out, out of time: whatever did not go up is counted below.
        deps.log?.('upload before teardown stopped', error);
      }
    }
    const pending = await countPending(reader, authority);
    if (pending > 0 && !options.force) return { pending };
    const writer = new BatchWriter(reader.port, {
      maxOps: tuning.maxBatchOps,
      maxBytes: tuning.maxBatchBytes,
      maxReplans: 0,
    });
    await writer.write(
      [
        {
          group: { ref: 'teardown', ops: deleteEverything(authority) },
          failed: (reason, message) => {
            throw new Error(`Could not remove the synced rows: ${reason} ${message}`);
          },
        },
      ],
      { op: () => ({ op: 'syncState', value: '' }), applied: () => undefined },
    );
    return { pending: 0 };
  } finally {
    release?.();
  }
}
