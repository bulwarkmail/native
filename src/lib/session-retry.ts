// Keep retrying a missing session. A cold start while the mail server is
// unreachable (a LAN server restarting) leaves the app signed in with no live
// session (`isAuthenticated: true, session: null`). Every recovery effect
// needs a live session, and the online-edge retry never fires when `online`
// did not change, so without this the app stays stuck until a Wi-Fi toggle
// or a relaunch. Gated on `connected` (an interface is up), not `online`,
// which may be false only because the internet probe fails.

export const SESSION_RETRY_INITIAL_MS = 5_000;
export const SESSION_RETRY_MAX_MS = 60_000;

/** Delay before retry number `attempt` (0-based): 5 s, doubling, capped at 60 s. */
export function nextSessionRetryDelay(attempt: number): number {
  return Math.min(SESSION_RETRY_INITIAL_MS * 2 ** attempt, SESSION_RETRY_MAX_MS);
}

export function shouldRetrySession(s: {
  isAuthenticated: boolean;
  hasSession: boolean;
  connected: boolean;
  /** A login, restore or account switch is running; it decides on its own. */
  isLoading: boolean;
  /** The app is in the foreground; the foreground kick resumes the retries. */
  appActive: boolean;
}): boolean {
  return s.isAuthenticated && !s.hasSession && s.connected && !s.isLoading && s.appActive;
}

export type SessionRetryEvent =
  | { kind: 'network'; online: boolean; prevOnline: boolean; connected: boolean; prevConnected: boolean }
  | { kind: 'auth'; sessionChanged: boolean; loadingChanged: boolean }
  | { kind: 'appState'; active: boolean };

/**
 * What the retrier does for an app event. Every retry goes through the
 * retrier, so `shouldRetrySession` (the pause during a login, restore or
 * switch, and in the background) applies to all of them: an online edge
 * kicks rather than calling retrySession itself, because since the server's
 * own answers count toward `online`, that edge can come from inside a switch.
 */
export function sessionRetryAction(event: SessionRetryEvent): 'kick' | 'poke' | 'none' {
  switch (event.kind) {
    case 'network':
      if (event.online && !event.prevOnline) return 'kick';
      return event.connected !== event.prevConnected ? 'poke' : 'none';
    case 'auth':
      return event.sessionChanged || event.loadingChanged ? 'poke' : 'none';
    case 'appState':
      return event.active ? 'kick' : 'none';
  }
}

/**
 * Wrap `fn` so concurrent calls for the same key share one in-flight attempt.
 * A call for another key starts its own.
 */
export function singleFlightByKey<K, T>(fn: (key: K) => Promise<T>): (key: K) => Promise<T> {
  let inFlight: { key: K; promise: Promise<T> } | null = null;
  return (key: K) => {
    if (inFlight && inFlight.key === key) return inFlight.promise;
    const promise = fn(key).finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
    inFlight = { key, promise };
    return promise;
  };
}

/**
 * Like singleFlightByKey, but a caller that joins an attempt in flight gets
 * one more after it (shared by every caller that joined), as the email
 * store's coalesceRefresh queues a re-run: the attempt in flight may have
 * started before what the joiner needs to see (a session fetched before a
 * new owner shared). A call for another key starts its own.
 */
export function coalesceByKey<K, T>(fn: (key: K) => Promise<T>): (key: K) => Promise<T> {
  interface Flight { key: K; promise: Promise<T>; next?: Promise<T> }
  let inFlight: Flight | null = null;
  const start = (key: K): Promise<T> => {
    const flight = { key } as Flight;
    flight.promise = fn(key).finally(() => {
      // With a re-run queued, it takes over (and later callers join it).
      if (inFlight === flight && !flight.next) inFlight = null;
    });
    inFlight = flight;
    return flight.promise;
  };
  return (key: K) => {
    const current = inFlight;
    if (!current || current.key !== key) return start(key);
    current.next ??= current.promise.then(() => undefined, () => undefined).then(() => start(key));
    return current.next;
  };
}

export interface SessionRetrier {
  /** Schedule the next retry if the conditions hold and none is pending. */
  poke: () => void;
  /** Retry now (e.g. the app came to the foreground), unless one is running. */
  kick: () => void;
  stop: () => void;
}

export function startSessionRetry(opts: {
  shouldRetry: () => boolean;
  /** Resolves true once a session is live. */
  retry: () => Promise<boolean>;
}): SessionRetrier {
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const schedule = () => {
    if (stopped || timer || running) return;
    if (!opts.shouldRetry()) {
      attempt = 0;
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      run();
    }, nextSessionRetryDelay(attempt++));
  };

  const run = () => {
    if (stopped || running) return;
    if (!opts.shouldRetry()) {
      attempt = 0;
      return;
    }
    running = true;
    void opts
      .retry()
      .catch(() => false)
      .then((ok) => {
        running = false;
        if (stopped) return;
        if (ok) {
          attempt = 0;
          return;
        }
        schedule();
      });
  };

  return {
    poke: schedule,
    kick: () => {
      if (stopped || running) return;
      clearTimer();
      run();
    },
    stop: () => {
      stopped = true;
      clearTimer();
    },
  };
}
