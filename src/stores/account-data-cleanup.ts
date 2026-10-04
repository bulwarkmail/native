// What signing an account out forgets on the device: its offline message
// bodies, outbox and calendar subscriptions, plus the search history. Settings,
// locale, templates and keywords stay, as in the webmail's sign-out cleanup.

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

export async function forgetAccountData(account: SignedOutAccount): Promise<void> {
  await Promise.all([
    useOfflineCacheStore.getState().clearAccount(account.appAccountId),
    useOutboxStore.getState().clearAccount(account.appAccountId),
  ]);
  if (account.serverUrl && account.username) {
    useCalendarSubscriptionsStore.getState().forgetSubscriptions(
      subscriptionOwner(account.serverUrl, account.username),
    );
  }
  // Not kept per account, so it goes with every sign-out.
  useSearchHistoryStore.getState().clearRecentSearches();
}
