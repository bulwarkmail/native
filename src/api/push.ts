import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { PushSubscription, StateChange } from './types';

export type StateChangeHandler = (change: StateChange) => void;

// ─── PushSubscription (RFC 8620 §7.2) ───────────────────

export async function listPushSubscriptions(): Promise<PushSubscription[]> {
  const res = await jmapClient.request(
    [['PushSubscription/get', { ids: null }, '0']],
    [CAPABILITIES.CORE],
  );
  const [, body] = res.methodResponses[0] ?? [];
  return (body?.list as PushSubscription[]) ?? [];
}

/**
 * Create a PushSubscription pointing the JMAP server at the given relay URL.
 * Returns the server-assigned id (which the client also registers with the
 * relay so the relay can route incoming pushes to an Expo token).
 */
export async function createPushSubscription(params: {
  deviceClientId: string;
  url: string;
  types: string[];
  // ISO date. Servers may clamp to their own ceiling - we send the maximum we
  // want and accept whatever Stalwart returns.
  expires?: string;
}): Promise<string> {
  const created: Record<string, unknown> = {
    deviceClientId: params.deviceClientId,
    url: params.url,
    types: params.types,
  };
  if (params.expires) created.expires = params.expires;

  const res = await jmapClient.request(
    [
      [
        'PushSubscription/set',
        { create: { new: created } },
        '0',
      ],
    ],
    [CAPABILITIES.CORE],
  );
  const [, body] = res.methodResponses[0] ?? [];
  const result = body?.created?.new as { id?: string } | undefined;
  if (!result?.id) {
    const notCreated = body?.notCreated?.new;
    throw new Error(
      `PushSubscription/set create failed: ${JSON.stringify(notCreated ?? body)}`,
    );
  }
  return result.id;
}

/**
 * Push the subscription's expiry forward (RFC 8620 §7.2.1). Returns false if
 * the server rejected the update (e.g. the subscription no longer exists),
 * which the caller treats as a signal to recreate.
 */
export async function updatePushSubscription(
  id: string,
  patch: { expires?: string; types?: string[] },
): Promise<boolean> {
  const res = await jmapClient.request(
    [
      [
        'PushSubscription/set',
        { update: { [id]: patch } },
        '0',
      ],
    ],
    [CAPABILITIES.CORE],
  );
  const [, body] = res.methodResponses[0] ?? [];
  if (body?.notUpdated?.[id]) return false;
  return body?.updated?.[id] !== undefined;
}

/**
 * Send the verification code back to the server - the call that flips the
 * subscription from pending to active (RFC 8620 §7.2.2).
 */
export async function verifyPushSubscription(
  id: string,
  verificationCode: string,
): Promise<void> {
  const res = await jmapClient.request(
    [
      [
        'PushSubscription/set',
        { update: { [id]: { verificationCode } } },
        '0',
      ],
    ],
    [CAPABILITIES.CORE],
  );
  const [, body] = res.methodResponses[0] ?? [];
  if (body?.notUpdated?.[id]) {
    throw new Error(
      `PushSubscription verification failed: ${JSON.stringify(body.notUpdated[id])}`,
    );
  }
}

export async function destroyPushSubscription(id: string): Promise<void> {
  await jmapClient.request(
    [['PushSubscription/set', { destroy: [id] }, '0']],
    [CAPABILITIES.CORE],
  );
}

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
