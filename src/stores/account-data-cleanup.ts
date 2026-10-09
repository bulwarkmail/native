// What signing an account out forgets on the device: its offline message
// bodies, cached sending identities, folder icons and calendar subscriptions and, with the last account, every calendar
// subscription (ownerless ones included) and the search history. Unsent outbox
// changes are kept; queued sends are kept unless discardQueuedSends is set. Settings, locale, templates and keywords stay, as in the
// webmail's sign-out cleanup.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useOfflineCacheStore } from './offline-cache-store';
import { useOutboxStore } from './outbox-store';
import { useSendQueueStore } from './send-queue-store';
import { useCalendarSubscriptionsStore, subscriptionOwner } from './calendar-subscriptions-store';
import { useSearchHistoryStore } from './search-history-store';
import { useFolderIconsStore } from './folder-icons-store';
import { removeIdentityCache } from '../lib/identity-cache';

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
 * How long one cleanup step is waited for before the next one runs. A storage
 * call that never settles must not keep the later steps (the calendar
 * subscriptions, whose feed URLs can be secret) from running. Longer than a
 * sign-out and a sign-in wait for a cleanup together (auth-store), so a step
 * that hangs is still in flight when the account returns; the steps after it
 * then see `stillGone` false.
 */
export const CLEANUP_STEP_TIMEOUT_MS = 15_000;

/**
 * Run one cleanup step, logging a failure instead of throwing, so a step that
 * fails (storage full, a corrupt entry) or never settles does not skip the
 * steps after it.
 */
async function step(run: () => unknown): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.warn('[sign-out] cleanup step still running, going on without it');
        resolve();
      }, CLEANUP_STEP_TIMEOUT_MS);
    });
    await Promise.race([Promise.resolve().then(run), late]);
  } catch (e) {
    console.warn('[sign-out] cleanup failed', e);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Data that is not kept per account: forgotten once no account is signed in.
 * `stillGone` is checked before each step: false once an account signs in.
 */
export async function forgetSharedData(stillGone: () => boolean = () => true): Promise<void> {
  // Ownerless subscriptions belong to no login, and their feed URLs can be secret.
  if (stillGone()) await step(() => useCalendarSubscriptionsStore.setState({ subscriptions: [] }));
  if (stillGone()) await step(() => useSearchHistoryStore.getState().clearRecentSearches());
}

export interface ForgetOptions {
  /**
   * Whether no account is signed in any more: forgetSharedData runs as well.
   * A function is read when that step is reached, not when the cleanup starts.
   */
  lastAccount?: boolean | (() => boolean);
  discardQueuedSends?: boolean;
  /**
   * Checked before every step: false once the account signs in again (the
   * app account id is the same), and the cleanup stops there, so a cleanup
   * still running in the background never forgets the live account's data.
   */
  stillGone?: () => boolean;
}

/**
 * Forget what the device keeps for one signed-out account. With `lastAccount`
 * it also runs forgetSharedData: every calendar subscription goes, including
 * ownerless ones and other logins', and so does the search history.
 */
export async function forgetAccountData(
  account: SignedOutAccount,
  opts: ForgetOptions = {},
): Promise<void> {
  const gone = opts.stillGone ?? (() => true);
  // Each step only while the account is still signed out.
  const guarded = (run: () => unknown) => (gone() ? step(run) : Promise.resolve());
  await guarded(() => useOfflineCacheStore.getState().clearAccount(account.appAccountId));
  await guarded(() => removeIdentityCache(account.appAccountId));
  await guarded(async () => {
    useFolderIconsStore.getState().forgetAccount(account.appAccountId);
    // The forget is written once the stored icons are read. A read that
    // fails would leave them on disk until some later change, so read again
    // (once) before moving on.
    for (let attempt = 0; attempt < 2 && !useFolderIconsStore.getState().hydrated; attempt++) {
      await useFolderIconsStore.getState().hydrate();
    }
  });
  await guarded(async () => {
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
    await guarded(() => useSendQueueStore.getState().clearAccount(account.appAccountId));
  } else {
    // Kept rows are not actionable while signed out: drop them from memory
    // so the Outbox and the counts do not offer them.
    await guarded(() => useSendQueueStore.getState().unloadAccount(account.appAccountId));
  }
  const { serverUrl, username } = account;
  if (serverUrl && username) {
    await guarded(() => useCalendarSubscriptionsStore.getState().forgetSubscriptions(
      subscriptionOwner(serverUrl, username),
    ));
  }
  const last = typeof opts.lastAccount === 'function' ? opts.lastAccount : () => !!opts.lastAccount;
  if (gone() && last()) await forgetSharedData(() => gone() && last());
}
