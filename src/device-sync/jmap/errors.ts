/**
 * Transport failures of the JMAP side, recognised by `error.name` as
 * jmap-client.ts sets it (AuthenticationError, NetworkError,
 * RequestTimeoutError, RateLimitError), so the engine never imports the
 * client: it stays pure and runs against the fake server in tests.
 */
import { JMAPMethodError } from '../../api/jmap-result';

export { JMAPMethodError };

/**
 * - `auth`: the server rejected the credentials (a 401 even after a token refresh);
 * - `network` / `timeout`: no response; the server may have applied the request;
 * - `rateLimit`: a 429, with `retryAfterMs`;
 * - `other`: anything else (a non-OK HTTP status, a body that is not JSON, a bug).
 */
export type TransportFailure = 'auth' | 'network' | 'timeout' | 'rateLimit' | 'other';

export function transportFailure(error: unknown): TransportFailure {
  switch ((error as { name?: unknown } | null)?.name) {
    case 'AuthenticationError':
    case 'TotpRequiredError':
      return 'auth';
    case 'NetworkError':
      return 'network';
    case 'RequestTimeoutError':
      return 'timeout';
    case 'RateLimitError':
      return 'rateLimit';
    default:
      return 'other';
  }
}

/** Milliseconds a RateLimitError asks us to wait, or null. */
export function retryAfterMs(error: unknown): number | null {
  const ms = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** A method-level error (`['error', {type}]`) of the given type, e.g. `cannotCalculateChanges`. */
export function isMethodError(error: unknown, type?: string): error is JMAPMethodError {
  return error instanceof JMAPMethodError && (type === undefined || error.type === type);
}

/**
 * jmap-client.ts turns Stalwart's HTTP 400 request-level limit error into a
 * plain `JMAP request failed: 400 - {…limit…}`. The engine sizes every
 * request by the session's limits, so one of those is a bug, not an outage.
 */
export function isRequestLimitError(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string'
    && /JMAP request failed: 400/.test(message)
    && message.includes('urn:ietf:params:jmap:error:limit');
}

export function authError(message: string): Error {
  const error = new Error(message);
  error.name = 'AuthenticationError';
  return error;
}
