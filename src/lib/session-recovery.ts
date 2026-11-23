/**
 * Bringing the session back up after it failed to come up: a session
 * discovery the server refused (Stalwart's maxConcurrentRequests in the burst
 * of a launch, #172), a server that could not be reached, a network that was
 * off. The account then stays on what is cached for it with no live session,
 * and nothing that needs one (push, the foreground refresh, a pull to
 * refresh) reaches the server. retrySession loads it again; this decides when.
 */
import { AppState, type AppStateStatus } from 'react-native';
import { useAuthStore } from '../stores/auth-store';
import { useNetworkStore } from '../stores/network-store';

let running: Promise<void> | null = null;

/**
 * Loads the active account's session again when it has none. Resolves once
 * that attempt ended, whatever its outcome; at once with a live session.
 * Calls that come while one runs share it.
 */
export function recoverSession(): Promise<void> {
  const { activeAccountId, session } = useAuthStore.getState();
  if (!activeAccountId || session) return Promise.resolve();
  if (!running) {
    running = useAuthStore.getState().retrySession()
      .then(() => undefined, () => undefined)
      .finally(() => { running = null; });
  }
  return running;
}

/** `load` after recoverSession: a pull to refresh that also reconnects. */
export async function refreshWithSession<T>(load: () => Promise<T>): Promise<T> {
  await recoverSession();
  return load();
}

/**
 * Tries again whenever the app comes to the foreground or the network comes
 * back, while signed in. Returns the stop function.
 */
export function watchSessionRecovery(): () => void {
  let last: AppStateStatus = AppState.currentState;
  const appState = AppState.addEventListener('change', (next) => {
    const cameBack = next === 'active' && last !== 'active';
    last = next;
    if (cameBack) void recoverSession();
  });
  const stopNetwork = useNetworkStore.subscribe((state, prev) => {
    if (state.online && !prev.online) void recoverSession();
  });
  return () => {
    appState.remove();
    stopNetwork();
  };
}
