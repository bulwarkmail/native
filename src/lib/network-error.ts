// Classify an error thrown by a JMAP call as a *transient* connectivity
// failure (server unreachable, offline, session not yet up) versus a
// *permanent* one (the server received the request and rejected it, e.g. a
// 4xx). The offline outbox uses this to decide whether to keep an operation
// queued for a later retry or to give up on it.
//
// We err on the side of "transient" only for signals we recognise as
// connectivity-related; anything else (including bare 4xx/5xx responses) is
// treated as permanent so a poison operation can't wedge the queue forever.

import { useNetworkStore } from '../stores/network-store';

const TRANSIENT_NAMES = new Set([
  'NetworkError',     // jmap-client transport wrapper
  'AbortError',       // request aborted (e.g. app backgrounded)
  'TypeError',        // RN fetch throws TypeError("Network request failed")
]);

const TRANSIENT_MESSAGE_HINTS = [
  'network request failed',
  'network error',
  'failed to fetch',
  'not connected',
  'session expired',   // token refresh will happen on the next live request
  'timeout',
  'timed out',
  'connection',
];

export function isTransientNetworkError(err: unknown): boolean {
  // If the device itself reports offline, treat any failure as transient.
  if (!useNetworkStore.getState().online) return true;

  if (!(err instanceof Error)) return false;
  if (TRANSIENT_NAMES.has(err.name)) return true;

  const msg = err.message?.toLowerCase() ?? '';
  return TRANSIENT_MESSAGE_HINTS.some((hint) => msg.includes(hint));
}
