/**
 * The device sync engine (docs/device-sync.md). Pure TypeScript: every
 * dependency comes in through `EngineDeps`; src/device-sync/task.ts wires
 * the real ones.
 */
export { runDeviceSync, hasLocalWork } from './run';
export { teardownAuthority, countPending, type TeardownOptions } from './teardown';
export { DEFAULT_TUNING, type EngineDeps, type JmapConnection, type SubscriptionCalendar, type Tuning } from './deps';
export { parseSyncState, serializeSyncState, type SyncState, type AccountState } from './sync-state';
export { lockKey, isLocked } from './mutex';
