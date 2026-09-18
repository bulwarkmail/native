import * as WebBrowser from 'expo-web-browser';
import { secureFetch } from './client-cert';
import { randomHex } from './random';

// Webmail-mediated login. The app opens the webmail's normal login page with
// extra `mobile_redirect_uri` and `mobile_state` query params. The webmail
// uses its existing password and OAuth flows, and once the user is signed
// in, redirects back to the app's custom scheme with credentials packed into
// the URL fragment. Fragments aren't sent to the server, so password and
// token material don't appear in HTTP access logs along the way.

export const HANDOFF_REDIRECT_URI = 'bulwarkmobile://auth/callback';

export type OAuthTokenSource = 'handoff' | 'pairing' | 'totp' | 'native';

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  tokenEndpoint: string;
  clientId: string;
  // Where the bundle came from. A paired phone shares the desktop's refresh
  // token, so revoking it on sign-out would also sign the desktop out;
  // every other source is safe to revoke.
  source?: OAuthTokenSource;
}

export type HandoffResult =
  | {
      flow: 'password';
      serverUrl: string;
      username: string;
      password: string;
    }
  | {
      flow: 'oauth';
      serverUrl: string;
      tokens: OAuthTokens;
    };

export class HandoffError extends Error {}
export class HandoffCancelledError extends HandoffError {
  constructor() {
    super('Sign-in cancelled');
  }
}

// The token endpoint could not be reached, or answered 5xx/429: the refresh
// token is still good, the caller must keep the account and retry later
// (webmail 1.7.6 "keep the session when the auth server is briefly
// unreachable"). Only a definitive 400/401/403 is a `HandoffError`.
export class TransientRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientRefreshError';
  }
}

// The state is the only guard against a forged `bulwarkmobile://` redirect
// delivering foreign credentials, so it comes from the platform CSPRNG.
function randomState(): string {
  return randomHex(16);
}

// Anything from the redirect fragment is attacker-influenced: another app can
// register the same custom scheme. External token endpoints need verification
// through the selected webmail, rather than trusting the redirect alone.
function isHttpsUrl(value: string | null): value is string {
  return !!value && /^https:\/\/[^/?#\s]+/i.test(value);
}

function hostOf(url: string): string {
  const m = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
  return (m ? m[1] : '').toLowerCase().replace(/:\d+$/, '');
}

// Dev builds against a local Stalwart still need plain http on loopback.
export function isLoopbackHttp(value: string): boolean {
  const host = hostOf(value);
  return /^http:\/\//i.test(value) && (host === 'localhost' || host === '127.0.0.1' || host === '10.0.2.2');
}

export function isAcceptableTokenEndpoint(
  tokenEndpoint: string | null,
  serverUrl: string,
  webmailUrl?: string,
): tokenEndpoint is string {
  if (!isHttpsUrl(tokenEndpoint) && !(tokenEndpoint && isLoopbackHttp(tokenEndpoint))) return false;
  const host = hostOf(tokenEndpoint as string);
  if (!host) return false;
  const allowed = [hostOf(serverUrl), webmailUrl ? hostOf(webmailUrl) : ''].filter(Boolean);
  return allowed.some((h) => host === h || host.endsWith(`.${h}`) || h.endsWith(`.${host}`));
}

// External IdPs must be authorized by the selected webmail over TLS, never
// by callback fields or a shared DNS suffix. Bind all returned identifiers.
async function isTrustedHandoffEndpoint(
  tokenEndpoint: string,
  serverUrl: string,
  webmailUrl: string,
  clientId: string,
): Promise<boolean> {
  if (isAcceptableTokenEndpoint(tokenEndpoint, serverUrl, webmailUrl)) return true;
  function httpsUrl(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
    } catch {
      return false;
    }
  }
  if (!httpsUrl(webmailUrl) || !httpsUrl(tokenEndpoint) || !httpsUrl(serverUrl)) return false;
  const base = webmailUrl.replace(/\/+$/, '');
  try {
    const load = async (path: string) => {
      const url = `${base}${path}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await secureFetch(url, {
          headers: { Accept: 'application/json' },
          redirect: 'error',
          signal: controller.signal,
          timeoutMs: 8000,
        });
        // The native client-certificate bridge omits the final URL. Without
        // transport evidence of its destination, external-IdP trust must fail.
        if (!response.ok || response.url !== url || response.redirected) {
          throw new Error('Untrusted metadata response');
        }
        return await response.json();
      } finally {
        clearTimeout(timeout);
      }
    };
    const config = await load('/api/config');
    if (
      config.oauthEnabled !== true || config.oauthClientId !== clientId ||
      config.jmapServerUrl !== serverUrl || !httpsUrl(config.oauthIssuerUrl)
    ) return false;
    const metadata = await load('/api/auth/oauth/metadata');
    return metadata.issuer === config.oauthIssuerUrl && metadata.token_endpoint === tokenEndpoint;
  } catch {
    return false;
  }
}

function buildHandoffUrl(webmailUrl: string, state: string): string {
  const base = webmailUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({
    mobile_redirect_uri: HANDOFF_REDIRECT_URI,
    mobile_state: state,
  });
  return `${base}/login?${params.toString()}`;
}

function parseFragment(url: string): URLSearchParams {
  const hashIdx = url.indexOf('#');
  if (hashIdx === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(hashIdx + 1));
}

export async function runWebmailHandoff(webmailUrl: string): Promise<HandoffResult> {
  const state = randomState();
  const handoffUrl = buildHandoffUrl(webmailUrl, state);

  const result = await WebBrowser.openAuthSessionAsync(handoffUrl, HANDOFF_REDIRECT_URI);

  if (result.type === 'cancel' || result.type === 'dismiss') {
    throw new HandoffCancelledError();
  }
  if (result.type !== 'success' || !result.url) {
    throw new HandoffError(`Sign-in failed: ${result.type}`);
  }

  const params = parseFragment(result.url);
  const err = params.get('error');
  if (err) throw new HandoffError(err);

  // CSRF guard: the state we generated must round-trip through the webmail
  // unchanged. A mismatch means the redirect didn't come from the flow we
  // started, and the rest of the fragment shouldn't be trusted.
  if (params.get('state') !== state) {
    throw new HandoffError('State mismatch');
  }

  const flow = params.get('flow');
  const serverUrl = params.get('server_url');
  if (!serverUrl) throw new HandoffError('Sign-in response missing server URL');
  if (!isHttpsUrl(serverUrl) && !isLoopbackHttp(serverUrl)) {
    throw new HandoffError('Sign-in response server URL must use https');
  }

  if (flow === 'password') {
    const username = params.get('username');
    const password = params.get('password');
    if (!username || !password) {
      throw new HandoffError('Sign-in response missing credentials');
    }
    return { flow: 'password', serverUrl, username, password };
  }

  if (flow === 'oauth') {
    const accessToken = params.get('access_token');
    const tokenEndpoint = params.get('token_endpoint');
    const clientId = params.get('client_id');
    if (!accessToken || !tokenEndpoint || !clientId) {
      throw new HandoffError('Sign-in response missing OAuth tokens');
    }
    if (!(await isTrustedHandoffEndpoint(tokenEndpoint, serverUrl, webmailUrl, clientId))) {
      throw new HandoffError('Sign-in response token endpoint is not trusted');
    }
    const refreshToken = params.get('refresh_token') ?? undefined;
    const expiresIn = params.get('expires_in');
    return {
      flow: 'oauth',
      serverUrl,
      tokens: {
        accessToken,
        refreshToken,
        expiresAt: expiresIn ? Date.now() + parseInt(expiresIn, 10) * 1000 : undefined,
        tokenEndpoint,
        clientId,
        source: 'handoff',
      },
    };
  }

  throw new HandoffError(`Unknown sign-in flow: ${flow ?? 'missing'}`);
}

// QR login payloads. A QR scanned on the login screen either bootstraps the
// server URL for the normal webmail handoff (`connect`), or carries a one-time
// cross-device pairing code minted by an already-signed-in webmail (`pair`).
// The payload never contains credentials — the `pair` code is redeemed for
// tokens over the network, once.
export type QrLoginPayload =
  | { kind: 'connect'; webmailUrl: string }
  | { kind: 'pair'; webmailUrl: string; code: string };

export function parseQrLoginPayload(raw: string): QrLoginPayload | null {
  const trimmed = raw.trim();

  // Custom scheme: bulwarkmail://connect?server=... | bulwarkmail://pair?server=...&code=...
  const match = /^bulwarkmail:\/\/(connect|pair)\?(.*)$/i.exec(trimmed);
  if (match) {
    const kind = match[1].toLowerCase();
    const params = new URLSearchParams(match[2]);
    const server = params.get('server');
    if (!server || !/^https?:\/\//i.test(server)) return null;
    if (kind === 'pair') {
      const code = params.get('code');
      if (!code) return null;
      return { kind: 'pair', webmailUrl: server, code };
    }
    return { kind: 'connect', webmailUrl: server };
  }

  // A bare https URL is treated as a server-bootstrap target so admins can
  // hand out a plain webmail URL QR without the custom-scheme wrapper.
  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: 'connect', webmailUrl: trimmed };
  }

  return null;
}

// Cross-device pairing redemption. Posts the scanned code to the webmail that
// minted it and maps the token bundle into the same shape the in-browser OAuth
// handoff produces, so the caller can reuse the existing connectWithOAuth path.
export async function redeemPairingCode(webmailUrl: string, code: string): Promise<HandoffResult> {
  const base = webmailUrl.replace(/\/+$/, '');
  let response: Response;
  try {
    response = await secureFetch(`${base}/api/auth/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ pairing_code: code }),
    });
  } catch {
    throw new HandoffError('Could not reach the server to complete pairing');
  }

  if (!response.ok) {
    // The code was unknown, already used, or expired (server returns 400) —
    // or something else went wrong. Either way the user needs a fresh QR.
    throw new HandoffError('Pairing code is invalid or has expired');
  }

  const data = (await response.json()) as {
    server_url?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_endpoint?: string;
    client_id?: string;
  };

  if (!data.server_url || !data.access_token || !data.token_endpoint || !data.client_id) {
    throw new HandoffError('Pairing response missing token material');
  }
  if (!isHttpsUrl(data.server_url) && !isLoopbackHttp(data.server_url)) {
    throw new HandoffError('Pairing response server URL must use https');
  }
  if (!(await isTrustedHandoffEndpoint(data.token_endpoint, data.server_url, base, data.client_id))) {
    throw new HandoffError('Pairing response token endpoint is not trusted');
  }

  return {
    flow: 'oauth',
    serverUrl: data.server_url,
    tokens: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? undefined,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      tokenEndpoint: data.token_endpoint,
      clientId: data.client_id,
      source: 'pairing',
    },
  };
}

const activeRefreshes = new Map<string, Promise<OAuthTokens>>();

// OAuth refresh — exchanges the refresh token at the original token endpoint
// for a new access token. Returns the updated bundle so the caller can
// persist it.
export async function refreshOAuthAccessToken(tokens: OAuthTokens): Promise<OAuthTokens> {
  if (!tokens.refreshToken) {
    throw new HandoffError('No refresh token available');
  }

  const cacheKey = tokens.refreshToken;
  let promise = activeRefreshes.get(cacheKey);

  if (!promise) {
    promise = (async () => {
      try {
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refreshToken!,
          client_id: tokens.clientId,
        });
        let response: Response;
        try {
          response = await secureFetch(tokens.tokenEndpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json',
            },
            body: body.toString(),
          });
        } catch (err) {
          throw new TransientRefreshError(
            `Token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (!response.ok) {
          // 400/401/403 mean the refresh token is definitively dead. Anything
          // else (429, 5xx, a proxy error page) is the auth server having a
          // bad moment and must not evict the account.
          if (response.status === 400 || response.status === 401 || response.status === 403) {
            throw new HandoffError(`Token refresh failed: ${response.status}`);
          }
          throw new TransientRefreshError(`Token refresh failed: ${response.status}`);
        }
        const data = (await response.json()) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
        };
        if (!data.access_token) {
          throw new HandoffError('Token refresh response missing access_token');
        }
        return {
          accessToken: data.access_token,
          refreshToken: data.refresh_token ?? tokens.refreshToken!,
          expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
          tokenEndpoint: tokens.tokenEndpoint,
          clientId: tokens.clientId,
          source: tokens.source,
        };
      } finally {
        activeRefreshes.delete(cacheKey);
      }
    })();
    activeRefreshes.set(cacheKey, promise);
  }

  return promise;
}

WebBrowser.maybeCompleteAuthSession();
