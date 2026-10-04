import AsyncStorage from '@react-native-async-storage/async-storage';
import { jmapClient } from '../api/jmap-client';
import { generateAccountId } from './account-utils';
import {
  getStoredRelayBaseUrl,
  readPushAccountIds,
  renewDetachedPushSubscription,
  resyncPushNotifications,
} from './push-notifications';

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
const LAST_RENEW_ATTEMPT_PREFIX = 'push:lastRenewAttempt:v1:';

// When each account was last attempted; a failure is recorded as if it had
// happened RENEW_INTERVAL_MS - RENEW_RETRY_MS earlier, so it falls due again
// after RENEW_RETRY_MS. Mirrored to storage so a restart doesn't reset it.
const lastAttemptAt = new Map<string, number>();
let inFlight: Promise<void> | null = null;

function lastRenewAttemptKey(accountId: string): string {
  return LAST_RENEW_ATTEMPT_PREFIX + accountId;
}

async function readLastAttempt(accountId: string): Promise<number | null> {
  const remembered = lastAttemptAt.get(accountId);
  if (remembered !== undefined) return remembered;
  const stored = Number(await AsyncStorage.getItem(lastRenewAttemptKey(accountId)));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

async function recordAttempt(accountId: string, at: number): Promise<void> {
  lastAttemptAt.set(accountId, at);
  await AsyncStorage.setItem(lastRenewAttemptKey(accountId), String(at)).catch(() => undefined);
}

function activePushAccountId(): string | null {
  const username = jmapClient.username;
  const serverUrl = jmapClient.serverUrl;
  return username && serverUrl ? generateAccountId(username, serverUrl) : null;
}

// True when the account's subscription is in order; false to retry soon.
// Null when there was nothing to attempt.
async function renewAccount(accountId: string): Promise<boolean | null> {
  if (accountId !== activePushAccountId()) {
    return renewDetachedPushSubscription(accountId);
  }
  const relayBaseUrl = await getStoredRelayBaseUrl();
  if (!relayBaseUrl) return null;
  try {
    // Null (opted out, or revoked) is a settled answer too, not a failure.
    await resyncPushNotifications({
      relayBaseUrl,
      accountLabel: jmapClient.username ?? undefined,
    });
    return true;
  } catch (error) {
    console.warn('[push] renewal failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

async function renewDue(now: number): Promise<void> {
  for (const accountId of await readPushAccountIds()) {
    const last = await readLastAttempt(accountId);
    if (last !== null && now - last < RENEW_INTERVAL_MS) continue;
    const renewed = await renewAccount(accountId);
    if (renewed === null) continue;
    await recordAttempt(accountId, renewed ? now : now - RENEW_INTERVAL_MS + RENEW_RETRY_MS);
  }
}

/**
 * Renew the push subscription of every account that has one, at most once a
 * day each (15 minutes after a failed attempt). Called when the app comes to
 * the foreground; overlapping calls share one run.
 */
export function renewPushOnResume(now = Date.now()): Promise<void> {
  if (inFlight) return inFlight;
  const run = renewDue(now).finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

// Test hook: forget the attempts made during this run of the app.
export function resetPushRenewalState(): void {
  lastAttemptAt.clear();
}
