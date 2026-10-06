// Classify an error thrown by a JMAP call as a *transient* connectivity
// failure (server unreachable, offline, timed out, rate limited) versus a
// *permanent* one (the server received the request and rejected it, e.g. a
// method error or a 4xx). The offline outbox uses this to decide whether to
// keep an operation queued for a later retry or to give up on it.
//
// Classification is by error class first. A bare `TypeError` used to count as
// transient because RN's fetch throws `TypeError("Network request failed")`,
// but the JMAP client now wraps transport failures in `NetworkError`; a
// TypeError reaching here is far more likely a programming error (e.g. an
// unchecked method-error response) and must not wedge the queue forever.
// `AuthenticationError` is terminal: the credentials are gone, retrying won't
// help until the user signs in again.

import { useNetworkStore } from '../stores/network-store';

const TRANSIENT_NAMES = new Set([
  'NetworkError',        // jmap-client transport wrapper
  'RequestTimeoutError', // no response headers within the deadline
  'RateLimitError',      // 429 - retry after the window
  'AbortError',          // request aborted (e.g. app backgrounded)
]);

const TERMINAL_NAMES = new Set([
  'AuthenticationError',
  'TotpRequiredError',
  'JMAPMethodError',
]);

const TRANSIENT_MESSAGE_HINTS = [
  'network request failed',
  'network error',
  'failed to fetch',
  'not connected',
  'timeout',
  'timed out',
  'connection',
];

export function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof Error && TERMINAL_NAMES.has(err.name)) return false;

  // If the device itself reports offline, treat any other failure as transient.
  if (!useNetworkStore.getState().online) return true;

  if (!(err instanceof Error)) return false;
  if (TRANSIENT_NAMES.has(err.name)) return true;

  // A raw fetch TypeError only counts when its message says "network".
  const msg = err.message?.toLowerCase() ?? '';
  if (err.name === 'TypeError') {
    return msg.includes('network') || msg.includes('failed to fetch') || msg.includes('securefetch failed');
  }
  return TRANSIENT_MESSAGE_HINTS.some((hint) => msg.includes(hint));
}

/**
 * True for jmapClient's `StaleLoadError`: the client moved to another
 * connection (account switch, sign-in, sign-out) before the request was sent.
 * Nothing reached the server, and the work belongs to a connection that is
 * gone: drop it without an error, a retry or a toast.
 */
export function isStaleLoad(err: unknown): boolean {
  return err instanceof Error && err.name === 'StaleLoadError';
}

/**
 * A stale stop because the request named a JMAP account the live session
 * does not have. On the account the request was built for, that means the
 * account itself is gone (a shared account no longer visible), not a switch.
 */
export function isAccountNotInSession(err: unknown): boolean {
  return isStaleLoad(err) && (err as { reason?: string }).reason === 'account-not-in-session';
}

/** True when the failure means the session/credentials are unusable. */
export function isAuthError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AuthenticationError' || err.name === 'TotpRequiredError');
}
