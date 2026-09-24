// Live updates from the JMAP EventSource (SSE), with the lifecycle the plain
// `react-native-sse` EventSource lacks:
//
// - reconnect with back-off after a network error (the library only re-polls
//   when the XHR reaches DONE with a status; a dropped socket - iOS
//   suspension, Wi-Fi → cellular - fires `error` with status 0 and then
//   nothing ever happens again);
// - a fresh Authorization header on every (re)connect, and an immediate
//   reconnect when the OAuth token rotates (the library reuses the headers it
//   was constructed with, so after a refresh every retry sent the stale
//   bearer: 401 → error → retry every 5 s forever);
// - a 90 s ping watchdog and a periodic recycle so the accumulated
//   `responseText` cannot grow without bound;
// - fallback to polling when the stream is refused (proxy without SSE, TLS
//   client certificate that XHR cannot present, repeated failures).

import { jmapClient, AuthenticationError } from './jmap-client';
import { CAPABILITIES } from './types';
import type { StateChange } from './types';
import { getClientCertAlias } from '../lib/client-cert';

export type StateChangeHandler = (change: StateChange) => void;

// Server pings every 30 s; consider the stream dead after three missed ones.
const PING_SECONDS = 30;
const PING_TIMEOUT_MS = 90_000;
// Recycle a healthy stream periodically to bound the XHR buffer.
const RECYCLE_MS = 30 * 60_000;
const RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000];
// After this many consecutive failed connects the stream is given up on and
// polling takes over for the rest of the session.
const MAX_CONSECUTIVE_FAILURES = 6;

export const POLL_INTERVAL_MS = 5_000;
export const SLOW_POLL_INTERVAL_MS = 20_000;

interface SseEvent {
  type?: string;
  data?: string;
  message?: string;
  xhrStatus?: number;
}

interface EventSourceLike {
  addEventListener: (type: string, handler: (event: SseEvent) => void) => void;
  removeEventListener: (type: string, handler: (event: SseEvent) => void) => void;
  close: () => void;
}

type EventSourceCtor = new (
  url: string,
  options: { headers: Record<string, string>; pollingInterval?: number; timeoutBeforeConnection?: number },
) => EventSourceLike;

function eventSourceImpl(): EventSourceCtor {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('react-native-sse').default as EventSourceCtor;
}

export interface LiveUpdatesOptions {
  onStateChange: StateChangeHandler;
  onError?: (error: Error) => void;
  /** Called when the stream is abandoned for polling. */
  onFallback?: (reason: string) => void;
  /** Returns false while the app is backgrounded; polling pauses. */
  isActive?: () => boolean;
}

export interface LiveUpdatesHandle {
  /** Tear everything down (stream, timers, polling). */
  close: () => void;
  /** Drop the current stream and connect again (foreground resume). */
  reconnect: () => void;
  /** 'sse' | 'polling' | 'closed' */
  readonly mode: 'sse' | 'polling' | 'closed';
  /**
   * True while the event stream is open and its pings keep arriving (the
   * watchdog drops it after three missed ones): the server is reachable.
   */
  readonly healthy: boolean;
}

function buildEventSourceUrl(template: string): string {
  return template
    .replace('{types}', '*')
    .replace('{closeafter}', 'no')
    .replace('{ping}', String(PING_SECONDS));
}

/**
 * Polling fallback: `Mailbox/get` + `Email/get` with empty id lists return
 * the current state tokens; a change in either is reported as a StateChange
 * for the primary account. One request in flight at a time, paused while
 * backgrounded.
 */
export function startPolling(
  onStateChange: StateChangeHandler,
  interval = POLL_INTERVAL_MS,
  isActive: () => boolean = () => true,
): () => void {
  let accountId: string;
  try {
    accountId = jmapClient.accountId;
  } catch {
    return () => undefined;
  }
  const stateCache: Record<string, string> = {};
  let inFlight = false;
  let stopped = false;

  const tick = async () => {
    if (stopped || inFlight || !isActive()) return;
    if ('isConnected' in jmapClient && !jmapClient.isConnected) return;
    inFlight = true;
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
        if (method === 'error') continue;
        const type = method.replace('/get', '');
        const newState = (result as { state?: string }).state;
        if (newState && stateCache[type] && stateCache[type] !== newState) {
          changed[type] = newState;
        }
        if (newState) stateCache[type] = newState;
      }

      if (Object.keys(changed).length > 0) {
        onStateChange({ '@type': 'StateChange', changed: { [accountId]: changed } });
      }
    } catch {
      // Silently retry on next interval
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, interval);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Start live updates: SSE when the session advertises an eventSourceUrl and
 * no client certificate is in play, polling otherwise. Resolves to a handle
 * that can be closed or told to reconnect.
 */
export async function startLiveUpdates(opts: LiveUpdatesOptions): Promise<LiveUpdatesHandle> {
  const isActive = opts.isActive ?? (() => true);
  const safeOnStateChange: StateChangeHandler = (change) => {
    try {
      opts.onStateChange(change);
    } catch (err) {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  let mode: 'sse' | 'polling' | 'closed' = 'closed';
  let stopPolling: (() => void) | null = null;
  let es: EventSourceLike | null = null;
  let esHandlers: Array<[string, (event: SseEvent) => void]> = [];
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let recycleTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;
  let closed = false;
  let streamOpen = false;
  let unsubscribeTokenRefresh: (() => void) | null = null;

  const session = jmapClient.currentSession;
  const template = session?.eventSourceUrl;
  const certAlias = await getClientCertAlias().catch(() => null);

  const clearTimers = () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    if (recycleTimer) { clearTimeout(recycleTimer); recycleTimer = null; }
  };

  const dropStream = () => {
    streamOpen = false;
    if (es) {
      for (const [type, handler] of esHandlers) {
        try { es.removeEventListener(type, handler); } catch { /* ignore */ }
      }
      esHandlers = [];
      try { es.close(); } catch { /* ignore */ }
      es = null;
    }
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    if (recycleTimer) { clearTimeout(recycleTimer); recycleTimer = null; }
  };

  const fallbackToPolling = (reason: string) => {
    if (closed) return;
    dropStream();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (mode !== 'polling') {
      mode = 'polling';
      opts.onFallback?.(reason);
      stopPolling = startPolling(safeOnStateChange, SLOW_POLL_INTERVAL_MS, isActive);
    }
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      fallbackToPolling('stream failed repeatedly');
      return;
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(consecutiveFailures, RECONNECT_DELAYS_MS.length - 1)];
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  };

  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      // No ping for 90 s: the socket is dead even though the XHR never said so.
      dropStream();
      consecutiveFailures += 1;
      scheduleReconnect();
    }, PING_TIMEOUT_MS);
  };

  const connect = async () => {
    if (closed || !template) return;
    if (!isActive()) return; // resumed later by reconnect()
    dropStream();
    try {
      await jmapClient.ensureFreshToken();
    } catch {
      // the 401 path below handles a stale token
    }
    let authHeader: string;
    try {
      authHeader = jmapClient.authHeader;
    } catch {
      return;
    }
    const url = buildEventSourceUrl(template);
    let source: EventSourceLike;
    try {
      const Impl = eventSourceImpl();
      // pollingInterval 0 disables the library's own re-poll on DONE; every
      // reconnect goes through scheduleReconnect so headers stay fresh.
      source = new Impl(url, {
        headers: { Authorization: authHeader },
        pollingInterval: 0,
        timeoutBeforeConnection: 0,
      });
    } catch (err) {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      consecutiveFailures += 1;
      scheduleReconnect();
      return;
    }
    es = source;
    mode = 'sse';

    const on = (type: string, handler: (event: SseEvent) => void) => {
      source.addEventListener(type, handler);
      esHandlers.push([type, handler]);
    };

    on('open', () => {
      consecutiveFailures = 0;
      streamOpen = es === source;
      armWatchdog();
      if (recycleTimer) clearTimeout(recycleTimer);
      recycleTimer = setTimeout(() => {
        if (closed || es !== source) return;
        dropStream();
        void connect();
      }, RECYCLE_MS);
    });
    on('ping', () => armWatchdog());
    on('state', (event) => {
      armWatchdog();
      try {
        const data: StateChange = JSON.parse(typeof event === 'string' ? event : event.data ?? '');
        safeOnStateChange(data);
      } catch {
        // Ignore malformed events
      }
    });
    on('close', () => {
      if (closed || es !== source) return;
      dropStream();
      scheduleReconnect();
    });
    on('error', (event) => {
      if (closed || es !== source) return;
      dropStream();
      const status = event?.xhrStatus ?? 0;
      if (status === 401) {
        // Stale bearer: refresh and come straight back with the new header.
        void jmapClient.forceRefreshToken().then(
          (refreshed) => {
            if (closed) return;
            if (refreshed) {
              consecutiveFailures = 0;
              void connect();
            } else {
              consecutiveFailures += 1;
              opts.onError?.(new AuthenticationError('Live updates rejected: session expired'));
              scheduleReconnect();
            }
          },
          () => {
            consecutiveFailures += 1;
            scheduleReconnect();
          },
        );
        return;
      }
      if (status >= 400) {
        // The endpoint answered but refused the stream (proxy without SSE,
        // rate limit, server error): don't hammer it.
        consecutiveFailures += 2;
        opts.onError?.(new Error(`Live updates stream refused: ${status}`));
        scheduleReconnect();
        return;
      }
      // status 0: socket dropped / no network. Back off and retry.
      consecutiveFailures += 1;
      scheduleReconnect();
    });
  };

  if (!template || certAlias) {
    mode = 'polling';
    opts.onFallback?.(certAlias ? 'client certificate in use' : 'server has no eventSourceUrl');
    stopPolling = startPolling(safeOnStateChange, POLL_INTERVAL_MS, isActive);
  } else {
    unsubscribeTokenRefresh = jmapClient.onTokenRefresh(() => {
      if (closed || mode !== 'sse') return;
      // New bearer: the open stream still carries the old one for its
      // lifetime, which is fine, but every reconnect from now on must use
      // the new header - recycle now so a pending stale retry can't loop.
      dropStream();
      consecutiveFailures = 0;
      void connect();
    });
    await connect();
  }

  return {
    get mode() {
      return mode;
    },
    get healthy() {
      return mode === 'sse' && streamOpen;
    },
    close: () => {
      closed = true;
      mode = 'closed';
      clearTimers();
      dropStream();
      unsubscribeTokenRefresh?.();
      unsubscribeTokenRefresh = null;
      stopPolling?.();
      stopPolling = null;
    },
    reconnect: () => {
      if (closed) return;
      if (mode === 'polling') return; // polling keeps running on its own
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      consecutiveFailures = 0;
      dropStream();
      void connect();
    },
  };
}
