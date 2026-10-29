// Token refresh for the holders that work from their own copy of an account's
// stored credentials instead of the live client: the unified inbox and the
// background push task. The live client keeps its own (jmap-client
// ensureFreshToken / persistRefreshedTokens) and follows the same rules.
//
// Stalwart 1.0 rotates refresh tokens and revokes the whole grant when a
// replaced one comes back, so a copy that is behind must not be spent:
// - before refreshing, the stored bundle is read again and taken when it is
//   newer (the live client or the iOS notification extension refreshed
//   meanwhile);
// - the refresh goes through refreshOAuthAccessToken, whose in-process
//   memory shares one request between holders refreshing at once and hands
//   the successor to one that comes late;
// - the result is written back only over the bundle that was refreshed: not
//   when the account signed out meanwhile, and not over a newer bundle
//   someone else wrote.

import { jmapClient, type StoredCredentials } from '../api/jmap-client';
import { forgetRefreshRotations, refreshOAuthAccessToken } from './oauth';

const TOKEN_REFRESH_LEEWAY_MS = 60_000;

function expiresSoon(expiresAt: number | undefined): boolean {
  return expiresAt != null && expiresAt - Date.now() <= TOKEN_REFRESH_LEEWAY_MS;
}

/**
 * `creds` with an access token that is not about to expire, refreshed and
 * stored when needed. Password credentials come back as they are; so does
 * an account whose credentials are gone from storage (signed out). A failed
 * refresh returns what there is, and the request that uses it fails on its
 * own. When the account signs out while the refresh runs, its fresh tokens
 * are dropped and this throws.
 */
export async function freshStoredCredentials(
  accountId: string,
  creds: StoredCredentials,
): Promise<StoredCredentials> {
  if (
    !creds.accessToken || !creds.refreshToken || !creds.tokenEndpoint
    || !creds.clientId || creds.expiresAt == null
  ) {
    return creds;
  }
  if (!expiresSoon(creds.expiresAt)) return creds;

  const stored = await jmapClient.getStoredCredentials(accountId).catch(() => null);
  if (!stored?.accessToken || !stored.refreshToken) return creds;
  let base = creds;
  if (stored.accessToken !== creds.accessToken && (stored.expiresAt ?? 0) > creds.expiresAt) {
    base = {
      ...creds,
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken,
      expiresAt: stored.expiresAt,
      tokenEndpoint: stored.tokenEndpoint ?? creds.tokenEndpoint,
      clientId: stored.clientId ?? creds.clientId,
    };
    if (!expiresSoon(base.expiresAt)) return base;
  }

  let signedOut = false;
  try {
    const next = await refreshOAuthAccessToken({
      accessToken: base.accessToken!,
      refreshToken: base.refreshToken!,
      expiresAt: base.expiresAt,
      tokenEndpoint: base.tokenEndpoint!,
      clientId: base.clientId!,
      source: base.tokenSource,
    });
    const tokens = {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken ?? base.refreshToken,
      expiresAt: next.expiresAt,
      tokenEndpoint: next.tokenEndpoint,
      clientId: next.clientId,
    };
    const current = await jmapClient.getStoredCredentials(accountId);
    if (!current) {
      // Signed out meanwhile: the sign-out forgot the chain before this
      // refresh returned. Nobody may use the tokens it bought.
      forgetRefreshRotations(base.refreshToken);
      forgetRefreshRotations(tokens.refreshToken);
      signedOut = true;
      throw new Error('Account signed out');
    }
    if (current.refreshToken === base.refreshToken && current.accessToken !== tokens.accessToken) {
      await jmapClient.setStoredCredentials(accountId, { ...current, ...tokens });
    }
    return { ...base, ...tokens };
  } catch (err) {
    if (signedOut) throw err;
    return base;
  }
}
