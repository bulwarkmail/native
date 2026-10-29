/**
 * Device sync preferences and status per app account (Android only, #34;
 * docs/device-sync.md, "App integration"). Keyed by `AccountEntry.id`.
 *
 * Whether sync runs is not stored here: Android's sync settings
 * (`getSyncAutomatically` per authority) are the source of truth, so the
 * toggles in Settings → Accounts and the app always agree. `enabled` only
 * records what the user turned on in the app, which tells "paused in Android
 * settings" (on here, off there) from "off".
 *
 * Persisted under `device-sync:v1` without the write delay the caches use: a
 * headless sync run may be the only thing alive, and its status must survive
 * the process. Not part of the settings export. A headless run reads and
 * writes it only after `waitForDeviceSyncHydration()`: zustand 5 persists on
 * every `set()`, even before hydration, and would overwrite the stored state.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createPersistStorage } from './persist-storage';
import {
  AUTHORITIES,
  CONTACTS_AUTHORITY,
  type AccountSyncPrefs,
  type Authority,
  type CollectionKey,
  type ReminderOwner,
  type RunStatus,
} from '../device-sync/types';
import {
  DEVICE_SYNC_STORAGE_KEY,
  STATE_TYPES_BY_AUTHORITY,
  syncOnInApp,
} from '../device-sync/app/prefs';
import { collectionDefaultOn } from '../device-sync/engine/selection';

export { syncOnInApp };

/** Periodic sync interval when the user has not picked one: push covers freshness. */
export const DEFAULT_INTERVAL_SECONDS = 3600;

export interface AccountDeviceSync {
  /** Explicit choices only; unlisted collections follow the default (personal on, shared off). */
  contactsSelection: Record<CollectionKey, boolean>;
  calendarSelection: Record<CollectionKey, boolean>;
  /** Where contacts created on the device go; unset = the server's default address book. */
  newContactsAddressBook?: CollectionKey;
  /** Who reminds the user of synced events; null until asked. */
  reminderOwner: ReminderOwner | null;
  /** Periodic sync per authority in seconds; 0 = manual only. */
  intervalSeconds: Partial<Record<Authority, number>>;
  lastRun: Partial<Record<Authority, RunStatus>>;
  /** The Android account name this app account uses. */
  androidAccountName?: string;
  /** Removed in Android Settings: the app shows sync as off and never recreates the account on its own. */
  removedInAndroidSettings?: boolean;
  /**
   * Latest item states the engine synced, per JMAP account and type
   * (`ContactCard`, `CalendarEvent`, …). A StateChange naming the same state is
   * our own echo and triggers no sync.
   */
  knownStates?: Record<string, Record<string, string>>;
  /** Authorities the user turned on in the app (Android may still pause them). */
  enabled?: Partial<Record<Authority, boolean>>;
  /**
   * The app dropped the account from its registry (its sign-in failed) while
   * it synced: automatic sync was turned off and the device data kept until
   * the user signs in again.
   */
  suspended?: boolean;
  /** The JMAP account holding the personal collections, per authority, as last seen. */
  primaryJmapAccounts?: Partial<Record<Authority, string>>;
}

export function emptyAccountDeviceSync(): AccountDeviceSync {
  return {
    contactsSelection: {},
    calendarSelection: {},
    reminderOwner: null,
    intervalSeconds: {},
    lastRun: {},
  };
}

interface DeviceSyncState {
  accounts: Record<string, AccountDeviceSync>;
  update: (registryId: string, patch: Partial<AccountDeviceSync>) => void;
  recordRunStatus: (registryId: string, authority: Authority, status: RunStatus) => void;
  recordKnownState: (registryId: string, jmapAccountId: string, type: string, state: string) => void;
  forget: (registryId: string) => void;

  /** Turns an authority on or off in the app (not in Android). */
  setEnabled: (registryId: string, authority: Authority, on: boolean) => void;
  /** An explicit choice for one address book or calendar. */
  setCollectionSelected: (registryId: string, authority: Authority, key: CollectionKey, on: boolean) => void;
  /** Where contacts created on the device go; null = the server's default book. */
  setNewContactsAddressBook: (registryId: string, key: CollectionKey | null) => void;
  setIntervalSeconds: (registryId: string, authority: Authority, seconds: number) => void;
  setReminderOwner: (registryId: string, owner: ReminderOwner | null) => void;
  setRemovedInAndroidSettings: (registryId: string, removed: boolean) => void;
  setAndroidAccountName: (registryId: string, name: string | undefined) => void;
  rememberPrimaryJmapAccount: (registryId: string, authority: Authority, jmapAccountId: string) => void;
}

function selectionField(authority: Authority): 'contactsSelection' | 'calendarSelection' {
  return authority === CONTACTS_AUTHORITY ? 'contactsSelection' : 'calendarSelection';
}

// Persisted entries are trusted only as far as their shape: a field of the
// wrong type falls back to the empty default instead of crashing a reader.
function sanitizeEntry(value: unknown): AccountDeviceSync | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const record = (x: unknown) => (isRecord(x) ? x : {});
  const optionalRecord = (x: unknown) => (isRecord(x) ? x : undefined);
  const knownStates = isRecord(v.knownStates)
    ? Object.fromEntries(Object.entries(v.knownStates).filter(([, states]) => isRecord(states)))
    : undefined;
  return {
    ...(v as Partial<AccountDeviceSync>),
    contactsSelection: record(v.contactsSelection) as Record<CollectionKey, boolean>,
    calendarSelection: record(v.calendarSelection) as Record<CollectionKey, boolean>,
    reminderOwner: v.reminderOwner === 'device' || v.reminderOwner === 'bulwark' ? v.reminderOwner : null,
    intervalSeconds: record(v.intervalSeconds) as Partial<Record<Authority, number>>,
    lastRun: record(v.lastRun) as Partial<Record<Authority, RunStatus>>,
    androidAccountName: typeof v.androidAccountName === 'string' && v.androidAccountName ? v.androidAccountName : undefined,
    enabled: optionalRecord(v.enabled) as AccountDeviceSync['enabled'],
    knownStates: knownStates as AccountDeviceSync['knownStates'],
    primaryJmapAccounts: optionalRecord(v.primaryJmapAccounts) as AccountDeviceSync['primaryJmapAccounts'],
  };
}

export const useDeviceSyncStore = create<DeviceSyncState>()(
  persist(
    (set) => {
      // Applies `change` to one account's entry, creating it when missing.
      const edit = (registryId: string, change: (current: AccountDeviceSync) => Partial<AccountDeviceSync>) =>
        set((s) => {
          const current = s.accounts[registryId] ?? emptyAccountDeviceSync();
          return { accounts: { ...s.accounts, [registryId]: { ...current, ...change(current) } } };
        });

      return {
        accounts: {},
        update: (registryId, patch) => edit(registryId, () => patch),
        recordRunStatus: (registryId, authority, status) =>
          edit(registryId, (current) => ({ lastRun: { ...current.lastRun, [authority]: status } })),
        recordKnownState: (registryId, jmapAccountId, type, state) =>
          edit(registryId, (current) => {
            const known = current.knownStates ?? {};
            return {
              knownStates: { ...known, [jmapAccountId]: { ...(known[jmapAccountId] ?? {}), [type]: state } },
            };
          }),
        forget: (registryId) =>
          set((s) => {
            const { [registryId]: _gone, ...rest } = s.accounts;
            return { accounts: rest };
          }),

        setEnabled: (registryId, authority, on) =>
          edit(registryId, (current) => ({ enabled: { ...current.enabled, [authority]: on } })),
        setCollectionSelected: (registryId, authority, key, on) =>
          edit(registryId, (current) => {
            const field = selectionField(authority);
            return { [field]: { ...current[field], [key]: on } };
          }),
        setNewContactsAddressBook: (registryId, key) =>
          edit(registryId, () => ({ newContactsAddressBook: key ?? undefined })),
        setIntervalSeconds: (registryId, authority, seconds) =>
          edit(registryId, (current) => ({
            intervalSeconds: { ...current.intervalSeconds, [authority]: Math.max(0, Math.round(seconds)) },
          })),
        setReminderOwner: (registryId, owner) => edit(registryId, () => ({ reminderOwner: owner })),
        setRemovedInAndroidSettings: (registryId, removed) =>
          edit(registryId, () => ({ removedInAndroidSettings: removed || undefined })),
        setAndroidAccountName: (registryId, name) => edit(registryId, () => ({ androidAccountName: name })),
        rememberPrimaryJmapAccount: (registryId, authority, jmapAccountId) =>
          edit(registryId, (current) => ({
            primaryJmapAccounts: { ...current.primaryJmapAccounts, [authority]: jmapAccountId },
          })),
      };
    },
    {
      name: DEVICE_SYNC_STORAGE_KEY,
      storage: createPersistStorage({ writeDelayMs: 0 }),
      partialize: (state) => ({ accounts: state.accounts }),
      merge: (persisted, current) => {
        const stored = (persisted as { accounts?: unknown } | undefined)?.accounts;
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return current;
        const accounts: Record<string, AccountDeviceSync> = {};
        for (const [id, value] of Object.entries(stored as Record<string, unknown>)) {
          const entry = sanitizeEntry(value);
          if (entry) accounts[id] = entry;
        }
        return { ...current, accounts };
      },
    },
  ),
);

/** Resolves once the persisted state has been read (at once when it already was). */
export function waitForDeviceSyncHydration(): Promise<void> {
  if (useDeviceSyncStore.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useDeviceSyncStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });
}

/** One account's entry, or the empty default. */
export function accountDeviceSync(registryId: string): AccountDeviceSync {
  return useDeviceSyncStore.getState().accounts[registryId] ?? emptyAccountDeviceSync();
}

/** The engine's view of one account's preferences. */
export function accountSyncPrefs(registryId: string): AccountSyncPrefs {
  const a = accountDeviceSync(registryId);
  return {
    contactsSelection: a.contactsSelection,
    calendarSelection: a.calendarSelection,
    newContactsAddressBook: a.newContactsAddressBook,
    reminderOwner: a.reminderOwner ?? 'device',
  };
}

// ─── Selection ─────────────────────────────────────────

/** The explicit choices for an authority's collections. */
export function selectionFor(entry: AccountDeviceSync, authority: Authority): Record<CollectionKey, boolean> {
  return entry[selectionField(authority)] ?? {};
}

/** What the default rule needs to know about a collection. */
export interface SelectableCollection {
  key: CollectionKey;
  isPersonal: boolean;
  name?: string | null;
}

/**
 * Whether a collection syncs: the explicit choice when there is one, else the
 * engine's default (`collectionDefaultOn`): the personal account's
 * collections on, shared ones and the Trusted Senders address book off.
 */
export function isCollectionSelected(
  selection: Record<CollectionKey, boolean>,
  authority: Authority,
  collection: SelectableCollection,
): boolean {
  const explicit = selection[collection.key];
  return typeof explicit === 'boolean' ? explicit : collectionDefaultOn(collection.isPersonal, authority, collection.name);
}

/** The keys of the collections that sync, out of those the server lists. */
export function effectiveSelection(
  entry: AccountDeviceSync,
  authority: Authority,
  collections: ReadonlyArray<SelectableCollection>,
): CollectionKey[] {
  const selection = selectionFor(entry, authority);
  return collections.filter((c) => isCollectionSelected(selection, authority, c)).map((c) => c.key);
}

/** The periodic sync interval of an authority in seconds (0 = manual only). */
export function intervalFor(entry: AccountDeviceSync, authority: Authority): number {
  const seconds = entry.intervalSeconds?.[authority];
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_INTERVAL_SECONDS;
}

// ─── Echoes and routes ─────────────────────────────────

/** True when the engine already synced exactly this state (a StateChange that is our own echo). */
export function isKnownState(registryId: string, jmapAccountId: string, type: string, state: string): boolean {
  return useDeviceSyncStore.getState().accounts[registryId]?.knownStates?.[jmapAccountId]?.[type] === state;
}

/**
 * The JMAP accounts whose data feeds this account's Android account for an
 * authority, as far as the app knows: the personal one, every account the
 * engine synced a state of, and every account a collection was explicitly
 * picked in.
 */
export function feedingJmapAccounts(entry: AccountDeviceSync, authority: Authority): string[] {
  const out = new Set<string>();
  const primary = entry.primaryJmapAccounts?.[authority];
  if (primary) out.add(primary);
  const types = STATE_TYPES_BY_AUTHORITY[authority];
  for (const [jmapAccountId, states] of Object.entries(entry.knownStates ?? {})) {
    if (states && types.some((type) => type in states)) out.add(jmapAccountId);
  }
  for (const [key, on] of Object.entries(selectionFor(entry, authority))) {
    const slash = key.indexOf('/');
    if (on && slash > 0) out.add(key.slice(0, slash));
  }
  return [...out].sort();
}

export interface PushRoute {
  accountName: string;
  authorities: Authority[];
}

/**
 * Routes for the native push router: every JMAP account id that feeds an
 * Android account, with the account and the authorities to sync.
 */
export function computePushRoutes(accounts: Record<string, AccountDeviceSync>): Record<string, PushRoute[]> {
  const routes: Record<string, PushRoute[]> = {};
  for (const registryId of Object.keys(accounts).sort()) {
    const entry = accounts[registryId];
    const accountName = entry.androidAccountName;
    if (!accountName) continue;
    for (const authority of AUTHORITIES) {
      if (!syncOnInApp(entry, authority)) continue;
      for (const jmapAccountId of feedingJmapAccounts(entry, authority)) {
        const list = (routes[jmapAccountId] ??= []);
        let route = list.find((r) => r.accountName === accountName);
        if (!route) {
          route = { accountName, authorities: [] };
          list.push(route);
        }
        if (!route.authorities.includes(authority)) route.authorities.push(authority);
      }
    }
  }
  return routes;
}

/** Whether any authority of the account is on in the app. */
export function anySyncOnInApp(entry: AccountDeviceSync | undefined): boolean {
  return AUTHORITIES.some((authority) => syncOnInApp(entry, authority));
}
