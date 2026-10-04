import AsyncStorage from '@react-native-async-storage/async-storage';

// One message delivered to several accounts on this phone would ring once per
// account. The first account to alert rings; a different account alerting
// within the window shows its notification without a sound. The window runs
// from the last audible alert and silent ones do not extend it, so a steady
// trickle still rings every so often. Same rules as the webmail's service
// worker (public/sw.js, withinQuietWindow).
export const QUIET_WINDOW_MS = 30_000;

const LAST_ALERT_KEY = 'push:lastAlert:v1';

/** True when a different account alerted audibly less than QUIET_WINDOW_MS ago. */
export async function shouldStaySilent(accountId: string, now = Date.now()): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(LAST_ALERT_KEY);
    if (!raw) return false;
    const last = JSON.parse(raw) as { at?: unknown; accountId?: unknown } | null;
    const at = Number(last?.at);
    return !!at && last?.accountId !== accountId && now - at >= 0 && now - at < QUIET_WINDOW_MS;
  } catch {
    // Without the store every notification rings.
    return false;
  }
}

/** Notes an audible alert. Not for silent ones: they must not extend the window. */
export async function recordAlert(accountId: string, now = Date.now()): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_ALERT_KEY, JSON.stringify({ at: now, accountId }));
  } catch {
    // Best effort: the next alert then rings.
  }
}
