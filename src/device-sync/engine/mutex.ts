/**
 * One sync run or app-side operation (turning sync off, sign-out) at a time
 * per registry account and authority. Module level on purpose: a headless
 * run and the UI share one JS runtime (docs/device-sync.md, "Architecture"),
 * so a module-level lock covers both.
 */
import type { Authority } from '../types';

const tails = new Map<string, Promise<void>>();
const stopRequests = new Map<string, number>();

export function lockKey(registryId: string, authority: Authority): string {
  return `${registryId}\u0000${authority}`;
}

/**
 * Waits for the lock; resolves with its release function, or null when
 * `waitMs` passed first (the place in the queue is then handed on).
 */
export function acquireLock(key: string, waitMs = Infinity): Promise<(() => void) | null> {
  const previous = tails.get(key) ?? Promise.resolve();
  let pass!: () => void;
  const mine = new Promise<void>((resolve) => {
    pass = resolve;
  });
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return new Promise((resolve) => {
    let settled = false;
    const timer = Number.isFinite(waitMs)
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(null);
          void previous.then(pass);
        }, Math.max(0, waitMs))
      : null;
    void previous.then(() => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        pass();
      });
    });
  });
}

export function isLocked(key: string): boolean {
  return tails.has(key);
}

/** Asks the run holding the lock to stop at its next checkpoint (it reports `cancelled`). */
export function requestStop(key: string): void {
  stopRequests.set(key, (stopRequests.get(key) ?? 0) + 1);
}

export function clearStopRequest(key: string): void {
  stopRequests.delete(key);
}

export function stopRequested(key: string): boolean {
  return (stopRequests.get(key) ?? 0) > 0;
}
