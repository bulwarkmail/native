// Password + TOTP login against Stalwart's structured auth endpoint.
//
// Stalwart 0.16+ no longer accepts the legacy `password$totp` convention over
// HTTP Basic auth: its Basic decoder hardcodes `mfa_token: None`, so a TOTP
// appended to the password is verified verbatim against the password hash and
// fails. The MFA token must be supplied as a distinct field through
// `POST {server}/api/auth`, which answers with a short-lived authorization
// code that `POST {server}/auth/token` exchanges (with PKCE) for OAuth
// tokens. The webmail drives the same two steps server-side in
// lib/auth/stalwart-password-login.ts; a native client has no CORS
// constraint and talks to the mail server directly.
//
// The two server lines speak different dialects (webmail
// lib/auth/stalwart-login-request.ts):
// - 0.16 takes the authorization parameters as fields (`clientId`,
//   `redirectUri`, `codeChallenge`, ...), accepts any client id and answers
//   `{ type: "authenticated", client_code }`.
// - 1.0 takes the authorization request as a query string (`query`), wants
//   `consent: true`, knows only registered clients and answers
//   `{ type: "authenticated", location }`, the redirect URI carrying the code.
//   A body without `query` gets a 400 "JSON deserialization failed".
// Neither rejects fields it doesn't know, so one body serves both.
//
// Token auth also survives TOTP rotation, unlike Basic auth, which would have
// to embed the ~30 s code in every request.

import { mayFollowRedirect, secureFetch } from './client-cert';
import { sha256Hex } from './sha256';
import { base64UrlEncode, randomBytes, randomHex } from './random';
import { HANDOFF_REDIRECT_URI, type OAuthTokens } from './oauth';
import { NetworkError } from '../api/jmap-client';

// Stalwart 0.16's built-in OAuth accepts any client id; the webmail's public
// one keeps refresh behaviour identical to the browser-handoff bundle.
export const DEFAULT_CLIENT_ID = 'bulwark-webmail';

/**
 * Redirect URI of the client the app registers at a Stalwart 1.0 that knows
 * no client for it. 1.0 lets a public client register only a loopback URI or
 * a private-use scheme with a dot in it (RFC 8252), which `bulwarkmobile://`
 * is not; this one is the iOS bundle id. The password login never visits it
 * (/api/auth hands the location back); the browser sign-in comes back on it,
 * so the app registers the scheme too.
 */
export const REGISTERED_REDIRECT_URI = 'org.bulwarkmail.mobile:/auth/callback';

/**
 * The data scopes Stalwart 1.0 grants a client that isn't first-party. A
 * token reaches only what these name (no scope: nothing but the session);
 * 0.16 ignores them.
 */
export const STALWART_DATA_SCOPES = [
  'urn:ietf:params:oauth:scope:mail',
  'urn:ietf:params:oauth:scope:contacts',
  'urn:ietf:params:oauth:scope:calendars',
  'urn:ietf:params:oauth:scope:files',
];

export const STALWART_LOGIN_SCOPE = ['openid', 'offline_access', ...STALWART_DATA_SCOPES].join(' ');

export class LoginEndpointMissingError extends Error {
  constructor() {
    super('Structured login endpoint not available');
    this.name = 'LoginEndpointMissingError';
  }
}

export class TotpLoginError extends Error {
  // `client_rejected`: the server refused the app as an OAuth client (1.0:
  // registration refused or the authorization request itself rejected),
  // before it looked at the credentials.
  code: 'invalid_credentials' | 'totp_required' | 'login_failed' | 'token_exchange_failed' | 'client_rejected';
  constructor(code: TotpLoginError['code'], message?: string) {
    super(message ?? code);
    this.name = 'TotpLoginError';
    this.code = code;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function generateCodeVerifier(): string {
  // 32 random bytes → 43 base64url chars, inside RFC 7636's 43..128 window.
  return base64UrlEncode(randomBytes(32));
}

export function generateCodeChallenge(verifier: string): string {
  const digest = sha256Hex(new TextEncoder().encode(verifier));
  return base64UrlEncode(hexToBytes(digest));
}

// ── Which client the app signs in as ───────────────────────

export interface LoginClient {
  clientId: string;
  redirectUri: string;
}

const CLIENT_CHECK_TIMEOUT_MS = 8_000;
const CLIENT_CACHE_MAX = 32;
// Per server. 1.0's registered client ids are stateless (sealed with the
// server's key): the same metadata registers to the same id again, so a lost
// cache costs a round trip, never a sign-in. The token bundle keeps the id it
// was issued to, which is what refresh and revocation present.
const loginClients = new Map<string, LoginClient>();

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Test hook. */
export function resetLoginClients(): void {
  loginClients.clear();
}

function rememberClient(base: string, client: LoginClient): void {
  if (!loginClients.has(base) && loginClients.size >= CLIENT_CACHE_MAX) {
    const oldest = loginClients.keys().next().value;
    if (oldest !== undefined) loginClients.delete(oldest);
  }
  loginClients.set(base, client);
}

function withTimeout(ms: number): { signal?: AbortSignal; done: () => void } {
  if (typeof AbortController === 'undefined') return { done: () => undefined };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

// The password and the PKCE verifier must not follow a redirect to another
// host. The platform fetch follows redirects itself, so the check is on where
// the answer came from; the client check below runs first and is a plain GET,
// which keeps the password from being posted anywhere the server redirects.
function assertSameServer(requested: string, response: Response): void {
  if (response.redirected && response.url && !mayFollowRedirect(requested, response.url)) {
    throw new TotpLoginError('login_failed', `${requested} redirects to another host`);
  }
}

/** RFC 7591 registration as a public client, which 1.0 allows without credentials. */
async function registerPublicClient(base: string): Promise<LoginClient> {
  const url = `${base}/auth/register`;
  const t = withTimeout(CLIENT_CHECK_TIMEOUT_MS);
  let response: Response;
  try {
    response = await secureFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Bulwark Mobile',
        redirect_uris: [REGISTERED_REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: STALWART_LOGIN_SCOPE,
      }),
      signal: t.signal,
      timeoutMs: CLIENT_CHECK_TIMEOUT_MS,
    });
  } catch (err) {
    throw new NetworkError(err instanceof Error ? err.message : 'Server unreachable');
  } finally {
    t.done();
  }
  assertSameServer(url, response);
  const body = (await response.json().catch(() => null)) as { client_id?: unknown; error?: unknown } | null;
  if (!response.ok || typeof body?.client_id !== 'string' || !body.client_id) {
    const reason = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new TotpLoginError('client_rejected', `The server refused to register the app (${reason})`);
  }
  const client = { clientId: body.client_id, redirectUri: REGISTERED_REDIRECT_URI };
  rememberClient(base, client);
  return client;
}

/**
 * The OAuth client to sign in to `serverUrl` as. Stalwart 1.0's client check
 * (GET /api/auth/client, which 0.16 doesn't have) says whether it knows the
 * webmail's client id with the app's redirect URI; when it doesn't, the app
 * registers its own public client. Any other server, and 0.16, gets
 * `bulwark-webmail` as before. Unreachable: the default, uncached, and the
 * request that needs it fails on its own.
 */
export async function resolveLoginClient(serverUrl: string): Promise<LoginClient> {
  const base = trimBase(serverUrl);
  const cached = loginClients.get(base);
  if (cached) return cached;
  const fallback: LoginClient = { clientId: DEFAULT_CLIENT_ID, redirectUri: HANDOFF_REDIRECT_URI };
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: DEFAULT_CLIENT_ID,
    redirect_uri: HANDOFF_REDIRECT_URI,
    state: 'probe',
    code_challenge: 'A'.repeat(43),
    code_challenge_method: 'S256',
  });
  const url = `${base}/api/auth/client?${query.toString()}`;
  const t = withTimeout(CLIENT_CHECK_TIMEOUT_MS);
  let response: Response;
  try {
    response = await secureFetch(url, {
      headers: { Accept: 'application/json' },
      signal: t.signal,
      timeoutMs: CLIENT_CHECK_TIMEOUT_MS,
    });
  } catch {
    return fallback;
  } finally {
    t.done();
  }
  if (!response || typeof response.status !== 'number') return fallback;
  assertSameServer(url, response);
  // 0.16 and servers that aren't Stalwart: no such endpoint.
  if (!response.ok) {
    rememberClient(base, fallback);
    return fallback;
  }
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (!body || typeof body !== 'object') {
    rememberClient(base, fallback);
    return fallback;
  }
  // `invalid_client` (unknown id) or a redirect URI the admin's client
  // doesn't list: either way the webmail's client isn't the app's to use.
  if (typeof body.error === 'string' && body.error) return registerPublicClient(base);
  rememberClient(base, fallback);
  return fallback;
}

// ── /api/auth request and answer ───────────────────────────

export interface StalwartLoginRequest {
  username: string;
  password: string;
  totp?: string;
  clientId: string;
  redirectUri: string;
  /** S256 PKCE challenge. */
  codeChallenge: string;
  /** Echoed back in 1.0's redirect location. */
  state: string;
}

export function stalwartLoginBody(req: StalwartLoginRequest): Record<string, unknown> {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: req.clientId,
    redirect_uri: req.redirectUri,
    state: req.state,
    scope: STALWART_LOGIN_SCOPE,
    code_challenge: req.codeChallenge,
    code_challenge_method: 'S256',
  });
  return {
    type: 'authCode',
    accountName: req.username,
    accountSecret: req.password,
    ...(req.totp ? { mfaToken: req.totp } : {}),
    // Stalwart 0.16
    clientId: req.clientId,
    redirectUri: req.redirectUri,
    codeChallenge: req.codeChallenge,
    codeChallengeMethod: 'S256',
    // Stalwart 1.0. The user typed the password into the app's own sign-in
    // form, which is the consent the server would otherwise ask for.
    query: query.toString(),
    consent: true,
  };
}

export type StalwartLoginOutcome =
  | { kind: 'code'; code: string }
  | { kind: 'mfa_required' }
  | { kind: 'invalid_credentials' }
  /**
   * The server refused the authorization request itself (1.0: unknown
   * client, redirect URI not registered, scope not allowed), before looking
   * at the credentials.
   */
  | { kind: 'rejected'; error: string; description?: string };

function locationParams(location: string): URLSearchParams | null {
  // A private-use scheme isn't something every URL parser takes apart, so
  // read the query by hand.
  const q = location.indexOf('?');
  if (q < 0) return null;
  const h = location.indexOf('#', q);
  return new URLSearchParams(location.slice(q + 1, h >= 0 ? h : undefined));
}

/** Reads the JSON answer of POST /api/auth (HTTP 200) of either server line. */
export function readStalwartLoginResponse(body: unknown, state: string): StalwartLoginOutcome {
  const res = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  switch (res.type) {
    case 'authenticated': {
      // The response keeps snake_case: only the LoginResponse variant tags
      // are camelCased server-side, not the struct fields.
      if (typeof res.client_code === 'string' && res.client_code) {
        return { kind: 'code', code: res.client_code };
      }
      const params = typeof res.location === 'string' ? locationParams(res.location) : null;
      const code = params?.get('code');
      if (!code) return { kind: 'rejected', error: 'missing_code' };
      if (params?.get('state') !== state) return { kind: 'rejected', error: 'state_mismatch' };
      return { kind: 'code', code };
    }
    case 'mfaRequired':
      return { kind: 'mfa_required' };
    case 'invalid':
      return {
        kind: 'rejected',
        error: typeof res.error === 'string' ? res.error : 'invalid_request',
        ...(typeof res.description === 'string' ? { description: res.description } : {}),
      };
    case 'redirect': {
      // 1.0 sends errors it may show the client to the redirect URI.
      const params = typeof res.location === 'string' ? locationParams(res.location) : null;
      const description = params?.get('error_description');
      return {
        kind: 'rejected',
        error: params?.get('error') || 'access_denied',
        ...(description ? { description } : {}),
      };
    }
    default:
      return { kind: 'invalid_credentials' };
  }
}

async function requestLoginCode(
  base: string,
  username: string,
  password: string,
  totp: string | undefined,
  client: LoginClient,
  challenge: string,
): Promise<StalwartLoginOutcome> {
  const state = randomHex(16);
  const url = `${base}/api/auth`;
  let loginResponse: Response;
  try {
    loginResponse = await secureFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(stalwartLoginBody({
        username,
        password,
        totp,
        clientId: client.clientId,
        redirectUri: client.redirectUri,
        codeChallenge: challenge,
        state,
      })),
    });
  } catch (err) {
    throw new NetworkError(err instanceof Error ? err.message : 'Server unreachable');
  }
  assertSameServer(url, loginResponse);

  if (loginResponse.status === 404) throw new LoginEndpointMissingError();
  if (!loginResponse.ok) {
    throw new TotpLoginError('login_failed', `Login failed: ${loginResponse.status}`);
  }
  let body: unknown;
  try {
    body = await loginResponse.json();
  } catch {
    throw new TotpLoginError('login_failed', 'Login response was not JSON');
  }
  return readStalwartLoginResponse(body, state);
}

/**
 * Exchange username + password (+ TOTP) for an OAuth token bundle. Throws
 * `LoginEndpointMissingError` when the server predates the structured
 * endpoint (404) so the caller can fall back to legacy Basic auth,
 * `TotpLoginError` for rejected credentials or a refused client,
 * `NetworkError` when unreachable.
 */
export async function exchangePasswordForTokens(
  serverUrl: string,
  username: string,
  password: string,
  totp?: string,
  opts?: { clientId?: string; redirectUri?: string },
): Promise<OAuthTokens> {
  const base = trimBase(serverUrl);
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);

  let client: LoginClient = opts?.clientId
    ? { clientId: opts.clientId, redirectUri: opts.redirectUri ?? HANDOFF_REDIRECT_URI }
    : await resolveLoginClient(base);
  let outcome = await requestLoginCode(base, username, password, totp, client, challenge);
  // A remembered client the server no longer knows (another server now
  // answers at the address, or its key changed): ask again, once. 1.0 checks
  // the client before the credentials, so this costs no failed sign-in.
  if (outcome.kind === 'rejected' && outcome.error === 'invalid_client' && !opts?.clientId && loginClients.has(base)) {
    loginClients.delete(base);
    const fresh = await resolveLoginClient(base);
    if (fresh.clientId !== client.clientId) {
      client = fresh;
      outcome = await requestLoginCode(base, username, password, totp, client, challenge);
    }
  }

  switch (outcome.kind) {
    case 'code':
      break;
    case 'mfa_required':
      throw new TotpLoginError('totp_required', 'TOTP_REQUIRED');
    case 'invalid_credentials':
      throw new TotpLoginError('invalid_credentials', 'Invalid username, password or code');
    case 'rejected':
      throw new TotpLoginError(
        outcome.error === 'missing_code' || outcome.error === 'state_mismatch' ? 'login_failed' : 'client_rejected',
        `Sign-in refused: ${[outcome.error, outcome.description].filter(Boolean).join(': ')}`,
      );
  }

  const tokenParams = new URLSearchParams({
    grant_type: 'authorization_code',
    code: outcome.code,
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    code_verifier: verifier,
  });

  const tokenUrl = `${base}/auth/token`;
  let tokenResponse: Response;
  try {
    tokenResponse = await secureFetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: tokenParams.toString(),
    });
  } catch (err) {
    throw new NetworkError(err instanceof Error ? err.message : 'Server unreachable');
  }
  assertSameServer(tokenUrl, tokenResponse);
  if (!tokenResponse.ok) {
    throw new TotpLoginError('token_exchange_failed', `Token exchange failed: ${tokenResponse.status}`);
  }
  const tokens = (await tokenResponse.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };
  if (!tokens.access_token) {
    throw new TotpLoginError('token_exchange_failed', 'Token response missing access_token');
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
    tokenEndpoint: tokenUrl,
    clientId: client.clientId,
    source: 'totp',
  };
}
