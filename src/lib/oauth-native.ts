// Direct OAuth 2.0 / OIDC authorization-code + PKCE login against the mail
// server's own authorization server (Stalwart's built-in OAuth, Keycloak,
// Authentik…), for deployments where no Bulwark webmail lives at the JMAP
// origin and the browser hand-off therefore has nothing to open.
//
// Mirrors the webmail's client-side PKCE flow (`lib/oauth/discovery.ts`,
// `lib/oauth/pkce.ts`, login page `handleOAuthLogin`): discover the metadata
// document, open the authorization endpoint in the system browser with a
// S256 challenge, receive the code on `bulwarkmobile://auth/callback`, and
// exchange it at the token endpoint. The resulting bundle is the same shape
// the hand-off produces, so `connectWithOAuth` and the refresh path apply.

import * as WebBrowser from 'expo-web-browser';
import { secureFetch } from './client-cert';
import { HANDOFF_REDIRECT_URI, HandoffError, HandoffCancelledError, type OAuthTokens } from './oauth';
import { generateCodeChallenge, generateCodeVerifier, DEFAULT_CLIENT_ID } from './totp-login';
import { randomHex } from './random';

export interface OAuthMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
  prompt_values_supported?: string[];
}

const DISCOVERY_TIMEOUT_MS = 8_000;

function withTimeout(ms: number): { signal?: AbortSignal; done: () => void } {
  if (typeof AbortController === 'undefined') return { done: () => undefined };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function sameHost(a: string, b: string): boolean {
  const host = (u: string) => (/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(u)?.[1] ?? '').toLowerCase().replace(/:\d+$/, '');
  const ha = host(a);
  const hb = host(b);
  return !!ha && !!hb && (ha === hb || ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`));
}

/**
 * RFC 8414 / OIDC discovery on the mail server origin. Returns null when the
 * server advertises no authorization server (plain Stalwart without OAuth,
 * or a non-Stalwart JMAP server).
 */
export async function discoverOAuthMetadata(serverUrl: string): Promise<OAuthMetadata | null> {
  const base = serverUrl.replace(/\/+$/, '');
  const urls = [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ];
  for (const url of urls) {
    const t = withTimeout(DISCOVERY_TIMEOUT_MS);
    try {
      const res = await secureFetch(url, { headers: { Accept: 'application/json' }, signal: t.signal });
      if (!res.ok) continue;
      const data = (await res.json()) as Partial<OAuthMetadata>;
      if (
        typeof data.authorization_endpoint === 'string' &&
        typeof data.token_endpoint === 'string' &&
        /^https?:\/\//i.test(data.authorization_endpoint) &&
        /^https?:\/\//i.test(data.token_endpoint)
      ) {
        return data as OAuthMetadata;
      }
    } catch {
      // try the next document
    } finally {
      t.done();
    }
  }
  return null;
}

/**
 * Is a Bulwark webmail serving the given origin? The hand-off opens
 * `${origin}/login?mobile_redirect_uri=…`, which only works when it is.
 */
export async function probeWebmail(serverUrl: string): Promise<boolean> {
  const base = serverUrl.replace(/\/+$/, '');
  const t = withTimeout(DISCOVERY_TIMEOUT_MS);
  try {
    const res = await secureFetch(`${base}/api/config`, { headers: { Accept: 'application/json' }, signal: t.signal });
    if (!res.ok) return false;
    const type = res.headers.get('content-type') ?? '';
    if (!/json/i.test(type)) return false;
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return !!data && typeof data === 'object';
  } catch {
    return false;
  } finally {
    t.done();
  }
}

function parseCallbackParams(url: string): URLSearchParams {
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  const query = q >= 0 ? url.slice(q + 1, h > q ? h : undefined) : '';
  const params = new URLSearchParams(query);
  if (h >= 0) {
    for (const [k, v] of new URLSearchParams(url.slice(h + 1))) {
      if (!params.has(k)) params.set(k, v);
    }
  }
  return params;
}

// Adding an account must not quietly reuse the identity provider's session
// of the account that is already signed in (webmail 5771a213). Ask for the
// account picker, or for a fresh login where the server says it has no
// picker (Keycloak advertises only none/login/consent).
function addAccountPrompt(metadata: OAuthMetadata): string {
  const supported = metadata.prompt_values_supported;
  if (supported?.length && !supported.includes('select_account') && supported.includes('login')) return 'login';
  return 'select_account';
}

/**
 * Run the authorization-code + PKCE flow in the system browser. Throws
 * `HandoffCancelledError` when the user closes the browser. With `addAccount`
 * the provider is asked to pick or sign in another account, and iOS runs the
 * session without the browser's cookies so the current one can't carry over.
 */
export async function loginWithPkce(
  serverUrl: string,
  metadata: OAuthMetadata,
  opts?: { clientId?: string; scopes?: string; redirectUri?: string; addAccount?: boolean },
): Promise<OAuthTokens> {
  const clientId = opts?.clientId ?? DEFAULT_CLIENT_ID;
  const redirectUri = opts?.redirectUri ?? HANDOFF_REDIRECT_URI;
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = randomHex(16);
  const scope = opts?.scopes
    ?? (metadata.scopes_supported?.length
      ? ['openid', 'email', 'profile', 'offline_access'].filter((s) => metadata.scopes_supported!.includes(s)).join(' ') || metadata.scopes_supported.join(' ')
      : 'openid email profile offline_access');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (opts?.addAccount) params.set('prompt', addAccountPrompt(metadata));
  const authUrl = `${metadata.authorization_endpoint}${metadata.authorization_endpoint.includes('?') ? '&' : '?'}${params.toString()}`;

  const result = await WebBrowser.openAuthSessionAsync(
    authUrl,
    redirectUri,
    opts?.addAccount ? { preferEphemeralSession: true } : undefined,
  );
  if (result.type === 'cancel' || result.type === 'dismiss') throw new HandoffCancelledError();
  if (result.type !== 'success' || !result.url) throw new HandoffError(`Sign-in failed: ${result.type}`);

  const cb = parseCallbackParams(result.url);
  const err = cb.get('error');
  if (err) throw new HandoffError(cb.get('error_description') || err);
  if (cb.get('state') !== state) throw new HandoffError('State mismatch');
  const code = cb.get('code');
  if (!code) throw new HandoffError('Sign-in response missing authorization code');

  if (!sameHost(metadata.token_endpoint, serverUrl) && !/^https:\/\//i.test(metadata.token_endpoint)) {
    throw new HandoffError('Token endpoint is not trusted');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  let response: Response;
  try {
    response = await secureFetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch (e) {
    throw new HandoffError(`Could not reach the token endpoint: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    throw new HandoffError(`Token exchange failed: ${response.status}${detail ? ` ${detail}` : ''}`);
  }
  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) throw new HandoffError('Token response missing access_token');
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    tokenEndpoint: metadata.token_endpoint,
    clientId,
    source: 'native',
  };
}

/**
 * Best-effort RFC 7009 revocation of a refresh token on sign-out. Never
 * throws; the caller is already dropping the credentials.
 */
export async function revokeRefreshToken(serverUrl: string, tokens: OAuthTokens): Promise<void> {
  if (!tokens.refreshToken) return;
  try {
    const metadata = await discoverOAuthMetadata(serverUrl);
    const endpoint = metadata?.revocation_endpoint;
    if (!endpoint || !/^https?:\/\//i.test(endpoint)) return;
    const body = new URLSearchParams({
      token: tokens.refreshToken,
      token_type_hint: 'refresh_token',
      client_id: tokens.clientId,
    });
    await secureFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch {
    // ignore
  }
}
