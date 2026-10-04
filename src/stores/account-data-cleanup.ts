// What signing an account out forgets on the device: its offline message
// bodies, calendar subscriptions and, with the last account, the search history.
// Unsent outbox changes are kept. Settings,
// locale, templates and keywords stay, as in the webmail's sign-out cleanup.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useOfflineCacheStore } from './offline-cache-store';
import { useOutboxStore } from './outbox-store';
import { useCalendarSubscriptionsStore, subscriptionOwner } from './calendar-subscriptions-store';
import { useSearchHistoryStore } from './search-history-store';

export interface SignedOutAccount {
  /** Registry id: the key the offline cache and outbox store their data under. */
  appAccountId: string;
  jmapAccountId?: string;
  serverUrl?: string | null;
  username?: string | null;
}

const OUTBOX_KEY_PREFIX = 'webmail:outbox:v1:';

async function hasUnsentChanges(appAccountId: string): Promise<boolean> {
  const outbox = useOutboxStore.getState();
  // Until hydrated the lists are empty placeholders, so read storage.
  if (outbox.activeAccountId === appAccountId && outbox.hydrated) {
    return outbox.entries.length > 0 || outbox.failed.length > 0;
  }
  for (const suffix of ['', ':failed']) {
    try {
      const raw = await AsyncStorage.getItem(`${OUTBOX_KEY_PREFIX}${appAccountId}${suffix}`);
      if (raw && (JSON.parse(raw) as unknown[]).length > 0) return true;
    } catch {
      // Unreadable: treat as having changes rather than risk dropping them.
      return true;
    }
  }
  return false;
}

/** Data that is not kept per account: forgotten once no account is signed in. */
export async function forgetSharedData(): Promise<void> {
  // Ownerless subscriptions belong to no login, and their feed URLs can be secret.
  useCalendarSubscriptionsStore.setState({ subscriptions: [] });
  useSearchHistoryStore.getState().clearRecentSearches();
}

export async function forgetAccountData(
  account: SignedOutAccount,
  opts: { lastAccount?: boolean } = {},
): Promise<void> {
  await useOfflineCacheStore.getState().clearAccount(account.appAccountId);
  // Queued and failed ops are the user's unsent changes: keep them so they
  // replay when this account signs in again.
  if (await hasUnsentChanges(account.appAccountId)) {
    console.warn('[sign-out] keeping unsent outbox changes for', account.appAccountId);
  } else {
    await useOutboxStore.getState().clearAccount(account.appAccountId);
  }
  if (account.serverUrl && account.username) {
    useCalendarSubscriptionsStore.getState().forgetSubscriptions(
      subscriptionOwner(account.serverUrl, account.username),
    );
  }
  if (opts.lastAccount) await forgetSharedData();
}
