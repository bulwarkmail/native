import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { StateChange } from './types';

export type StateChangeHandler = (change: StateChange) => void;

/**
 * Connect to the JMAP EventSource (SSE) endpoint for real-time push updates.
 * Returns a cleanup function to close the connection.
 */
export function connectEventSource(
  onStateChange: StateChangeHandler,
): (() => void) | null {
  const session = jmapClient.currentSession;
  if (!session?.eventSourceUrl) return null;

  const url = session.eventSourceUrl
    .replace('{types}', '*')
    .replace('{closeafter}', 'no')
    .replace('{ping}', '30');

  // Use native EventSource or react-native-sse
  const EventSourceImpl = typeof EventSource !== 'undefined'
    ? EventSource
    : require('react-native-sse').default;

  const es = new EventSourceImpl(url, {
    headers: { Authorization: (jmapClient as any).authHeader },
  });

  const handler = (event: any) => {
    try {
      const data: StateChange = JSON.parse(
        typeof event === 'string' ? event : event.data,
      );
      onStateChange(data);
    } catch {
      // Ignore malformed events
    }
  };

  es.addEventListener('state', handler);

  return () => {
    es.removeEventListener('state', handler);
    es.close();
  };
}

/**
 * Polling fallback when SSE is not available.
 * Returns a cleanup function to stop polling.
 */
export function startPolling(
  onStateChange: StateChangeHandler,
  interval = 5000,
): () => void {
  const accountId = jmapClient.accountId;
  const stateCache: Record<string, string> = {};

  const timer = setInterval(async () => {
    try {
      const res = await jmapClient.request(
        [
          ['Mailbox/get', { accountId, ids: [] }, 'm'],
          ['Email/get', { accountId, ids: [] }, 'e'],
        ],
        [CAPABILITIES.CORE, CAPABILITIES.MAIL],
      );

      const changed: Record<string, string> = {};
      for (const [method, result] of res.methodResponses) {
        const type = method.replace('/get', '');
        const newState = result.state;
        if (newState && stateCache[type] && stateCache[type] !== newState) {
          changed[type] = newState;
        }
        if (newState) stateCache[type] = newState;
      }

      if (Object.keys(changed).length > 0) {
        onStateChange({
          '@type': 'StateChange',
          changed: { [accountId]: changed },
        });
      }
    } catch {
      // Silently retry on next interval
    }
  }, interval);

  return () => clearInterval(timer);
}

/**
 * Start real-time updates, preferring SSE with polling fallback.
 */
export function startPushUpdates(
  onStateChange: StateChangeHandler,
): () => void {
  const cleanup = connectEventSource(onStateChange);
  if (cleanup) return cleanup;
  return startPolling(onStateChange);
}
