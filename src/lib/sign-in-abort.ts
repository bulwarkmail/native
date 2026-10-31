// Cancelling a sign-in (U-133). The sign-in screen used to show "Signing in"
// with no way out until every request gave up on its own, and Android Back
// was swallowed meanwhile. The screen now holds an AbortController per
// attempt; its signal goes into discovery, the client check, the /api/auth
// and token requests, and the auth store, which drops a sign-in whose signal
// fired before it registered the account.

export class SignInCancelledError extends Error {
  constructor() {
    super('Sign-in cancelled');
    this.name = 'SignInCancelledError';
  }
}

export function isSignInCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === 'SignInCancelledError';
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SignInCancelledError();
}

/**
 * `promise`, or a `SignInCancelledError` as soon as `signal` fires. The work
 * behind the promise goes on; callers that need to undo what it does once it
 * finishes keep their own reference to it.
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new SignInCancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SignInCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.aborted ? new SignInCancelledError() : err);
      },
    );
  });
}

/**
 * One signal that fires when `signal` does or after `ms`, whichever comes
 * first (AbortSignal.any and AbortSignal.timeout aren't in every engine the
 * app runs on). Call `done` when the request has finished.
 */
export function signalWithTimeout(
  signal: AbortSignal | undefined,
  ms?: number,
): { signal?: AbortSignal; done: () => void } {
  if (typeof AbortController === 'undefined') return { signal, done: () => undefined };
  if (!signal && ms === undefined) return { done: () => undefined };
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = ms !== undefined ? setTimeout(abort, ms) : undefined;
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}
