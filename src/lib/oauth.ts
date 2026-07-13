import * as WebBrowser from 'expo-web-browser';
import { secureFetch } from './client-cert';

// Webmail-mediated login. The app opens the webmail's normal login page with
// extra `mobile_redirect_uri` and `mobile_state` query params. The webmail
// uses its existing password and OAuth flows, and once the user is signed
// in, redirects back to the app's custom scheme with credentials packed into
// the URL fragment. Fragments aren't sent to the server, so password and
// token material don't appear in HTTP access logs along the way.

export const HANDOFF_REDIRECT_URI = 'bulwarkmobile://auth/callback';

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  tokenEndpoint: string;
  clientId: string;
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

function randomState(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
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

  return {
    flow: 'oauth',
    serverUrl: data.server_url,
    tokens: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? undefined,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      tokenEndpoint: data.token_endpoint,
      clientId: data.client_id,
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
        const response = await secureFetch(tokens.tokenEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: body.toString(),
        });
        if (!response.ok) {
          throw new HandoffError(`Token refresh failed: ${response.status}`);
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
