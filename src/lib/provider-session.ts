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

// An https URL with a host, and no backslash or credentials in front of the
// path. Judged on the string alone, as `sanitizeSidebarAppUrl` is: React
// Native's `URL` is a few regexes, and Node's WHATWG one reads a backslash as
// a slash, so the two disagree on exactly the URLs that matter.
const HTTPS_ENDPOINT_RE = /^https:\/\/[^\s\\/?#@]+(?:[/?#][^\s\\]*)?$/i;

// The parameters this app sets, replaced if the endpoint already names one.
const END_SESSION_PARAMS = new Set(['client_id', 'id_token_hint', 'post_logout_redirect_uri']);

/**
 * The endpoint as advertised, when it is one the id token may travel to:
 * an https URL. Anything else means no provider logout.
 */
export function usableEndSessionEndpoint(endpoint: unknown): string | undefined {
  if (typeof endpoint !== 'string') return undefined;
  return HTTPS_ENDPOINT_RE.test(endpoint) ? endpoint : undefined;
}

/**
 * The URL that asks the provider to end its session, or null when the
 * endpoint is unusable. `client_id` is always sent: providers use it to check
 * the redirect URI and to find the session without an id token.
 * `id_token_hint` lets providers such as Keycloak end it without asking.
 *
 * Built as a string, never through `URL`: on the device React Native's would
 * add `/` to the path, which strict routers answer with a 404, and repeat the
 * endpoint's own query. The path and any query the provider gave are kept as
 * they are; a fragment is dropped.
 */
export function buildEndSessionUrl(params: {
  endpoint: string;
  clientId: string;
  idToken?: string | null;
  postLogoutRedirectUri?: string;
}): string | null {
  const usable = usableEndSessionEndpoint(params.endpoint);
  if (!usable) return null;
  const [path, query = ''] = usable.split('#', 1)[0].split(/\?(.*)/s);
  const kept = query.split('&').filter((pair) => pair && !END_SESSION_PARAMS.has(pair.split('=', 1)[0]));
  const added: [string, string][] = [['client_id', params.clientId]];
  if (params.idToken) added.push(['id_token_hint', params.idToken]);
  if (params.postLogoutRedirectUri) added.push(['post_logout_redirect_uri', params.postLogoutRedirectUri]);
  const pairs = [...kept, ...added.map(([k, v]) => `${k}=${encodeURIComponent(v)}`)];
  return `${path}?${pairs.join('&')}`;
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

/**
 * The provider an end-session endpoint belongs to: the whole endpoint, with
 * the query, fragment and any trailing slash dropped. Not just the origin:
 * Keycloak serves every realm from one host, the realm in the path
 * (`/realms/<realm>/protocol/openid-connect/logout`), and each realm keeps a
 * session of its own.
 */
export function providerOf(endpoint: string | undefined): string | null {
  const usable = usableEndSessionEndpoint(endpoint);
  if (!usable) return null;
  // String operations, as in buildEndSessionUrl. The scheme and host are
  // compared without case and the default port dropped, as an origin would be.
  const rest = usable.slice('https://'.length).split(/[?#]/, 1)[0];
  const slash = rest.indexOf('/');
  const host = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase().replace(/:443$/, '');
  const path = slash < 0 ? '' : rest.slice(slash).replace(/\/+$/, '');
  return `https://${host}${path}`;
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
