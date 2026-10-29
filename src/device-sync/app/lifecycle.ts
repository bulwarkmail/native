/**
 * Turning device sync on and off, signing out, and keeping Android's accounts
 * in step with the app's account registry (docs/device-sync.md, "Lifecycle").
 *
 * - Enable: permissions (asked by the settings first) → the Android account
 *   → automatic sync on → the periodic sync → a manual sync → push routes and
 *   push types.
 * - Disable an authority: automatic sync off, then the engine's teardown
 *   uploads what the device changed and deletes the authority's rows. When
 *   changes could not be uploaded nothing is deleted and the caller asks the
 *   user; only a confirmed turn-off deletes them. With both authorities off
 *   the Android account goes.
 * - Sign-out: the same for every authority, before the credentials go.
 * - Reconcile (launch, foreground, accounts changed): an Android account whose
 *   app account the registry dropped is suspended (sync off, one notification,
 *   data kept); an app account whose Android account was removed in Android
 *   Settings shows sync off and is never recreated on its own.
 *
 * The engine (`../task`) is imported on first use only, so starting the app
 * does not load it.
 */
import {
  clearSyncProblem,
  ensureAndroidAccount,
  getSyncSettings,
  listAndroidAccounts,
  openAccountSettings,
  removeAndroidAccount,
  requestSync,
  setPeriodicSync,
  setPushRoutes,
  setSyncEnabled,
  showSyncProblem,
} from '../native';
import {
  AUTHORITIES,
  CALENDAR_AUTHORITY,
  type AndroidAccount,
  type Authority,
  type ReminderOwner,
} from '../types';
import { useAccountStore } from '../../stores/account-store';
import {
  accountDeviceSync,
  anySyncOnInApp,
  computePushRoutes,
  intervalFor,
  syncOnInApp,
  useDeviceSyncStore,
  waitForDeviceSyncHydration,
  type AccountDeviceSync,
} from '../../stores/device-sync-store';
import { t } from '../../stores/locale-store';
import { toast } from '../../stores/toast-store';
import { refreshPushSubscriptionTypes } from '../../lib/push-notifications';
import { deviceSyncAvailable } from './available';
import { confirmSignOutLosingChanges } from './confirm';
import { hasSyncPermissions } from './permissions';
import { STATE_TYPES_BY_AUTHORITY } from './prefs';
import { cancelDeviceSyncRequests } from './request';

/** How long the teardown may spend uploading before it gives up (and asks). */
export const TEARDOWN_TIMEOUT_MS = 30_000;

/** After the user agreed to lose what is waiting: one short last try to upload it. */
export const FORCED_TEARDOWN_TIMEOUT_MS = 5_000;

/** Where the "sign in again" notification of a suspended account leads: the accounts pane. */
export const SIGN_IN_AGAIN_URI = 'bulwarkmobile://settings/account';

const REGISTRY_HYDRATION_TIMEOUT_MS = 5000;

const noop = () => undefined;

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

/** The registry, once read; null when it could not be read in time. */
async function readRegistry(): Promise<ReturnType<typeof useAccountStore.getState>['accounts'] | null> {
  const persist = useAccountStore.persist;
  if (!persist.hasHydrated()) {
    const hydrated = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe();
        resolve(false);
      }, REGISTRY_HYDRATION_TIMEOUT_MS);
      const unsubscribe = persist.onFinishHydration(() => {
        clearTimeout(timer);
        unsubscribe();
        resolve(true);
      });
    });
    if (!hydrated) return null;
  }
  return useAccountStore.getState().accounts;
}

// ─── Android account names ─────────────────────────────

/**
 * The Android account name for an app account: its login, or its registry id
 * when another app account's Android account already has that name (the same
 * login on two servers).
 */
export function preferredAndroidAccountName(registryId: string, androidAccounts: readonly AndroidAccount[]): string {
  const login = useAccountStore.getState().getAccountById(registryId)?.username?.trim();
  if (!login) return registryId;
  const takenOnDevice = androidAccounts.some((a) => a.name === login && a.registryId !== registryId);
  const takenInApp = Object.entries(useDeviceSyncStore.getState().accounts)
    .some(([id, entry]) => id !== registryId && entry.androidAccountName === login);
  return takenOnDevice || takenInApp ? registryId : login;
}

/** Creates the app account's Android account if needed; resolves its name. */
async function ensureAccountFor(registryId: string): Promise<string> {
  const androidAccounts = await listAndroidAccounts();
  const own = androidAccounts.find((a) => a.registryId === registryId);
  if (own) return own.name;
  const name = preferredAndroidAccountName(registryId, androidAccounts);
  try {
    await ensureAndroidAccount(name, registryId);
    return name;
  } catch (err) {
    // The name belongs to another app account after all (the list was stale). Any
    // other failure fails the turn-on: a second account would show in the apps.
    if (name === registryId || (err as { code?: unknown } | null)?.code !== 'conflict') throw err;
    await ensureAndroidAccount(registryId, registryId);
    return registryId;
  }
}

async function androidAccountOf(registryId: string): Promise<AndroidAccount | null> {
  try {
    return (await listAndroidAccounts()).find((a) => a.registryId === registryId) ?? null;
  } catch {
    return null;
  }
}

// ─── Push ──────────────────────────────────────────────

let lastRoutesJson: string | null = null;

/** Hands the native push router the JMAP accounts that feed each Android account. */
export async function refreshPushRoutes(): Promise<void> {
  if (!deviceSyncAvailable()) return;
  await waitForDeviceSyncHydration();
  const routes = computePushRoutes(useDeviceSyncStore.getState().accounts);
  const json = JSON.stringify(routes);
  if (json === lastRoutesJson) return;
  try {
    await setPushRoutes(routes);
    lastRoutesJson = json;
  } catch {
    // Kept for the next refresh.
  }
}

/** Push routes plus the account's push subscription types, after a toggle changed. */
async function refreshPushState(registryId: string): Promise<void> {
  await refreshPushRoutes();
  await refreshPushSubscriptionTypes(registryId).catch(noop);
}

// ─── One step at a time ────────────────────────────────

// Turning sync on and off for one app account runs one step after the other:
// a turn-on that starts while a turn-off still tears down (the user left the
// settings and came back) would otherwise be undone by it, down to the
// Android account being removed right after it was turned on again.
const accountSteps = new Map<string, Promise<unknown>>();

function oneAtATime<T>(registryId: string, step: () => Promise<T>): Promise<T> {
  const next = (accountSteps.get(registryId) ?? Promise.resolve()).catch(noop).then(step);
  const settled = next.catch(noop);
  accountSteps.set(registryId, settled);
  void settled.then(() => {
    if (accountSteps.get(registryId) === settled) accountSteps.delete(registryId);
  });
  return next;
}

/** One step in the queue of every one of the accounts, taken in a fixed order so two such steps never wait for each other. */
function oneAtATimeForAll<T>(registryIds: readonly string[], step: () => Promise<T>): Promise<T> {
  const [first, ...rest] = registryIds;
  return first === undefined ? step() : oneAtATime(first, () => oneAtATimeForAll(rest, step));
}

// Sign-outs under way, per app account: true once they released it.
const signOuts = new Map<string, Promise<boolean>>();

/**
 * A turn-on or turn-off of one app account, in its queue. One asked for
 * while the account signs out runs after the sign-out, and does nothing
 * (`released`) when that released the account.
 */
function accountStep<T>(registryId: string, step: () => Promise<T>, released: T): Promise<T> {
  const signOut = signOuts.get(registryId);
  return oneAtATime(registryId, async () => ((await signOut) ? released : step()));
}

// ─── Enable ────────────────────────────────────────────

export type EnableOutcome =
  | { kind: 'enabled'; accountName: string }
  /** The runtime permissions are missing: the caller asks for them first. */
  | { kind: 'permission' }
  | { kind: 'failed'; message: string };

/**
 * Turns device sync on for one authority of an app account. The caller has
 * asked for the permissions (and, for calendars, who reminds the user).
 */
export function enableDeviceSync(registryId: string, authority: Authority): Promise<EnableOutcome> {
  return accountStep(registryId, () => enable(registryId, authority), { kind: 'failed', message: 'The account was signed out' });
}

async function enable(registryId: string, authority: Authority): Promise<EnableOutcome> {
  if (!deviceSyncAvailable()) return { kind: 'failed', message: 'Device sync is not available' };
  if (!(await hasSyncPermissions(authority))) return { kind: 'permission' };
  await waitForDeviceSyncHydration();
  let accountName: string | null = null;
  try {
    accountName = await ensureAccountFor(registryId);
    useDeviceSyncStore.getState().update(registryId, {
      androidAccountName: accountName,
      removedInAndroidSettings: undefined,
      suspended: undefined,
    });
    await setSyncEnabled(accountName, authority, true);
    await setPeriodicSync(accountName, authority, intervalFor(accountDeviceSync(registryId), authority));
    const entry = accountDeviceSync(registryId);
    useDeviceSyncStore.getState().update(registryId, { enabled: { ...entry.enabled, [authority]: true } });
    await requestSync(accountName, authority, { manual: true }).catch(noop);
    void refreshPushState(registryId);
    return { kind: 'enabled', accountName };
  } catch (err) {
    if (accountName) {
      await setSyncEnabled(accountName, authority, false).catch(noop);
      // Don't leave an account behind that syncs nothing.
      if (!anySyncOnInApp(accountDeviceSync(registryId))) {
        useDeviceSyncStore.getState().update(registryId, { androidAccountName: undefined });
        await removeAndroidAccount(accountName).catch(noop);
      }
    }
    return { kind: 'failed', message: errorMessage(err) };
  }
}

/** Automatic sync back on after the user kept syncing instead of losing changes. */
export function resumeDeviceSync(registryId: string, authority: Authority): Promise<void> {
  return accountStep(registryId, () => resume(registryId, authority), undefined);
}

async function resume(registryId: string, authority: Authority): Promise<void> {
  if (!deviceSyncAvailable()) return;
  await waitForDeviceSyncHydration();
  const accountName = accountDeviceSync(registryId).androidAccountName ?? (await androidAccountOf(registryId))?.name;
  if (!accountName) return;
  await setSyncEnabled(accountName, authority, true).catch(noop);
  await requestSync(accountName, authority, { manual: true }).catch(noop);
}

// ─── Disable ───────────────────────────────────────────

export interface TurnOffResult {
  /** Rows deleted and the authority off in the app. */
  done: boolean;
  /** Device changes that could not be uploaded (nothing was deleted). */
  pending: number;
  /** The teardown itself failed: whether changes are waiting is unknown. */
  failed?: boolean;
}

interface TeardownResult {
  pending: number;
  failed: boolean;
}

// The engine, loaded once on first use (sign-outs tear several accounts down
// at the same time).
let engine: Promise<typeof import('../task')> | null = null;

function loadEngine(): Promise<typeof import('../task')> {
  engine ??= import('../task').catch((err: unknown) => {
    engine = null;
    throw err;
  });
  return engine;
}

async function teardown(
  registryId: string,
  accountName: string,
  authority: Authority,
  force: boolean,
): Promise<TeardownResult> {
  try {
    const { teardownAuthority } = await loadEngine();
    const result = await teardownAuthority(
      registryId,
      accountName,
      authority,
      force
        ? { force: true, timeoutMs: FORCED_TEARDOWN_TIMEOUT_MS }
        : { uploadFirst: true, timeoutMs: TEARDOWN_TIMEOUT_MS },
    );
    return { pending: Math.max(0, result?.pending ?? 0), failed: false };
  } catch (err) {
    console.warn('[device-sync] teardown failed', errorMessage(err));
    return { pending: 0, failed: true };
  }
}

/** The authority's JMAP states, dropped with its rows so no old state passes for an echo. */
function withoutAuthorityStates(entry: AccountDeviceSync, authority: Authority): AccountDeviceSync['knownStates'] {
  if (!entry.knownStates) return undefined;
  const types = STATE_TYPES_BY_AUTHORITY[authority];
  const out: Record<string, Record<string, string>> = {};
  for (const [jmapAccountId, states] of Object.entries(entry.knownStates)) {
    const kept = Object.fromEntries(Object.entries(states ?? {}).filter(([type]) => !types.includes(type)));
    if (Object.keys(kept).length > 0) out[jmapAccountId] = kept;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Turns device sync off for one authority. Uploads what the device changed
 * first; when that is not possible, nothing is deleted and the result says
 * how many changes are waiting: call again with `force` once the user agreed
 * to lose them, or `resumeDeviceSync` to keep syncing.
 */
export function disableDeviceSync(
  registryId: string,
  authority: Authority,
  options: { force?: boolean } = {},
): Promise<TurnOffResult> {
  // Released for signing out meanwhile: nothing of it is left on the device.
  return accountStep(registryId, () => disable(registryId, authority, options), { done: true, pending: 0 });
}

async function disable(registryId: string, authority: Authority, options: { force?: boolean }): Promise<TurnOffResult> {
  if (!deviceSyncAvailable()) return { done: true, pending: 0 };
  await waitForDeviceSyncHydration();
  const store = useDeviceSyncStore.getState();
  const accountName = accountDeviceSync(registryId).androidAccountName ?? (await androidAccountOf(registryId))?.name;
  cancelDeviceSyncRequests(registryId, authority);
  if (!accountName) {
    store.setEnabled(registryId, authority, false);
    return { done: true, pending: 0 };
  }
  await setSyncEnabled(accountName, authority, false).catch(noop);
  const result = await teardown(registryId, accountName, authority, !!options.force);
  if (result.failed || result.pending > 0) {
    return { done: false, pending: result.pending, failed: result.failed || undefined };
  }

  const before = accountDeviceSync(registryId);
  const { [authority]: _lastRun, ...lastRun } = before.lastRun;
  useDeviceSyncStore.getState().update(registryId, {
    enabled: { ...before.enabled, [authority]: false },
    lastRun,
    knownStates: withoutAuthorityStates(before, authority),
    // Asked again the next time calendar sync is turned on.
    ...(authority === CALENDAR_AUTHORITY ? { reminderOwner: null } : {}),
  });
  if (!anySyncOnInApp(accountDeviceSync(registryId))) {
    // Forget the name first: the removal fires `accountsChanged`, and the
    // reconcile must not take it for a removal in Android Settings.
    useDeviceSyncStore.getState().update(registryId, { androidAccountName: undefined, knownStates: undefined });
    await removeAndroidAccount(accountName).catch(noop);
    await clearSyncProblem(accountName).catch(noop);
  }
  void refreshPushState(registryId);
  return { done: true, pending: 0 };
}

// ─── Sign-out ──────────────────────────────────────────

/**
 * Before app accounts sign out (`auth-store` logout, logoutAll,
 * removeAccount): uploads what their devices changed, deletes the synced
 * rows and removes their Android accounts, while the credentials are still
 * there. When changes could not be uploaded, `confirm` asks whether to sign
 * out anyway. Resolves false when the user chose to stay signed in; their
 * accounts then keep syncing. It is a step of the accounts' own turn-ons and
 * turn-offs: it waits for those under way, and those asked for meanwhile find
 * the accounts released and do nothing.
 */
export function releaseDeviceSyncBeforeSignOut(
  registryIds: readonly string[],
  confirm: (pending: number) => Promise<boolean> = confirmSignOutLosingChanges,
): Promise<boolean> {
  if (!deviceSyncAvailable() || registryIds.length === 0) return Promise.resolve(true);
  const ids = [...new Set(registryIds)].sort();
  const signOut = oneAtATimeForAll(ids, async () => {
    try {
      return await release(registryIds, confirm);
    } catch (err) {
      // Never keep the user from signing out over a bug here; an Android
      // account left behind is suspended by the next reconcile.
      console.warn('[device-sync] release before sign-out failed', errorMessage(err));
      return true;
    }
  });
  for (const id of ids) signOuts.set(id, signOut);
  void signOut.then(() => {
    for (const id of ids) if (signOuts.get(id) === signOut) signOuts.delete(id);
  });
  return signOut;
}

async function release(
  registryIds: readonly string[],
  confirm: (pending: number) => Promise<boolean>,
): Promise<boolean> {
  await waitForDeviceSyncHydration();
  let androidAccounts: AndroidAccount[] = [];
  try {
    androidAccounts = await listAndroidAccounts();
  } catch {
    androidAccounts = [];
  }
  const targets = registryIds.flatMap((registryId) => {
    const accountName = androidAccounts.find((a) => a.registryId === registryId)?.name
      ?? accountDeviceSync(registryId).androidAccountName;
    return accountName ? [{ registryId, accountName }] : [];
  });
  if (targets.length > 0) {
    toast.info(t('device_sync.signing_out', 'Removing synced contacts and calendars from this device…'));
  }

  // Accounts in parallel (each has its own server and run lock), the
  // authorities of one account one after the other.
  const leftovers: Array<{ registryId: string; accountName: string; authority: Authority }> = [];
  let pending = 0;
  await Promise.all(targets.map(async ({ registryId, accountName }) => {
    cancelDeviceSyncRequests(registryId);
    for (const authority of AUTHORITIES) {
      await setSyncEnabled(accountName, authority, false).catch(noop);
      const result = await teardown(registryId, accountName, authority, false);
      if (result.failed || result.pending > 0) {
        leftovers.push({ registryId, accountName, authority });
        pending += result.pending;
      }
    }
  }));

  if (leftovers.length > 0) {
    if (!(await confirm(pending))) {
      // Staying signed in: sync goes on where it was on.
      for (const { registryId, accountName } of targets) {
        const entry = accountDeviceSync(registryId);
        for (const authority of AUTHORITIES) {
          if (syncOnInApp(entry, authority)) await setSyncEnabled(accountName, authority, true).catch(noop);
        }
      }
      return false;
    }
    for (const { registryId, accountName, authority } of leftovers) {
      await teardown(registryId, accountName, authority, true);
    }
  }

  // Forgotten before the removal: its `accountsChanged` must not read as a
  // removal in Android Settings.
  for (const registryId of registryIds) {
    cancelDeviceSyncRequests(registryId);
    useDeviceSyncStore.getState().forget(registryId);
  }
  for (const { accountName } of targets) {
    await removeAndroidAccount(accountName).catch(noop);
    await clearSyncProblem(accountName).catch(noop);
  }
  void refreshPushRoutes();
  return true;
}

// ─── Sign-in and reconcile ─────────────────────────────

/**
 * After an app account signed in successfully: clears its "sign in again"
 * notification, resumes a suspended account where it synced, and syncs what
 * a failed sign-in held back.
 */
export async function deviceSyncSignedIn(registryId: string): Promise<void> {
  if (!deviceSyncAvailable()) return;
  try {
    await waitForDeviceSyncHydration();
    const account = await androidAccountOf(registryId);
    if (!account) return;
    await clearSyncProblem(account.name).catch(noop);
    const entry = accountDeviceSync(registryId);
    useDeviceSyncStore.getState().update(registryId, { androidAccountName: account.name, suspended: undefined });
    const resumed = accountDeviceSync(registryId);
    for (const authority of AUTHORITIES) {
      if (!syncOnInApp(resumed, authority)) continue;
      if (entry.suspended) await setSyncEnabled(account.name, authority, true).catch(noop);
      await requestSync(account.name, authority, { manual: true }).catch(noop);
    }
    await refreshPushRoutes();
  } catch {
    // Best effort: the next reconcile catches up.
  }
}

/** An Android account whose app account the registry dropped: sync off, one notification, data kept. */
async function suspendAccount(account: AndroidAccount & { registryId: string }): Promise<void> {
  const entry = useDeviceSyncStore.getState().accounts[account.registryId];
  if (entry?.suspended) return;
  // Remember what synced, so signing in again resumes exactly that.
  const enabled: Partial<Record<Authority, boolean>> = { ...entry?.enabled };
  try {
    const settings = await getSyncSettings(account.name);
    for (const authority of AUTHORITIES) {
      if (settings.authorities?.[authority]?.automatic) enabled[authority] = true;
    }
  } catch {
    // What the app knows will do.
  }
  for (const authority of AUTHORITIES) await setSyncEnabled(account.name, authority, false).catch(noop);
  cancelDeviceSyncRequests(account.registryId);
  useDeviceSyncStore.getState().update(account.registryId, {
    androidAccountName: account.name,
    enabled,
    suspended: true,
  });
  await showSyncProblem(
    account.name,
    t('device_sync.signed_out_title', 'Sign in to keep syncing'),
    t(
      'device_sync.signed_out_text',
      '{account} was signed out, so its contacts and calendars on this device no longer sync. Sign in again to resume. Changes made on this device are kept.',
      { account: account.name },
    ),
    SIGN_IN_AGAIN_URI,
    t('device_sync.problem_channel', 'Sync problems'),
  ).catch(noop);
}

let reconciling: Promise<void> | null = null;

/**
 * Brings the app's view in step with Android's accounts: at launch, on
 * foreground and when accounts of our type change. Concurrent calls share
 * one pass.
 */
export function reconcileDeviceAccounts(): Promise<void> {
  if (!deviceSyncAvailable()) return Promise.resolve();
  if (!reconciling) {
    reconciling = reconcile()
      .catch((err) => console.warn('[device-sync] reconcile failed', errorMessage(err)))
      .finally(() => {
        reconciling = null;
      });
  }
  return reconciling;
}

async function reconcile(): Promise<void> {
  await waitForDeviceSyncHydration();
  const registry = await readRegistry();
  // Never act on an empty or unreadable registry: a failed read must not
  // suspend or forget anything.
  if (!registry || registry.length === 0) return;
  const androidAccounts = await listAndroidAccounts();
  const registryIds = new Set(registry.map((a) => a.id));
  const store = () => useDeviceSyncStore.getState();

  // Android accounts that are gone: removed in Android Settings (or by the
  // system). Sync shows off and the app does not recreate them.
  for (const [registryId, entry] of Object.entries(store().accounts)) {
    const name = entry.androidAccountName;
    if (!name || androidAccounts.some((a) => a.name === name && (a.registryId ?? registryId) === registryId)) continue;
    cancelDeviceSyncRequests(registryId);
    if (!registryIds.has(registryId)) {
      // Neither signed in nor on the device any more: nothing left to keep.
      store().forget(registryId);
      continue;
    }
    store().update(registryId, {
      androidAccountName: undefined,
      enabled: {},
      suspended: undefined,
      knownStates: undefined,
      removedInAndroidSettings: anySyncOnInApp(entry) || entry.removedInAndroidSettings || undefined,
    });
    void refreshPushSubscriptionTypes(registryId).catch(noop);
  }

  for (const account of androidAccounts) {
    const registryId = account.registryId;
    if (!registryId) continue;
    if (!registryIds.has(registryId)) {
      await suspendAccount({ ...account, registryId });
      continue;
    }
    const entry = accountDeviceSync(registryId);
    if (entry.suspended) {
      // Signed in again through a path that did not report it.
      await deviceSyncSignedIn(registryId);
      continue;
    }
    // Android is the source of truth: an authority turned on in Android
    // Settings counts as on in the app too.
    const enabled = { ...entry.enabled };
    let changed = entry.androidAccountName !== account.name || !!entry.removedInAndroidSettings;
    try {
      const settings = await getSyncSettings(account.name);
      for (const authority of AUTHORITIES) {
        if (settings.authorities?.[authority]?.automatic && !enabled[authority]) {
          enabled[authority] = true;
          changed = true;
        }
      }
    } catch {
      // Keep what the app knows.
    }
    if (changed) {
      store().update(registryId, { androidAccountName: account.name, enabled, removedInAndroidSettings: undefined });
    }
  }
  await refreshPushRoutes();
}

// ─── Settings actions ──────────────────────────────────

/** The periodic sync interval (0 = manual only). */
export async function changeSyncInterval(registryId: string, authority: Authority, seconds: number): Promise<void> {
  await waitForDeviceSyncHydration();
  useDeviceSyncStore.getState().setIntervalSeconds(registryId, authority, seconds);
  const entry = accountDeviceSync(registryId);
  if (!deviceSyncAvailable() || !entry.androidAccountName || !syncOnInApp(entry, authority)) return;
  await setPeriodicSync(entry.androidAccountName, authority, intervalFor(entry, authority)).catch(noop);
}

/** Who reminds the user of synced events; a change rewrites the device's reminders with a calendar sync. */
export async function changeReminderOwner(registryId: string, owner: ReminderOwner): Promise<void> {
  await waitForDeviceSyncHydration();
  const before = accountDeviceSync(registryId).reminderOwner;
  useDeviceSyncStore.getState().setReminderOwner(registryId, owner);
  const entry = accountDeviceSync(registryId);
  if (before === owner || !deviceSyncAvailable() || !entry.androidAccountName) return;
  if (!syncOnInApp(entry, CALENDAR_AUTHORITY)) return;
  await requestSync(entry.androidAccountName, CALENDAR_AUTHORITY, { manual: true }).catch(noop);
}

/** A sync right away: manual and expedited. Resolves false when the account has no Android account. */
export async function syncNow(registryId: string, authority: Authority): Promise<boolean> {
  const accountName = accountDeviceSync(registryId).androidAccountName;
  if (!deviceSyncAvailable() || !accountName) return false;
  await requestSync(accountName, authority, { manual: true, expedited: true });
  return true;
}

/**
 * After a run held back many deletions made on the device
 * (`tooManyDeletions`): delete those items on the server too, or bring them
 * back on the device from the server. Android's own screens offer neither.
 */
export async function resolveDeletions(registryId: string, authority: Authority, choice: 'delete' | 'restore'): Promise<boolean> {
  const accountName = accountDeviceSync(registryId).androidAccountName;
  if (!deviceSyncAvailable() || !accountName) return false;
  await requestSync(
    accountName,
    authority,
    choice === 'delete' ? { manual: true, overrideTooManyDeletions: true } : { manual: true, discardLocalDeletions: true },
  );
  return true;
}

/** Android's sync screen of the account ("Android account settings"). */
export async function openAndroidAccountSettings(registryId: string): Promise<boolean> {
  const accountName = accountDeviceSync(registryId).androidAccountName;
  if (!deviceSyncAvailable() || !accountName) return false;
  await openAccountSettings(accountName);
  return true;
}

/**
 * Drops a suspended account (one the app signed out while it synced) from
 * this device: its Android account and, with it, every synced row. Changes
 * made on the device that never reached the server are lost; the caller
 * asks first.
 */
export async function removeSuspendedAccount(registryId: string): Promise<void> {
  if (!deviceSyncAvailable()) return;
  await waitForDeviceSyncHydration();
  const accountName = accountDeviceSync(registryId).androidAccountName ?? (await androidAccountOf(registryId))?.name;
  cancelDeviceSyncRequests(registryId);
  // Forgotten first, so the removal's `accountsChanged` finds nothing to mark.
  useDeviceSyncStore.getState().forget(registryId);
  if (accountName) {
    await removeAndroidAccount(accountName).catch(noop);
    await clearSyncProblem(accountName).catch(noop);
  }
  void refreshPushRoutes();
}
