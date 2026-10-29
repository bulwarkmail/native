/**
 * Typed wrapper around `NativeModules.BulwarkDeviceSync` (#34): the one module
 * of device sync that talks to React Native's bridge. The raw contract is
 * `DeviceSyncNativeModule` in ./types; docs/device-sync.md ("Native module
 * API") explains it.
 *
 * The native module is looked up on every call and never cached, so a dev
 * reload or an APK built before device sync never leaves a stale reference.
 * Everything except `getDeviceSyncModule` and `isDeviceSyncAvailable`
 * rejects when the module is missing (iOS, or an old APK), and
 * `onAccountsChanged` then returns an unsubscribe that does nothing.
 *
 * Provider data crosses the bridge as JSON strings; replies are checked here,
 * so a malformed one fails loudly instead of reaching the engine.
 */
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import {
  ACCOUNTS_CHANGED_EVENT,
  CONTACTS_AUTHORITY,
  type AccountSyncSettings,
  type AndroidAccount,
  type Authority,
  type BatchFailure,
  type BatchResult,
  type Cell,
  type DeviceSyncNativeModule,
  type OpResult,
  type PhotoData,
  type ProviderPort,
  type ProviderRows,
  type RequestSyncOptions,
  type RunReport,
} from './types';

export function getDeviceSyncModule(): DeviceSyncNativeModule | null {
  if (Platform.OS !== 'android') return null;
  return (
    ((NativeModules as Record<string, unknown>).BulwarkDeviceSync as DeviceSyncNativeModule | undefined) ?? null
  );
}

/** Android with a build that carries the native module. */
export function isDeviceSyncAvailable(): boolean {
  return getDeviceSyncModule() !== null;
}

function requireModule(): DeviceSyncNativeModule {
  const module = getDeviceSyncModule();
  if (!module) {
    throw Object.assign(new Error('Device sync is not available in this build'), { code: 'unavailable' });
  }
  return module;
}

// ─── Provider ──────────────────────────────────────────

/** The provider bound to one Android account of our type and one authority. */
export function createProviderPort(accountName: string, authority: Authority): ProviderPort {
  return {
    accountName,
    authority,
    async query(q) {
      const json = await requireModule().query(accountName, authority, JSON.stringify(q));
      return toRows(parseReply(json, 'query'));
    },
    async applyBatch(ops) {
      const json = await requireModule().applyBatch(accountName, authority, JSON.stringify(ops));
      const result = toBatchResult(parseReply(json, 'applyBatch'));
      if (result.ok && result.results.length !== ops.length) {
        throw malformed('applyBatch', `${result.results.length} results for ${ops.length} ops`);
      }
      return result;
    },
    async readSyncState() {
      const state: unknown = await requireModule().readSyncState(accountName, authority);
      if (state === null || state === undefined) return null;
      if (typeof state !== 'string') throw malformed('readSyncState', 'not text');
      return state;
    },
    async readPhoto(rawContactId, maxPx) {
      if (authority !== CONTACTS_AUTHORITY) throw new Error('readPhoto reads contacts: this port is for calendars');
      const json: unknown = await requireModule().readPhoto(accountName, rawContactId, maxPx);
      return json === null || json === undefined ? null : toPhoto(parseReply(json, 'readPhoto'));
    },
  };
}

function malformed(method: string, detail: string): Error {
  return new Error(`BulwarkDeviceSync.${method} replied with malformed data: ${detail}`);
}

function parseReply(json: unknown, method: string): unknown {
  if (typeof json !== 'string') throw malformed(method, `a ${typeof json}, not JSON text`);
  try {
    return JSON.parse(json);
  } catch (e) {
    throw malformed(method, (e as Error).message);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCell = (v: unknown): v is Cell => v === null || typeof v === 'string' || typeof v === 'number';
const isOptionalNumber = (v: unknown) => v === undefined || typeof v === 'number';

function toRows(value: unknown): ProviderRows {
  if (!isObject(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows)) {
    throw malformed('query', 'no columns and rows');
  }
  const { columns, rows } = value;
  if (!columns.every((c) => typeof c === 'string')) throw malformed('query', 'a column name is not text');
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== columns.length || !row.every(isCell)) {
      throw malformed('query', 'a row does not match its columns');
    }
  }
  return { columns: columns as string[], rows: rows as Cell[][] };
}

const BATCH_FAILURES: readonly BatchFailure[] = ['assert', 'tooLarge', 'scope', 'permission', 'provider'];

function toBatchResult(value: unknown): BatchResult {
  if (isObject(value) && value.ok === true && Array.isArray(value.results)) {
    const results: OpResult[] = value.results.map((r) => {
      if (!isObject(r) || !isOptionalNumber(r.id) || !isOptionalNumber(r.count)) {
        throw malformed('applyBatch', 'an op result is not { id?, count? }');
      }
      return r as OpResult;
    });
    return { ok: true, results };
  }
  if (
    isObject(value) &&
    value.ok === false &&
    BATCH_FAILURES.includes(value.reason as BatchFailure) &&
    typeof value.message === 'string'
  ) {
    return { ok: false, reason: value.reason as BatchFailure, message: value.message };
  }
  throw malformed('applyBatch', 'not a BatchResult');
}

function toPhoto(value: unknown): PhotoData {
  if (
    !isObject(value) ||
    typeof value.jpegBase64 !== 'string' ||
    !(value.fileId === null || typeof value.fileId === 'number')
  ) {
    throw malformed('readPhoto', 'not { jpegBase64, fileId }');
  }
  return { jpegBase64: value.jpegBase64, fileId: value.fileId };
}

// ─── Accounts and sync settings ────────────────────────

export async function listAndroidAccounts(): Promise<AndroidAccount[]> {
  return requireModule().listAccounts();
}

/**
 * Adds the Android account for an app account. Resolves true when it was
 * created, false when it exists for this registry id already; rejects with
 * code `conflict` when an account of that name belongs to another one.
 */
export async function ensureAndroidAccount(name: string, registryId: string): Promise<boolean> {
  return requireModule().ensureAccount(name, registryId);
}

/** Removes the Android account; the providers drop all of its rows. */
export async function removeAndroidAccount(name: string): Promise<boolean> {
  return requireModule().removeAccount(name);
}

export async function getSyncSettings(name: string): Promise<AccountSyncSettings> {
  return requireModule().getSyncSettings(name);
}

export async function setSyncEnabled(name: string, authority: Authority, enabled: boolean): Promise<void> {
  await requireModule().setSyncEnabled(name, authority, enabled);
}

/** Replaces the periodic sync; 0 removes it. Android raises anything shorter than 15 minutes to that. */
export async function setPeriodicSync(name: string, authority: Authority, seconds: number): Promise<void> {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError(`Invalid sync interval: ${seconds}`);
  await requireModule().setPeriodicSync(name, authority, Math.round(seconds));
}

/**
 * Asks SyncManager for a sync. Repeated requests with the same options
 * coalesce; one that arrives while the same sync runs makes that run ask for
 * another one when it ends.
 */
export async function requestSync(name: string, authority: Authority, options: RequestSyncOptions = {}): Promise<void> {
  await requireModule().requestSync(name, authority, JSON.stringify(options));
}

/** The account's sync screen in Android Settings (or the list of synced accounts). */
export async function openAccountSettings(name: string): Promise<void> {
  await requireModule().openAccountSettings(name);
}

// ─── The run handshake ─────────────────────────────────

/** Hands the report to the waiting adapter; false when the run already ended (deadline, cancel) or is unknown. */
export async function finishRun(runId: string, report: RunReport): Promise<boolean> {
  return requireModule().finishRun(runId, JSON.stringify(report));
}

/** True once the adapter stopped waiting for the run (cancelled, out of time, or unknown). */
export async function isRunCancelled(runId: string): Promise<boolean> {
  return requireModule().isRunCancelled(runId);
}

// ─── Push routes and notifications ─────────────────────

/**
 * Tells the native push router which Android accounts each JMAP account feeds,
 * so a pushed contact or calendar change requests their syncs without JS.
 * Replaces the previous routes.
 */
export async function setPushRoutes(
  routes: Record<string, Array<{ accountName: string; authorities: Authority[] }>>,
): Promise<void> {
  await requireModule().setPushRoutes(JSON.stringify(routes));
}

/**
 * Posts (or replaces) the account's "sync problem" notification; tapping it
 * opens `uri`, a `bulwarkmobile://` deep link. `channelName` names the
 * notification channel in the app's language (English when omitted).
 */
export async function showSyncProblem(
  accountName: string,
  title: string,
  text: string,
  uri: string,
  channelName?: string,
): Promise<void> {
  await requireModule().showSyncProblem(accountName, title, text, uri, channelName ?? null);
}

export async function clearSyncProblem(accountName: string): Promise<void> {
  await requireModule().clearSyncProblem(accountName);
}

/**
 * Calls `listener` when an account of our type is added or removed (also in
 * Android Settings). A hint only: events without a JS listener are dropped,
 * so re-read the accounts on mount and on foreground too.
 */
export function onAccountsChanged(listener: () => void): () => void {
  const module = getDeviceSyncModule();
  if (!module) return () => undefined;
  const subscription = new NativeEventEmitter(module).addListener(ACCOUNTS_CHANGED_EVENT, () => listener());
  return () => subscription.remove();
}
