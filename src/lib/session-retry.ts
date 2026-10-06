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
}): boolean {
  return s.isAuthenticated && !s.hasSession && s.connected && !s.isLoading;
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
