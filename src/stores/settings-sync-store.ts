// Settings sync (#117): keeps this device's settings and the copy in an
// account's private Inbox metadata the same (lib/settings-sync has the format and
// the merge; docs/settings-sync.md describes both).
//
// One account holds the settings of the whole app: the first one signed in,
// or the one picked under Settings > Storage & backup. Once taken it stays
// the holder: when it signs out, sync waits for the user to pick another
// rather than move the settings into a mailbox nobody chose. Its requests go
// through a client of their own, never the app's `jmapClient`: that one
// follows the active account, and a round caught by a switch would write
// one account's settings into another's mailbox.
//
// A round reads the account's entries, takes what is newer there, and sends
// what is newer here. It runs when the app starts or comes back, after a
// change here, and when the account's mailboxes change on the server (a
// settings write by another device is one such change).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { create } from 'zustand';
import { AuthenticationError, JMAPClient, NetworkError } from '../api/jmap-client';
import {
  advertisesBulwarkMetadata, getBulwarkMetadata, metadataValueBytes, MetadataTooLargeError, patchBulwarkMetadata,
  resumeBulwarkMetadata,
} from '../api/bulwark-metadata';
import {
  MAX_PLAIN_VALUE_BYTES, nextStamp, planSettingsSync, readRemoteSettings, sameJson, settingsWrites,
  type LocalSetting, type SettingPush,
} from '../lib/settings-sync';
import { onStateChangeType } from '../lib/state-change-bus';
import { useAccountStore } from './account-store';
import { useNetworkStore } from './network-store';
import { usePolicyStore } from './policy-store';
import {
  acceptSyncedValue, DEFAULT_PERSISTED, isPolicySettingKey, isSettingLockedByPolicy, setSettingsUserChangeListener,
  SETTINGS_KEY_MAP, SYNCED_SETTING_KEYS, useSettingsStore,
  type PersistedSettings, type SettingsUserChange,
} from './settings-store';

const STORAGE_KEY = 'settings-sync:v1';
/** A burst of changes goes out as one round. */
const CHANGE_DELAY_MS = 1500;
/**
 * Every new message changes the mailboxes too, so rounds started by a
 * mailbox change keep this far apart.
 */
const SERVER_CHANGE_GAP_MS = 30_000;
/** When a round failed and nothing else asks for one, the next try. */
const RETRY_MS = 10 * 60_000;

export type SettingsSyncStatus =
  /** Nothing has run yet. */
  | 'waiting'
  | 'syncing'
  | 'synced'
  /** The account's server keeps no metadata (Stalwart before 1.0, other servers). */
  | 'unsupported'
  /** The server couldn't be reached, or refused the stored sign-in. */
  | 'unreachable'
  /** The account's metadata has no room for the settings. */
  | 'full'
  /** The account that held the settings is no longer signed in here: the user picks another. */
  | 'signed-out';

interface Marks {
  /** The registry account these are for. Another account's copy has a history of its own. */
  holder: string | null;
  /** When each setting last changed here or was taken from the account, by its webmail name. */
  stamps: Record<string, number>;
  /** The settings whose last change here put them back to the default. */
  resets: Record<string, true>;
  /**
   * Values this device had chosen for itself that a round replaced with the
   * account's, by settings key, until the user takes them back or lets go.
   */
  replaced: Record<string, unknown>;
}

interface SettingsSyncState {
  hydrated: boolean;
  status: SettingsSyncStatus;
  /** The registry account that holds the settings, once a round has taken it. */
  accountId: string | null;
  lastSyncedAt: number | null;
  /** Lists too long for one entry (8 KB): they stay on this device. */
  tooLarge: (keyof PersistedSettings)[];
  /**
   * Values this device had chosen for itself (before it synced, or while
   * sync was off) that a round replaced with the account's. Kept, also
   * across a restart, so the user can have them back (keepReplaced).
   */
  replaced: Partial<PersistedSettings> | null;
  hydrate: () => Promise<void>;
  /** Run a round now (Settings > "Sync now"). */
  syncNow: () => Promise<void>;
  /** Put back the values the first sync replaced, as changes made now: they then go to the other devices. */
  keepReplaced: () => void;
  dismissReplaced: () => void;
}

const noMarks = (holder: string | null = null): Marks => ({ holder, stamps: {}, resets: {}, replaced: {} });
let marks: Marks = noMarks();

function persistMarks(): void {
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(marks)).catch((err) => {
    console.warn('[settings-sync] persist failed', err);
  });
}

function readMarks(raw: string | null): Marks {
  const out = noMarks();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as { holder?: unknown; stamps?: unknown; resets?: unknown; replaced?: unknown };
    if (parsed.replaced && typeof parsed.replaced === 'object' && !Array.isArray(parsed.replaced)) {
      for (const [key, value] of Object.entries(parsed.replaced as Record<string, unknown>)) {
        if (SYNCED_SETTING_KEYS.includes(key as keyof PersistedSettings)) out.replaced[key] = value;
      }
    }
    if (typeof parsed.holder === 'string' && parsed.holder) out.holder = parsed.holder;
    if (parsed.stamps && typeof parsed.stamps === 'object') {
      for (const [name, at] of Object.entries(parsed.stamps as Record<string, unknown>)) {
        if (typeof at === 'number' && Number.isFinite(at) && at > 0) out.stamps[name] = at;
      }
    }
    if (parsed.resets && typeof parsed.resets === 'object') {
      for (const name of Object.keys(parsed.resets as Record<string, unknown>)) {
        if (out.stamps[name]) out.resets[name] = true;
      }
    }
  } catch {
    // Unreadable marks: the device syncs as one that never did.
  }
  return out;
}

const webName = (key: keyof PersistedSettings): string => SETTINGS_KEY_MAP[key] ?? key;
const KEY_OF_NAME = new Map<string, keyof PersistedSettings>(SYNCED_SETTING_KEYS.map((key) => [webName(key), key]));
const SYNCED = new Set<keyof PersistedSettings>(SYNCED_SETTING_KEYS);

// Changes made before the marks were read from storage: stamped once they are.
let early: SettingsUserChange[] | null = [];

/**
 * The user changed settings: stamp them, and send them shortly. With sync
 * switched off the stamp goes instead: the value is then this device's own,
 * and when sync comes back on it fills a gap in the account's copy or gives
 * way to it (with the offer to keep it), as on a device that never synced.
 */
function onUserChange(change: SettingsUserChange): void {
  if (early) {
    early.push(change);
    return;
  }
  const enabled = useSettingsStore.getState().settingsSyncEnabled;
  const now = Date.now();
  let touched = false;
  for (const key of change.keys) {
    if (!SYNCED.has(key)) continue;
    const name = webName(key);
    if (enabled) {
      marks.stamps[name] = nextStamp(marks.stamps[name], now);
      if (change.reset) marks.resets[name] = true;
      else delete marks.resets[name];
    } else {
      delete marks.stamps[name];
      delete marks.resets[name];
    }
    touched = true;
  }
  if (!touched) return;
  persistMarks();
  // A round under way was planned before this change: the request makes one follow it.
  if (enabled) requestSettingsSync(CHANGE_DELAY_MS);
}

let lastRoundAt = 0;

function localSettings(): LocalSetting[] {
  const state = useSettingsStore.getState();
  const explicit = new Set(state.explicitSettings);
  return SYNCED_SETTING_KEYS.map((key) => {
    const name = webName(key);
    const value = state[key];
    const defaultValue = DEFAULT_PERSISTED[key];
    return {
      name,
      value,
      defaultValue,
      at: marks.stamps[name] ?? 0,
      reset: marks.resets[name] === true,
      // Plain settings carry a mark for "chosen"; a list or a map is chosen once it differs from the default.
      chosen: isPolicySettingKey(key) ? explicit.has(key) : !sameJson(value, defaultValue),
      locked: isSettingLockedByPolicy(key),
      accept: (incoming: unknown) => acceptSyncedValue(key, incoming),
    };
  });
}

/**
 * The registry account that holds the settings: the one picked or taken
 * earlier, or the first signed in while none has been. Null when there is
 * none, also when the holder is no longer signed in.
 */
export function settingsSyncAccount(): string | null {
  const { accounts } = useAccountStore.getState();
  const picked = useSettingsStore.getState().settingsSyncAccountId;
  if (picked) return accounts.some((account) => account.id === picked) ? picked : null;
  return accounts[0]?.id ?? null;
}

// The sync client and the registry account it serves.
let side: { id: string; client: JMAPClient } | null = null;

/** Test hook: the client rounds use instead of opening one. */
let clientFactory: () => JMAPClient = () => new JMAPClient();
export function setSettingsSyncClientFactory(factory: (() => JMAPClient) | null): void {
  clientFactory = factory ?? (() => new JMAPClient());
  side = null;
}

async function openClient(registryId: string): Promise<JMAPClient | null> {
  if (side?.id === registryId && side.client.isConnected) return side.client;
  side = null;
  const client = clientFactory();
  try {
    if (!(await client.loadAccount(registryId))) return null;
  } catch (err) {
    // Offline, or a sign-in the server no longer takes: the app deals with
    // that where the user can see it. Sync waits for the next round.
    if (err instanceof AuthenticationError || err instanceof NetworkError) return null;
    throw err;
  }
  side = { id: registryId, client };
  return client;
}

export const useSettingsSyncStore = create<SettingsSyncState>((set, get) => ({
  hydrated: false,
  status: 'waiting',
  accountId: null,
  lastSyncedAt: null,
  tooLarge: [],
  replaced: null,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      marks = readMarks(await AsyncStorage.getItem(STORAGE_KEY));
    } catch (err) {
      console.warn('[settings-sync] hydrate failed', err);
    }
    const waiting = early ?? [];
    early = null;
    set({ hydrated: true, replaced: replacedOrNull() });
    for (const change of waiting) onUserChange(change);
  },

  syncNow: () => runRound(),

  keepReplaced: () => {
    const replaced = marks.replaced;
    marks.replaced = {};
    persistMarks();
    set({ replaced: null });
    const update = useSettingsStore.getState().updateSetting;
    for (const [key, value] of Object.entries(replaced)) {
      update(key as keyof PersistedSettings, value as never);
    }
  },

  dismissReplaced: () => {
    marks.replaced = {};
    persistMarks();
    set({ replaced: null });
  },
}));

function replacedOrNull(): Partial<PersistedSettings> | null {
  return Object.keys(marks.replaced).length > 0 ? { ...marks.replaced } as Partial<PersistedSettings> : null;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;
let again = false;

/** Ask for a round, `delayMs` from now; requests in between fold into it. */
export function requestSettingsSync(delayMs = 0): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runRound();
  }, delayMs);
}

/** One round at a time; one asked for meanwhile runs after it. */
function runRound(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = round()
    .catch((err) => {
      console.warn('[settings-sync] round failed', err);
      failed();
    })
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        requestSettingsSync(0);
      }
    });
  return running;
}

/**
 * A round that couldn't reach the account. The client goes: the next round
 * loads the account's sign-in afresh, which may have changed (a new
 * password), and tries again later even if nothing else asks for a round.
 */
function failed(): void {
  side = null;
  useSettingsSyncStore.setState({ status: 'unreachable' });
  if (!timer) requestSettingsSync(RETRY_MS);
}

/** Whether the round for `registryId` should stop: sync went off, or moved to another account. */
function moved(registryId: string): boolean {
  return !useSettingsStore.getState().settingsSyncEnabled || settingsSyncAccount() !== registryId;
}

async function round(): Promise<void> {
  const settings = useSettingsStore.getState();
  const store = useSettingsSyncStore;
  if (!settings.hydrated || !store.getState().hydrated || !settings.settingsSyncEnabled) return;
  // The organisation's locks come with the active account's policy: before
  // it is applied, a pinned setting would be taken or sent like any other.
  if (!usePolicyStore.persist.hasHydrated()
    || usePolicyStore.getState().accountId !== useAccountStore.getState().activeAccountId) return;
  const registryId = settingsSyncAccount();
  if (!registryId) {
    if (settings.settingsSyncAccountId && useAccountStore.getState().accounts.length > 0) {
      // Its client goes with it: it holds the sign-in of an account that is gone.
      side = null;
      store.setState({ status: 'signed-out', accountId: null });
    }
    return;
  }
  if (store.getState().accountId !== registryId) {
    refusedAt.clear();
    store.setState({ accountId: registryId, status: 'waiting', lastSyncedAt: null, tooLarge: [] });
  }
  lastRoundAt = Date.now();
  if (!useNetworkStore.getState().online) {
    store.setState({ status: 'unreachable' });
    return;
  }
  store.setState({ status: 'syncing' });

  const client = await openClient(registryId);
  if (moved(registryId)) return;
  if (!client) {
    failed();
    return;
  }
  const accountId = client.accountId;
  if (!advertisesBulwarkMetadata(accountId, client, 'private')) {
    store.setState({ status: 'unsupported' });
    return;
  }
  // The pause a failed read leaves (api/bulwark-metadata) is not sat out
  // here: rounds are already spaced, and one was asked for.
  resumeBulwarkMetadata(accountId, client, 'private');
  const entries = await getBulwarkMetadata(accountId, client, 'private');
  if (moved(registryId)) return;
  if (!entries) {
    failed();
    return;
  }

  // The account answered: from here on it is the holder. The first account
  // signed in stays it when the account list is put in another order.
  if (settings.settingsSyncAccountId !== registryId) settings.updateSetting('settingsSyncAccountId', registryId);
  // Another account's copy has its own history: this device meets it as one
  // that never synced, and its stamps for the previous account don't count.
  if (marks.holder !== registryId) {
    marks = marks.holder === null ? { ...marks, holder: registryId } : noMarks(registryId);
    persistMarks();
    store.setState({ replaced: replacedOrNull() });
  }

  const remote = readRemoteSettings(entries);
  const plan = planSettingsSync(localSettings(), remote);

  // What the account has newer comes in first. The values before their
  // stamps: stopped between the two, the next round takes them again, where
  // the other order would leave this device with the old values for good.
  if (Object.keys(plan.take).length > 0 || plan.reset.length > 0) {
    const values: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(plan.take)) values[KEY_OF_NAME.get(name)!] = value;
    useSettingsStore.getState().applySyncedSettings(
      values as Partial<PersistedSettings>,
      plan.reset.map((name) => KEY_OF_NAME.get(name)!),
    );
  }
  for (const [name, at] of Object.entries(plan.stamps)) {
    marks.stamps[name] = at;
    if (plan.resets[name]) marks.resets[name] = true;
    else delete marks.resets[name];
  }
  const replacedNames = Object.keys(plan.replaced);
  for (const name of replacedNames) marks.replaced[KEY_OF_NAME.get(name)!] = plan.replaced[name];
  if (Object.keys(plan.stamps).length > 0 || replacedNames.length > 0) persistMarks();
  if (replacedNames.length > 0) {
    store.setState({ replaced: replacedOrNull() });
    void announceReplaced(Object.keys(marks.replaced).length);
  }

  const outcome = await send(plan.push, remote.shards, accountId, client, registryId);
  if (outcome === 'moved') return;
  if (outcome === 'unreachable') {
    failed();
    return;
  }
  store.setState({
    status: outcome === 'ok' ? 'synced' : outcome,
    lastSyncedAt: outcome === 'ok' ? Date.now() : store.getState().lastSyncedAt,
    tooLarge: tooLargeNow(),
  });
}

/**
 * Tell the user that settings they had chosen on this device gave way to
 * the account's, with the way back. Settings > Storage & backup keeps the
 * same offer until it is taken or closed.
 */
async function announceReplaced(count: number): Promise<void> {
  const [{ toast }, { useLocaleStore }] = await Promise.all([import('./toast-store'), import('./locale-store')]);
  const t = useLocaleStore.getState().t;
  toast.info(t('settings.sync.title', 'Settings sync'), {
    message: t(
      'settings.sync.replaced',
      '{count, plural, one {# setting on this device now follows} other {# settings on this device now follow}} your account.',
      { count },
    ),
    action: {
      label: t('settings.sync.keep_mine', "Use this device's"),
      onPress: () => useSettingsSyncStore.getState().keepReplaced(),
    },
  });
}

// Lists the account refused for their size, with the stamp refused: they
// are offered again only once they change.
const refusedAt = new Map<string, number>();

function tooLargeNow(): (keyof PersistedSettings)[] {
  return [...refusedAt.keys()].map((name) => KEY_OF_NAME.get(name)!).filter(Boolean);
}

async function send(
  push: SettingPush[],
  existingShards: ReadonlySet<number>,
  accountId: string,
  client: JMAPClient,
  registryId: string,
): Promise<'ok' | 'full' | 'unreachable' | 'moved'> {
  for (const name of [...refusedAt.keys()]) {
    const pending = push.find((item) => item.name === name);
    if (!pending || pending.at !== refusedAt.get(name)) refusedAt.delete(name);
  }
  // An overlong text among the plain settings would have the server refuse
  // the update that carries all of them: it stays here, like a list too long.
  for (const item of push) {
    if (!item.ownEntry && !item.reset && metadataValueBytes(item.value) > MAX_PLAIN_VALUE_BYTES) {
      refusedAt.set(item.name, item.at);
    }
  }
  const writes = settingsWrites(push.filter((item) => refusedAt.get(item.name) !== item.at), existingShards);
  let full = false;
  try {
    if (writes.shards.length > 0) {
      if (moved(registryId)) return 'moved';
      try {
        await patchBulwarkMetadata(accountId, writes.shards, client, 'private');
      } catch (err) {
        if (!(err instanceof MetadataTooLargeError)) throw err;
        full = true;
      }
    }
    for (const write of writes.values) {
      if (moved(registryId)) return 'moved';
      try {
        await patchBulwarkMetadata(accountId, [write.change], client, 'private');
      } catch (err) {
        if (!(err instanceof MetadataTooLargeError)) throw err;
        // Over 8 KB on its own, or more than the 16 KB the account has
        // left: either way this list stays here until it changes.
        refusedAt.set(write.name, write.at);
      }
    }
  } catch (err) {
    console.warn('[settings-sync] could not save settings in the account', err);
    return 'unreachable';
  }
  return full ? 'full' : 'ok';
}

/**
 * Start syncing: stamp the user's changes from now on (also after the stop:
 * a change made while nobody is signed in is one all the same) and run the
 * first round. Returns the stop function. Called once the stored session is back
 * (App.tsx); the rounds themselves wait for the stores to be read.
 */
export function startSettingsSync(): () => void {
  setSettingsUserChangeListener(onUserChange);
  void useSettingsSyncStore.getState().hydrate().then(() => requestSettingsSync(0));

  // Switching sync on, or to another account, syncs at once.
  const unsubscribeSettings = useSettingsStore.subscribe((state, prev) => {
    if (state.hydrated !== prev.hydrated
      || state.settingsSyncEnabled !== prev.settingsSyncEnabled
      || state.settingsSyncAccountId !== prev.settingsSyncAccountId) {
      // Not for the round's own note of which account it took.
      const noted = state.settingsSyncAccountId === useSettingsSyncStore.getState().accountId
        && state.settingsSyncEnabled === prev.settingsSyncEnabled && state.hydrated === prev.hydrated;
      if (state.settingsSyncEnabled && !noted) requestSettingsSync(0);
    }
  });
  // An account signed in or out: the first one takes the settings, or the
  // one that held them is gone.
  const unsubscribeAccounts = useAccountStore.subscribe((state, prev) => {
    if (state.accounts.length !== prev.accounts.length) requestSettingsSync(0);
  });
  // Rounds wait for the organisation policy of the active account.
  const unsubscribePolicy = usePolicyStore.subscribe((state, prev) => {
    if (state.accountId !== prev.accountId) requestSettingsSync(0);
  });
  // Back in the foreground, or back online: other devices may have changed things meanwhile.
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') requestSettingsSync(0);
  });
  const unsubscribeNetwork = useNetworkStore.subscribe((state, prev) => {
    if (state.online && !prev.online) requestSettingsSync(0);
  });
  // A settings write by another device changes the account's mailboxes; so
  // does every new message, hence the gap. Only the active account's
  // changes arrive here: for another one the rounds above have to do.
  const unsubscribeMailbox = onStateChangeType('Mailbox', (accountId) => {
    if (!side || side.client.accountId !== accountId || timer) return;
    requestSettingsSync(Math.max(CHANGE_DELAY_MS, lastRoundAt + SERVER_CHANGE_GAP_MS - Date.now()));
  });
  return () => {
    unsubscribeSettings();
    unsubscribeAccounts();
    unsubscribePolicy();
    appState.remove();
    unsubscribeNetwork();
    unsubscribeMailbox();
    if (timer) clearTimeout(timer);
    timer = null;
    side = null;
  };
}

/** Test hook: forget everything held in memory. */
export function resetSettingsSyncForTests(): void {
  setSettingsUserChangeListener(null);
  if (timer) clearTimeout(timer);
  timer = null;
  running = null;
  again = false;
  side = null;
  marks = noMarks();
  early = [];
  lastRoundAt = 0;
  refusedAt.clear();
  useSettingsSyncStore.setState({
    hydrated: false, status: 'waiting', accountId: null, lastSyncedAt: null, tooLarge: [], replaced: null,
  });
}

/** Test hook: the stamps held for the settings, by webmail name. */
export function settingsSyncStampsForTests(): Readonly<Record<string, number>> {
  return marks.stamps;
}
