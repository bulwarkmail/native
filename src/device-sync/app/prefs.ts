/**
 * Pure helpers over the persisted device sync preferences, shared by the
 * store (src/stores/device-sync-store.ts) and by code that must not create
 * the store: the push setup reads the persisted JSON straight from
 * AsyncStorage (docs/device-sync.md, "Triggers").
 *
 * Types only; nothing here may import react-native or a store.
 */
import {
  AUTHORITIES,
  CALENDAR_AUTHORITY,
  CONTACTS_AUTHORITY,
  type Authority,
} from '../types';

/** AsyncStorage key of the device sync store (zustand `persist` name). */
export const DEVICE_SYNC_STORAGE_KEY = 'device-sync:v1';

/** The fields that say whether an account syncs an authority. */
export interface SyncSwitches {
  /** Authorities the user turned on in the app. */
  enabled?: Partial<Record<Authority, boolean>>;
  /** The Android account was removed in Android Settings. */
  removedInAndroidSettings?: boolean;
  /** The app dropped the account from its registry; automatic sync is off until the user signs in again. */
  suspended?: boolean;
}

/**
 * Whether the app has device sync on for this authority: turned on in the
 * app and not removed in Android Settings since. Android's own toggle can
 * still pause it (see `getSyncAutomatically`).
 */
export function syncOnInApp(entry: SyncSwitches | undefined | null, authority: Authority): boolean {
  return !!entry && !!entry.enabled?.[authority] && !entry.removedInAndroidSettings && !entry.suspended;
}

/** JMAP data types whose changes a synced authority cares about. */
export const STATE_TYPES_BY_AUTHORITY: Record<Authority, readonly string[]> = {
  [CONTACTS_AUTHORITY]: ['ContactCard', 'AddressBook'],
  [CALENDAR_AUTHORITY]: ['CalendarEvent', 'Calendar'],
};

/** The authority a JMAP data type belongs to, if any. */
export function authorityOfType(type: string): Authority | null {
  for (const authority of AUTHORITIES) {
    if (STATE_TYPES_BY_AUTHORITY[authority].includes(type)) return authority;
  }
  return null;
}

/**
 * Push types device sync adds to an account's push subscription:
 * `ContactCard`, `AddressBook` while contacts sync, `CalendarEvent`,
 * `Calendar` while calendars sync.
 */
export function deviceSyncPushTypes(entry: SyncSwitches | undefined | null): string[] {
  const types: string[] = [];
  for (const authority of AUTHORITIES) {
    if (syncOnInApp(entry, authority)) types.push(...STATE_TYPES_BY_AUTHORITY[authority]);
  }
  return types;
}

/**
 * The persisted accounts map from the store's JSON (`{ state: { accounts } }`),
 * or an empty map when it is missing or unreadable.
 */
export function persistedAccounts(raw: string | null): Record<string, SyncSwitches> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { state?: { accounts?: unknown } } | null;
    const accounts = parsed?.state?.accounts;
    return accounts && typeof accounts === 'object' && !Array.isArray(accounts)
      ? (accounts as Record<string, SyncSwitches>)
      : {};
  } catch {
    return {};
  }
}
