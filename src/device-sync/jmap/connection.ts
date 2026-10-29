/**
 * A registry account's JMAP connection for one sync run, with the one
 * rebuild the design allows when the server rejects the credentials: the UI
 * (or another run) may have rotated the OAuth refresh token this client
 * still holds, and a fresh client reads the rotated one from secure storage
 * (docs/device-sync.md, "A sync run", preflight).
 */
import type { JmapPort } from '../types';
import { authError, transportFailure } from './errors';

export interface JmapConnection {
  port: JmapPort;
  /** Origin of the server (`https://host[:port]`), recorded as the SyncState owner. */
  origin: string;
}

/** Loads a client; null when the account has no usable stored credentials. */
export type ConnectionLoader = () => Promise<JmapConnection | null>;

async function loadOnce(load: ConnectionLoader): Promise<JmapConnection | null> {
  try {
    return await load();
  } catch (error) {
    if (transportFailure(error) === 'auth') return null;
    throw error;
  }
}

/**
 * Opens the connection: a missing session or an AuthenticationError is
 * retried once with a fresh client; still failing, it throws an
 * AuthenticationError. Network trouble propagates as it came. Later
 * requests rebuild once more the same way when the server answers 401.
 */
export async function openWithAuthRebuild(load: ConnectionLoader): Promise<JmapConnection> {
  const first = await loadOnce(load);
  const opened = first ?? (await load());
  if (!opened) throw authError('No usable credentials for this account');

  let current = opened.port;
  let rebuilt = !first;
  const retryOnAuth = async <T>(send: (port: JmapPort) => Promise<T>): Promise<T> => {
    try {
      return await send(current);
    } catch (error) {
      // A 401 comes back before the server ran anything, so replaying is safe.
      if (transportFailure(error) !== 'auth' || rebuilt) throw error;
      rebuilt = true;
      const next = await load();
      if (!next) throw error;
      current = next.port;
      return send(current);
    }
  };
  const port: JmapPort = {
    session: () => current.session(),
    limits: () => current.limits(),
    request: (calls, using) => retryOnAuth((p) => p.request(calls, using)),
    downloadBlob: (accountId, blobId, type) => retryOnAuth((p) => p.downloadBlob(accountId, blobId, type)),
  };
  return { port, origin: opened.origin };
}
