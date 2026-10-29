/**
 * Entry of the BulwarkDeviceSync headless task, which the contacts and
 * calendar sync adapters start for every sync (index.ts registers it), and
 * the teardown the app calls when sync is turned off or an account signs
 * out. See docs/device-sync.md.
 *
 * This is the React Native boundary of the engine: it wires the native
 * module, a detached JMAPClient per registry account (never the UI's
 * singleton) and the device-sync store into the pure engine.
 *
 * A run always ends with `finishRun`, called before the task's promise
 * settles: JS timers stop once the task is over, and a sync adapter waiting
 * for a report that never comes holds its sync until the deadline. Nothing
 * here throws: every failure becomes a report.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { detectDeviceLocale, isSupportedLocale, translate, type LocaleCode } from '../i18n';
import { randomBytes } from '../lib/random';
import { accountDeviceSync, accountSyncPrefs, useDeviceSyncStore, waitForDeviceSyncHydration } from '../stores/device-sync-store';
import type { RandomSource } from './common/ids';
import {
  runDeviceSync,
  teardownAuthority as teardownWithDeps,
  type EngineDeps,
  type SubscriptionCalendar,
  type TeardownOptions,
} from './engine';
import { calendarPlanner } from './calendar/planner';
import { contactsPlanner } from './contacts/planner';
import { emptyStats } from './engine/report';
import { openJmapPort } from './jmap/client-port';
import { createProviderPort, finishRun, getSyncSettings, isRunCancelled, showSyncProblem } from './native';
import type { Authority, RunPayload, RunReport } from './types';

// Mirrors the persist names of the locale and feed-subscription stores; read
// straight from storage so a headless run loads neither store.
const LOCALE_STORAGE_KEY = 'webmail:locale:v1';
const SUBSCRIPTIONS_STORAGE_KEY = 'calendar-subscriptions';
/** Where "sign in again" leads (the accounts pane), as for a registry eviction. */
const SIGN_IN_URI = 'bulwarkmobile://settings/account';

/** Random numbers from the platform CSPRNG, buffered (uids and map keys of device-made items). */
function secureRandom(): RandomSource {
  let buffer: Uint8Array = new Uint8Array(0);
  let offset = 0;
  return () => {
    if (offset + 4 > buffer.length) {
      buffer = randomBytes(256);
      offset = 0;
    }
    const n = ((buffer[offset] << 24) >>> 0) + (buffer[offset + 1] << 16) + (buffer[offset + 2] << 8) + buffer[offset + 3];
    offset += 4;
    return n / 2 ** 32;
  };
}

/** Feed-subscription calendars (read-only on the device), from the subscriptions store's storage. */
async function subscriptionCalendars(): Promise<SubscriptionCalendar[]> {
  try {
    const raw = await AsyncStorage.getItem(SUBSCRIPTIONS_STORAGE_KEY);
    const subscriptions = raw ? (JSON.parse(raw) as { state?: { subscriptions?: unknown } }).state?.subscriptions : null;
    if (!Array.isArray(subscriptions)) return [];
    return subscriptions
      .filter((s): s is { calendarId: string; accountId?: unknown } => typeof s?.calendarId === 'string')
      .map((s) => ({ calendarId: s.calendarId, jmapAccountId: typeof s.accountId === 'string' ? s.accountId : null }));
  } catch {
    return [];
  }
}

/** The app's language: the in-app override, else the device's. */
async function appLocale(): Promise<LocaleCode> {
  try {
    const raw = await AsyncStorage.getItem(LOCALE_STORAGE_KEY);
    const override = raw ? (JSON.parse(raw) as { override?: unknown }).override : null;
    if (typeof override === 'string' && isSupportedLocale(override)) return override;
  } catch {
    // The device language it is.
  }
  return detectDeviceLocale();
}

function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

async function notifyAuthProblem(_registryId: string, accountName: string): Promise<void> {
  const locale = await appLocale();
  await showSyncProblem(
    accountName,
    translate(locale, 'device_sync.auth_problem_title', 'Sign in again to keep syncing'),
    translate(
      locale,
      'device_sync.auth_problem_text',
      'The server no longer accepts the sign-in of {account}, so its contacts and calendars on this device stopped syncing. Sign in again to resume. Changes made on this device are kept.',
      { account: accountName },
    ),
    SIGN_IN_URI,
    translate(locale, 'device_sync.problem_channel', 'Sync problems'),
  );
}

export function createTaskDeps(): EngineDeps {
  return {
    provider: createProviderPort,
    jmap: openJmapPort,
    prefs: async (registryId) => {
      await waitForDeviceSyncHydration();
      return accountSyncPrefs(registryId);
    },
    planners: { contacts: contactsPlanner, calendar: calendarPlanner },
    now: () => Date.now(),
    isCancelled: isRunCancelled,
    random: secureRandom(),
    subscriptionCalendars,
    isSyncEnabled: async (accountName, authority) => (await getSyncSettings(accountName)).authorities?.[authority]?.automatic === true,
    deviceZone,
    // zustand 5 persists on every set(), hydrated or not: wait, or the stored preferences are overwritten.
    recordStatus: async (registryId, authority, status) => {
      await waitForDeviceSyncHydration();
      useDeviceSyncStore.getState().recordRunStatus(registryId, authority, status);
    },
    lastStatus: async (registryId, authority) => {
      await waitForDeviceSyncHydration();
      return accountDeviceSync(registryId).lastRun[authority];
    },
    recordKnownState: async (registryId, jmapAccountId, type, state) => {
      await waitForDeviceSyncHydration();
      useDeviceSyncStore.getState().recordKnownState(registryId, jmapAccountId, type, state);
    },
    notifyAuthProblem,
    // Notes like "account d left out" only inform; an exception is worth a
    // warning (in debug builds every warning puts LogBox over the app).
    log: (message, detail) => {
      if (detail instanceof Error) console.warn(`[device-sync] ${message}`, detail.message);
      else console.log(`[device-sync] ${message}`, detail ?? '');
    },
  };
}

function failureReport(payload: RunPayload, error: unknown): RunReport {
  return {
    v: 1,
    runId: payload.runId,
    authority: payload.authority,
    outcome: 'internal',
    message: error instanceof Error ? error.message : String(error),
    startedAt: Date.now(),
    durationMs: 0,
    stats: emptyStats(),
    conflicts: 0,
    itemErrors: [],
  };
}

export async function runDeviceSyncTask(payload: RunPayload): Promise<void> {
  if (!payload?.runId) return;
  let report: RunReport;
  try {
    report = await runDeviceSync(payload, createTaskDeps());
  } catch (error) {
    report = failureReport(payload, error);
  }
  try {
    await finishRun(payload.runId, report);
  } catch (error) {
    // The adapter ends the run on its own when the task finishes.
    console.warn('[device-sync] finishRun failed', error instanceof Error ? error.message : error);
  }
}

/**
 * Turning sync off for an authority (or signing out): uploads what the
 * device changed (bounded by `timeoutMs`, default 30 s), then removes the
 * authority's rows and SyncState. When changes are still waiting
 * (`pending > 0`) nothing is deleted unless `force` is set, once the user
 * confirmed losing them. Runs under the same lock as sync runs.
 */
export function teardownAuthority(
  registryId: string,
  accountName: string,
  authority: Authority,
  options?: TeardownOptions,
): Promise<{ pending: number }> {
  return teardownWithDeps(createTaskDeps(), registryId, accountName, authority, options);
}
