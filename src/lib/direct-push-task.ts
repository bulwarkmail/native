// BulwarkDirectPushCredentialsTask: the direct connection's service has no
// credentials of its own (a fresh process, after boot, or a stream the server
// refused) and asks for them. Reads the stored credentials of each account it
// streams (readDirectPushAccountIds), refreshes an OAuth token through the
// guarded path, reads the session's eventSourceUrl and hands the lot to the
// service, which keeps it in memory.

import { AuthenticationError, rewriteSessionUrls } from '../api/jmap-client';
import { getClientCertAlias } from './client-cert';
import { getDirectPushNative, type DirectPushAccount } from './direct-push';
import { fetchDetachedSession } from './push-background-task';
import { pushTypesFor, readDirectPushAccountIds, stopDirectPushService } from './push-notifications';

/** One account's stream, or null when it has none (signed out, no event source). Throws when it can't be read now. */
async function streamOf(accountId: string): Promise<DirectPushAccount | null> {
  const discovered = await fetchDetachedSession(accountId);
  if (!discovered) return null;
  const { creds, baseUrl, authHeader, session } = discovered;
  // On the origin the app connected to, as the client's own session.
  const { eventSourceUrl } = rewriteSessionUrls(session, baseUrl);
  if (!eventSourceUrl) return null;
  return {
    id: accountId,
    eventSourceUrl,
    authorization: authHeader,
    types: await pushTypesFor(accountId, session),
    label: creds.username,
  };
}

/** `request` numbers the service's ask; the answer carries it back so a stale one is dropped. */
export async function directPushCredentialsTask(data: { request?: unknown }): Promise<void> {
  const native = getDirectPushNative();
  if (!native) return;
  const { request } = data;
  if (typeof request !== 'number') {
    console.warn('[push] direct connection: credentials asked without a request number');
    return;
  }
  try {
    const accountIds = await readDirectPushAccountIds();
    if (accountIds.length === 0) {
      await stopDirectPushService();
      return;
    }
    // The service's HTTP client can't present a client certificate (the
    // app's own stream falls back to polling then, api/push-stream).
    if (await getClientCertAlias().catch(() => null)) {
      console.warn('[push] direct connection: a client certificate is in use, no stream');
      await native.setAccounts({ request, accounts: [], unreadable: [], refused: [] });
      return;
    }
    const accounts: DirectPushAccount[] = [];
    // Refused accounts are counted like a refused stream and given up on
    // after a few: asking on with a wrong password gets the device's
    // address banned by the server's failed-login limit.
    const refused: string[] = [];
    const unreadable: string[] = [];
    for (const accountId of accountIds) {
      try {
        const account = await streamOf(accountId);
        if (account) accounts.push(account);
      } catch (err) {
        if (err instanceof AuthenticationError) refused.push(accountId);
        else unreadable.push(accountId);
      }
    }
    // Counts only: an account's id is the user's address.
    if (refused.length + unreadable.length > 0) {
      console.warn(`[push] direct connection: of ${accountIds.length} accounts, ${refused.length} refused, ${unreadable.length} unreadable`);
    }
    await native.setAccounts({ request, accounts, unreadable, refused });
  } catch (err) {
    console.warn('[push] direct connection credentials failed:', err instanceof Error ? err.message : err);
  }
}
