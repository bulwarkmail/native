// Whether the JMAP server is reachable while the app is in the foreground,
// for the per-account connection dot. NetInfo only knows the device is
// online, not that the server answers.
//
// An open event stream already proves it: the server pings it every 30 s and
// the stream is dropped after three missed pings. A `Core/echo` every 30 s is
// only sent while the stream is not open (polling fallback, reconnecting,
// client certificate), and on demand (`check`, e.g. on resume, where it runs
// alongside the catch-up sync instead of in front of it). Checks never
// overlap, and a periodic one is skipped right after an on-demand one.

export const LIVENESS_INTERVAL_MS = 30_000;

export interface LivenessOptions {
  /** One `Core/echo`: true when the server answered. */
  ping: () => Promise<boolean>;
  /** Whether the event stream is open and its pings arrive. */
  streamHealthy: () => boolean;
  /** Whether the app is in the foreground. */
  isActive: () => boolean;
  /** Whether the device has a network. */
  isOnline: () => boolean;
  /** Called with the connection state after each verdict. */
  onConnected: (connected: boolean) => void;
  intervalMs?: number;
  now?: () => number;
}

export interface LivenessMonitor {
  /** Check now (one `Core/echo`), unless a check is already running. */
  check: () => Promise<void>;
  stop: () => void;
}

export function startLivenessMonitor(opts: LivenessOptions): LivenessMonitor {
  const interval = opts.intervalMs ?? LIVENESS_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  let failures = 0;
  let inFlight: Promise<void> | null = null;
  let lastCheckAt = -Infinity;
  let stopped = false;

  const check = (): Promise<void> => {
    if (inFlight) return inFlight;
    lastCheckAt = now();
    inFlight = opts.ping()
      .catch(() => false)
      .then((ok) => {
        if (stopped) return;
        failures = ok ? 0 : failures + 1;
        // One missed echo can be a blip; two in a row is a lost connection.
        opts.onConnected(failures < 2);
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const timer = setInterval(() => {
    if (!opts.isActive() || !opts.isOnline()) return;
    if (opts.streamHealthy()) {
      failures = 0;
      opts.onConnected(true);
      return;
    }
    // A tick that fired late (on resume) right after the resume check.
    if (now() - lastCheckAt < interval / 2) return;
    void check();
  }, interval);

  return {
    check,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
