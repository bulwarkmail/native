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

// OAuth refresh — exchanges the refresh token at the original token endpoint
// for a new access token. Returns the updated bundle so the caller can
// persist it.
export async function refreshOAuthAccessToken(tokens: OAuthTokens): Promise<OAuthTokens> {
  if (!tokens.refreshToken) {
    throw new HandoffError('No refresh token available');
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
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
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    tokenEndpoint: tokens.tokenEndpoint,
    clientId: tokens.clientId,
  };
}

WebBrowser.maybeCompleteAuthSession();
