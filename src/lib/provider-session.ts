// Ending the identity provider's session on sign-out (OpenID Connect
// RP-Initiated Logout 1.0, webmail #905, `lib/oauth/end-session.ts`).
//
// Revoking the refresh token ends this app's grant, but not the login session
// the provider keeps in the browser's cookies. Android's Custom Tabs share
// Chrome's cookies, so with that session alive "Sign in with SSO" silently
// signs the same person back in. Signing out of an account that signed in
// with the direct PKCE flow therefore finishes by opening the provider's
// `end_session_endpoint` in the browser.
//
// Only `native` sign-ins qualify: there this app holds the client and the id
// token. A hand-off or pairing sign-in's provider session belongs to the
// webmail's client, and the webmail's own sign-out ends it.
//
// The id token lives in SecureStore under the app account it came with; the
// endpoint, from that account's own discovery document, on its registry
// entry. Neither is ever used for another account.

import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { HANDOFF_REDIRECT_URI, type OAuthTokenSource } from './oauth';

const ID_TOKEN_PREFIX = 'oidc_id_token__';

// SecureStore keys: letters, digits, ".", "-", "_" only, as for credentials.
export function idTokenKey(accountId: string): string {
  return ID_TOKEN_PREFIX + accountId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * The endpoint as advertised, when it is one the id token may travel to:
 * an https URL. Anything else means no provider logout.
 */
export function usableEndSessionEndpoint(endpoint: unknown): string | undefined {
  if (typeof endpoint !== 'string') return undefined;
  try {
    return new URL(endpoint).protocol === 'https:' ? endpoint : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The URL that asks the provider to end its session, or null when the
 * endpoint is unusable. `client_id` is always sent: providers use it to check
 * the redirect URI and to find the session without an id token.
 * `id_token_hint` lets providers such as Keycloak end it without asking.
 */
export function buildEndSessionUrl(params: {
  endpoint: string;
  clientId: string;
  idToken?: string | null;
  postLogoutRedirectUri?: string;
}): string | null {
  if (!usableEndSessionEndpoint(params.endpoint)) return null;
  const url = new URL(params.endpoint);
  url.searchParams.set('client_id', params.clientId);
  if (params.idToken) url.searchParams.set('id_token_hint', params.idToken);
  if (params.postLogoutRedirectUri) url.searchParams.set('post_logout_redirect_uri', params.postLogoutRedirectUri);
  return url.toString();
}

/** Keep the account's id token for sign-out, or forget a stale one. */
export async function storeIdToken(accountId: string, idToken: string | undefined): Promise<void> {
  if (idToken) await SecureStore.setItemAsync(idTokenKey(accountId), idToken);
  else await SecureStore.deleteItemAsync(idTokenKey(accountId));
}

export async function deleteIdToken(accountId: string): Promise<void> {
  await SecureStore.deleteItemAsync(idTokenKey(accountId));
}

/**
 * Keep the id token a refresh returned for `accountId`, the account that
 * refresh was for. Only replaces one already kept, which a sign-in stores
 * only for a direct PKCE account with a usable endpoint; a response without
 * one keeps the old. `stillSignedIn` says whether the account's credentials
 * are still stored: it is asked before the write and again after it, so a
 * refresh that lands during sign-out never leaves a token behind.
 */
export async function replaceIdToken(
  accountId: string,
  idToken: string | undefined,
  stillSignedIn: () => Promise<boolean>,
): Promise<void> {
  if (!idToken) return;
  const key = idTokenKey(accountId);
  if (!(await SecureStore.getItemAsync(key))) return;
  if (!(await stillSignedIn())) return;
  await SecureStore.setItemAsync(key, idToken);
  if (!(await stillSignedIn())) await SecureStore.deleteItemAsync(key);
}

/** The provider an end-session endpoint belongs to: its origin. */
export function providerOf(endpoint: string | undefined): string | null {
  const usable = usableEndSessionEndpoint(endpoint);
  return usable ? new URL(usable).origin : null;
}

/** What ending one account's provider session needs, read before sign-out drops it. */
export interface ProviderLogout {
  endpoint: string;
  clientId: string;
  idToken?: string;
}

/**
 * The provider logout for `accountId`, from its stored credentials (whose
 * sign-in it was, and the client) and its registry entry's `endpoint`, or
 * null when it has none: not a direct PKCE sign-in, or the provider
 * advertises no usable endpoint. A sign-in without a refresh token counts.
 */
export async function captureProviderLogout(
  accountId: string,
  endpoint: string | undefined,
  credentials: { tokenSource?: OAuthTokenSource; clientId?: string } | null,
): Promise<ProviderLogout | null> {
  const usable = usableEndSessionEndpoint(endpoint);
  if (!usable || credentials?.tokenSource !== 'native' || !credentials.clientId) return null;
  const idToken = await SecureStore.getItemAsync(idTokenKey(accountId)).catch(() => null);
  return { endpoint: usable, clientId: credentials.clientId, ...(idToken ? { idToken } : {}) };
}

/**
 * Open the provider's end-session page in the browser. No
 * `post_logout_redirect_uri` is sent, as in webmail by default: a value the
 * provider has not registered makes most of them refuse the whole logout, so
 * the provider shows its own signed-out page and the user closes it. An auth
 * session rather than a plain browser tab, because on iOS that is the cookie
 * jar the sign-in used. Runs after the local sign-out and never throws: a
 * failure or a closed browser leaves the app signed out all the same.
 */
export async function endProviderSession(logout: ProviderLogout): Promise<void> {
  const url = buildEndSessionUrl(logout);
  if (!url) return;
  try {
    await WebBrowser.openAuthSessionAsync(url, HANDOFF_REDIRECT_URI);
  } catch {
    // the local sign-out is already done
  }
}
