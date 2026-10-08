import { jmapClient } from '../api/jmap-client';
import { useSettingsStore } from '../stores/settings-store';
import { generateAccountId } from './account-utils';
import {
  getStoredRelayBaseUrl,
  hasNotificationPermission,
  readPushAccountIds,
  renewDetachedPushSubscription,
  resyncPushNotifications,
} from './push-notifications';
import { readLastRenewAttempt, recordRenewAttempt, resetRenewAttemptMemory } from './push-renewal-state';

// Keeps every account's push subscription alive while the app goes on being
// resumed rather than launched. Stalwart clamps `expires` to 7 days, and the
// launch-time resync only ever reaches the active account, so a phone left in
// the background for a week - or any account but the active one - would stop
// getting notifications without a word.

// Once a day is enough: with Stalwart's 7-day ceiling every run renews, so
// this is what keeps a resume from costing a round-trip per account.
const RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000;
// After a failed attempt: soon again, but not on every resume.
const RENEW_RETRY_MS = 15 * 60 * 1000;

let inFlight: Promise<void> | null = null;

function activePushAccountId(): string | null {
  const username = jmapClient.username;
  const serverUrl = jmapClient.serverUrl;
  return username && serverUrl ? generateAccountId(username, serverUrl) : null;
}

// 'failed' only when the attempt threw (the server or relay was unreachable);
// every settled answer - renewed, nothing to do, push left off - waits a day.
// Null when there was nothing to attempt.
async function renewAccount(accountId: string): Promise<'renewed' | 'fine' | 'failed' | null> {
  if (accountId !== activePushAccountId()) {
    return renewDetachedPushSubscription(accountId);
  }
  const relayBaseUrl = await getStoredRelayBaseUrl(accountId);
  if (!relayBaseUrl) return null;
  try {
    // The resync asks for the permission when it's missing; a renewal never
    // prompts. Push for the account comes back with the next setup.
    if (!(await hasNotificationPermission())) return 'fine';
    // Null (opted out, or revoked) is a settled answer too, not a failure.
    await resyncPushNotifications({
      relayBaseUrl,
      accountLabel: jmapClient.username ?? undefined,
    });
    return 'renewed';
  } catch (error) {
    console.warn('[push] renewal failed:', error instanceof Error ? error.message : error);
    return 'failed';
  }
}

async function renewDue(now: number): Promise<void> {
  for (const accountId of await readPushAccountIds()) {
    const last = await readLastRenewAttempt(accountId);
    // An attempt "in the future" means the clock went back since: due.
    if (last !== null && last <= now && now - last < RENEW_INTERVAL_MS) continue;
    const outcome = await renewAccount(accountId);
    if (outcome === null) continue;
    // A failure is recorded as if it had happened RENEW_RETRY_MS short of a
    // day ago, so it falls due again after RENEW_RETRY_MS.
    await recordRenewAttempt(
      accountId,
      outcome === 'failed' ? now - RENEW_INTERVAL_MS + RENEW_RETRY_MS : now,
    );
  }
}

/**
 * Note that the account's subscription was just brought up to date some
 * other way (the launch-time resync), so the next resume leaves it for a day.
 */
export function markPushRenewed(accountId: string, now = Date.now()): void {
  void recordRenewAttempt(accountId, now);
}

/**
 * Renew the push subscription of every account that has one, at most once a
 * day each (15 minutes after a failed attempt). Called when the app comes to
 * the foreground; overlapping calls share one run. Does nothing while email
 * notifications are off: the subscriptions are left to lapse.
 */
export function renewPushOnResume(now = Date.now()): Promise<void> {
  if (!useSettingsStore.getState().emailNotificationsEnabled) return Promise.resolve();
  if (inFlight) return inFlight;
  const run = renewDue(now).finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

// Test hook: forget the attempts made during this run of the app.
export function resetPushRenewalState(): void {
  resetRenewAttemptMemory();
}
