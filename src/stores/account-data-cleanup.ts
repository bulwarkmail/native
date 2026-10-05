// What signing an account out forgets on the device: its offline message
// bodies and calendar subscriptions and, with the last account, every calendar
// subscription (ownerless ones included) and the search history. Unsent outbox
// changes are kept; queued sends are kept unless discardQueuedSends is set. Settings, locale, templates and keywords stay, as in the
// webmail's sign-out cleanup.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useOfflineCacheStore } from './offline-cache-store';
import { useOutboxStore } from './outbox-store';
import { useSendQueueStore } from './send-queue-store';
import { useCalendarSubscriptionsStore, subscriptionOwner } from './calendar-subscriptions-store';
import { useSearchHistoryStore } from './search-history-store';

export interface SignedOutAccount {
  /** Registry id: the key the offline cache and outbox store their data under. */
  appAccountId: string;
  jmapAccountId?: string;
  serverUrl?: string | null;
  username?: string | null;
}

/** Queued sends are kept on disk unless the user chose to delete them. */
export interface SignOutOptions {
  discardQueuedSends?: boolean;
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

/**
 * Run one cleanup step, logging a failure instead of throwing, so a step that
 * fails (storage full, a corrupt entry) does not skip the steps after it.
 */
async function step(run: () => unknown): Promise<void> {
  try {
    await run();
  } catch (e) {
    console.warn('[sign-out] cleanup failed', e);
  }
}

/** Data that is not kept per account: forgotten once no account is signed in. */
export async function forgetSharedData(): Promise<void> {
  // Ownerless subscriptions belong to no login, and their feed URLs can be secret.
  await step(() => useCalendarSubscriptionsStore.setState({ subscriptions: [] }));
  await step(() => useSearchHistoryStore.getState().clearRecentSearches());
}

/**
 * Forget what the device keeps for one signed-out account. With `lastAccount`
 * it also runs forgetSharedData: every calendar subscription goes, including
 * ownerless ones and other logins', and so does the search history.
 */
export async function forgetAccountData(
  account: SignedOutAccount,
  opts: { lastAccount?: boolean; discardQueuedSends?: boolean } = {},
): Promise<void> {
  await step(() => useOfflineCacheStore.getState().clearAccount(account.appAccountId));
  await step(async () => {
    // Queued and failed ops are the user's unsent changes: keep them so they
    // replay when this account signs in again.
    if (await hasUnsentChanges(account.appAccountId)) {
      console.warn('[sign-out] keeping unsent outbox changes for', account.appAccountId);
    } else {
      await useOutboxStore.getState().clearAccount(account.appAccountId);
    }
  });
  // Queued sends stay on disk (orphaned but safe; they return if the account
  // signs in again) unless the user was asked and chose to delete them. Only
  // this account's rows go; clearAccount needs no hydration and bypasses the
  // discard rules.
  if (opts.discardQueuedSends) {
    await step(() => useSendQueueStore.getState().clearAccount(account.appAccountId));
  } else {
    // Kept rows are not actionable while signed out: drop them from memory
    // so the Outbox and the counts do not offer them.
    await step(() => useSendQueueStore.getState().unloadAccount(account.appAccountId));
  }
  const { serverUrl, username } = account;
  if (serverUrl && username) {
    await step(() => useCalendarSubscriptionsStore.getState().forgetSubscriptions(
      subscriptionOwner(serverUrl, username),
    ));
  }
  if (opts.lastAccount) await forgetSharedData();
}
