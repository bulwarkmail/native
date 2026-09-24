import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEmailStore } from '../stores/email-store';
import { useContactsStore } from '../stores/contacts-store';
import { useCalendarStore } from '../stores/calendar-store';

// Persisted, server-derived caches (Zustand persist names). The "Refresh
// cached data" action drops these so a stale or wrong-account view can be
// fixed WITHOUT signing out (which would drop the whole account list).
// Mirrors the webmail's lib/clear-cached-data.ts.
//
// Deliberately excluded: 'account-registry' (accounts), 'webmail:settings:v1'
// / 'webmail:locale:v1' (preferences), 'webmail:templates:v1' /
// 'webmail:keywords:v1' / 'calendar-subscriptions' (user-created content),
// the offline body cache (managed on its own pane) and push registrations.
export const CACHE_STORAGE_KEYS = [
  'email-cache',
  'contacts-cache',
  'calendar-cache',
  'webmail:calendar:hidden:v1',
  'webmail:contacts:category:v1',
];

/**
 * Clear cached, server-derived data (mail list snapshots, contacts,
 * calendars) and re-fetch everything for the active account. Accounts and
 * sessions are preserved.
 */
export async function clearCachedData(): Promise<void> {
  // Through the stores first: their storage drops any pending write and
  // forgets what it last wrote, so the re-fetched data is written back even
  // where it matches the old cache.
  for (const store of [useEmailStore, useContactsStore, useCalendarStore]) {
    store.persist.clearStorage();
  }
  try {
    await AsyncStorage.multiRemove(CACHE_STORAGE_KEYS);
  } catch {
    // storage errors are non-fatal - the re-fetch below still refreshes state
  }
  const results = await Promise.allSettled([
    useEmailStore.getState().fetchMailboxes().then(() => useEmailStore.getState().refreshEmails()),
    useContactsStore.getState().refresh(),
    useCalendarStore.getState().refresh(),
  ]);
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) {
    throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
  }
}
