import type { JMAPSession } from '../api/types';
import { useCalendarStore } from '../stores/calendar-store';
import { useCalendarSubscriptionsStore } from '../stores/calendar-subscriptions-store';
import { useContactsStore } from '../stores/contacts-store';
import { useEmailStore } from '../stores/email-store';
import { t } from '../stores/locale-store';
import { useOfflineCacheStore } from '../stores/offline-cache-store';
import { useOutboxStore } from '../stores/outbox-store';
import { flushPersistedWrites } from '../stores/persist-storage';
import { useSettingsStore } from '../stores/settings-store';
import { toast } from '../stores/toast-store';
import { clearBodyHeights } from './body-heights';
import { clearBodyDocuments } from './email-body-document';
import { clearEmailDetailCache } from './email-detail-cache';
import { forgetPushServerState, forgetPushSubscriptionExpiry } from './push-notifications';
import {
  primaryAccountId,
  readServerFingerprint,
  readServerPrimaryAccountId,
  sessionFingerprint,
  writeServerFingerprint,
} from './server-fingerprint';

// The app keeps a lot across launches that only means something on the
// server it came from: JMAP states and query states, message ids in the
// offline cache and the outbox, calendar occurrence ids. When the server
// behind an account is replaced - Stalwart 1.0 has no migration from 0.16, so
// the way there is a fresh install at the same address - its ids start over
// ("a", "b", ...) and name other objects, and old states may be accepted with
// changes skipped. So each time a session is established, its fingerprint is
// compared with the one recorded for the account, and on a change everything
// derived from the old server is dropped before anything reads it.

/**
 * The JMAP ids the replaced server and the new one gave the account's own
 * data (null when not known). Preferences kept per JMAP account are found by
 * them.
 */
export interface ServerAccountIds {
  previous: string | null;
  next: string | null;
}

/**
 * Drop what the app derived from an account's server. Preferences, templates
 * and tags stay: they are the user's, not the server's. So do the iCal
 * subscriptions, without their mirror calendars. Preferences that name a
 * server object go: the preferred sender identity and the hidden calendars.
 * Every step runs; the first failure is thrown afterwards.
 */
export async function forgetServerDerivedState(
  accountId: string,
  jmapAccountIds: ServerAccountIds = { previous: null, next: null },
): Promise<void> {
  const failures: unknown[] = [];
  const step = async (run: () => unknown): Promise<void> => {
    try {
      await run();
    } catch (err) {
      failures.push(err);
    }
  };

  // Folders, lists, their JMAP states and query states.
  await step(() => useEmailStore.getState().forgetServerState(accountId));
  // The calendar and contacts caches hold the account being signed in: they
  // are reset whenever another account is switched to.
  await step(() => useCalendarStore.getState().reset());
  await step(() => useContactsStore.getState().reset());
  await step(() => {
    clearEmailDetailCache();
    clearBodyDocuments();
    clearBodyHeights();
  });
  // Offline bodies are keyed by message id.
  await step(() => useOfflineCacheStore.getState().clearAccount(accountId));
  // Every queued op names a message by its server id, and a `destroy`
  // replayed against a server that gave the id to another message deletes
  // that one. So the whole queue goes, failed ops too. Offline edits still
  // waiting are lost; a message the user wrote never is: the outbox holds no
  // sends (sending needs a connection, and drafts are saved to the server).
  let droppedOps = 0;
  await step(async () => {
    droppedOps = await useOutboxStore.getState().clearAccount(accountId);
  });
  await step(() => forgetPushServerState(accountId));
  // Calendar ids start over as well: a subscription's mirror id may name
  // another calendar now, which its next sync would fill and "Remove" would
  // destroy. Each gets a new mirror instead.
  await step(() => useCalendarSubscriptionsStore.getState().unlinkAccount(accountId, jmapAccountIds));
  await step(() => useCalendarStore.getState().forgetHiddenCalendars());
  // Identity ids too (live: "b" is usera@ on 0.16.23, team@ on 1.0), and the
  // preference would send from another address.
  await step(() => useSettingsStore.getState().forgetPreferredIdentities(
    [jmapAccountIds.previous, jmapAccountIds.next].filter((id): id is string => !!id),
  ));
  // Get the emptied caches onto disk before the new fingerprint is.
  await step(() => flushPersistedWrites());

  announceDiscardedChanges(droppedOps);
  if (failures.length > 0) throw failures[0];
}

function announceDiscardedChanges(count: number): void {
  if (count <= 0) return;
  toast.warning(t(
    'offline.discarded_changes',
    '{count, plural, one {# offline change was} other {# offline changes were}} discarded because the mail server changed',
    { count },
  ));
}

/**
 * The first sight of an account: no build before this one recorded its
 * server, so nothing tells whether it was replaced before this one ran (an
 * update of the app and a reinstall for Stalwart 1.0 can fall together).
 * The caches stay, as they do while the server stays the same; dropping them
 * would cost everyone who updates a full download. What would act on the
 * server by itself goes:
 * - the outbox. Its ops replay on their own, and on a replaced server an id
 *   names another message: a queued delete deletes that one. Nothing proves
 *   an op was made on this server: the queue records no server, a
 *   reinstalled Stalwart may accept the old JMAP states, and a queued move
 *   or delete took its message out of the cached list, so there is no copy
 *   to compare the server's message under that id with. Offline edits of
 *   whoever updates with some still unsent are lost, and announced.
 * - the push subscription's recorded expiry. A replaced server holds no
 *   subscription, which the resync would take for a revocation and turn
 *   push off for good; without the expiry it re-creates it.
 * Every step runs; the first failure is thrown afterwards.
 */
async function forgetUnconfirmedServerState(accountId: string): Promise<void> {
  const failures: unknown[] = [];
  let droppedOps = 0;
  try {
    droppedOps = await useOutboxStore.getState().clearAccount(accountId);
  } catch (err) {
    failures.push(err);
  }
  try {
    await forgetPushSubscriptionExpiry(accountId);
  } catch (err) {
    failures.push(err);
  }
  announceDiscardedChanges(droppedOps);
  if (failures.length > 0) throw failures[0];
}

/**
 * Compare the session with the fingerprint recorded for the local account
 * (username@host) and drop what was derived from the server when it changed.
 * On the first sight of an account only what can't be confirmed to belong
 * to its server goes (forgetUnconfirmedServerState). The fingerprint is
 * written after that, so an interrupted drop is repeated next time. A
 * recorded fingerprint that cannot be read rejects before anything goes or
 * is written, and the next session checks again. Resolves to true when
 * caches were dropped.
 */
export async function reconcileServerFingerprint(accountId: string, session: JMAPSession): Promise<boolean> {
  const next = sessionFingerprint(session);
  const recorded = await readServerFingerprint(accountId);
  const primary = primaryAccountId(session);
  if (recorded === next) {
    // Recorded by a build that kept no primary account id with it.
    if (primary && (await readServerPrimaryAccountId(accountId)) === null) {
      await writeServerFingerprint(accountId, next, primary);
    }
    return false;
  }
  if (recorded !== null) {
    console.warn(`[server-change] ${accountId}: the server changed, dropping what was read from the old one`);
    await forgetServerDerivedState(accountId, {
      previous: await readServerPrimaryAccountId(accountId),
      next: primary || null,
    });
  } else {
    await forgetUnconfirmedServerState(accountId);
  }
  await writeServerFingerprint(accountId, next, primary);
  return recorded !== null;
}
