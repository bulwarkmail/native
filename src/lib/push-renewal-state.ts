import AsyncStorage from '@react-native-async-storage/async-storage';

// When each account's push subscription was last renewed (see push-renewal).
// Its own module so push-notifications can forget an account's entry along
// with its other push keys without importing push-renewal, which imports it.
const LAST_RENEW_ATTEMPT_PREFIX = 'push:lastRenewAttempt:v1:';

// Mirrored to storage so a restart doesn't reset it.
const lastAttemptAt = new Map<string, number>();

function lastRenewAttemptKey(accountId: string): string {
  return LAST_RENEW_ATTEMPT_PREFIX + accountId;
}

export async function readLastRenewAttempt(accountId: string): Promise<number | null> {
  const remembered = lastAttemptAt.get(accountId);
  if (remembered !== undefined) return remembered;
  const stored = Number(await AsyncStorage.getItem(lastRenewAttemptKey(accountId)));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

export function recordRenewAttempt(accountId: string, at: number): Promise<void> {
  lastAttemptAt.set(accountId, at);
  return AsyncStorage.setItem(lastRenewAttemptKey(accountId), String(at)).catch(() => undefined);
}

export async function clearRenewAttempt(accountId: string): Promise<void> {
  lastAttemptAt.delete(accountId);
  await AsyncStorage.removeItem(lastRenewAttemptKey(accountId));
}

// Test hook: forget the attempts made during this run of the app.
export function resetRenewAttemptMemory(): void {
  lastAttemptAt.clear();
}
