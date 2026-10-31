import * as WebBrowser from 'expo-web-browser';
import { fetchWithoutForeignRedirect, secureFetch } from './client-cert';
import { base64UrlEncode, randomBytes, randomHex } from './random';
import { sha256Hex } from './sha256';

// Webmail-mediated login. The app opens the webmail's normal login page with
// extra `mobile_redirect_uri`, `mobile_state` and `mobile_code_challenge`
// query params. The webmail uses its existing password and OAuth flows, and
// once the user is signed in, redirects back to the app's custom scheme with
// a one-time code in the query string; the app redeems it with the PKCE
// verifier for the sign-in (another app that catches the link can't). Older
// webmails and Lite ignore the challenge and put the credentials in the URL
// fragment, which is still read.

export const HANDOFF_REDIRECT_URI = 'bulwarkmobile://auth/callback';

export type OAuthTokenSource = 'handoff' | 'pairing' | 'totp' | 'native';

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  tokenEndpoint: string;
  clientId: string;
  // Where the bundle came from. A paired phone gets its own grant: the
  // webmail mints a separate one for the device rather than handing over
  // the desktop's session. Its refresh token may be an opaque string only
  // the webmail's token proxy understands, and webmail up to 1.11 did share
  // the desktop's token, so sign-out leaves `pairing` bundles alone instead
  // of revoking them at the mail server; every other source is revoked.
  source?: OAuthTokenSource;
  // The OIDC id token of the sign-in, kept for ending the provider's
  // session at sign-out (id_token_hint). A refresh may hand out a new one.
  idToken?: string;
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

// Why a QR / link sign-in failed, so the login screen can say what to do next
// instead of one catch-all "expired" message.
//   expired / used / expired_or_used / invalid: the code itself (webmail up to
//     1.11 does not say which, hence `expired_or_used`)
//   unsupported: no redeem route at that address (old webmail, wrong link)
//   untrusted / insecure: the answer names a token endpoint or server the app
//     will not send credentials to
//   network / server / rate_limited / bad_response: the redeem request itself
//   connect_failed: the code was redeemed, but signing in to the mail server
//     with what it returned failed; the code is gone, a new one is needed
export type PairingErrorReason =
  | 'expired'
  | 'used'
  | 'expired_or_used'
  | 'invalid'
  | 'unsupported'
  | 'untrusted'
  | 'insecure'
  | 'network'
  | 'server'
  | 'rate_limited'
  | 'bad_response'
  | 'connect_failed';

export class PairingError extends Error {
  readonly reason: PairingErrorReason;
  /** Host the message is about: the webmail, or the mail server for `connect_failed`. */
  readonly host?: string;

  constructor(reason: PairingErrorReason, message?: string, opts?: { host?: string; cause?: unknown }) {
    super(message ?? `Pairing failed: ${reason}`);
    this.name = 'PairingError';
    this.reason = reason;
    this.host = opts?.host;
    if (opts?.cause !== undefined) this.cause = opts.cause;
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

/**
 * PKCE pair for the hand-off (bulwarkmail.org/docs/development/mobile-handoff):
 * a fresh 43-character verifier from the CSPRNG for every sign-in, and its
 * S256 challenge.
 */
export function createHandoffPkce(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(hexToBytes(sha256Hex(new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function buildHandoffUrl(webmailUrl: string, state: string, codeChallenge?: string): string {
  const base = webmailUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({
    mobile_redirect_uri: HANDOFF_REDIRECT_URI,
    mobile_state: state,
  });
  if (codeChallenge) params.set('mobile_code_challenge', codeChallenge);
  return `${base}/login?${params.toString()}`;
}

function parseFragment(url: string): URLSearchParams {
  const hashIdx = url.indexOf('#');
  if (hashIdx === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(hashIdx + 1));
}

function parseQuery(url: string): URLSearchParams {
  const q = url.indexOf('?');
  if (q === -1) return new URLSearchParams();
  const h = url.indexOf('#', q);
  return new URLSearchParams(url.slice(q + 1, h === -1 ? undefined : h));
}

/**
 * Why redeeming a hand-off code failed. Every failure spends the code, so the
 * sign-in has to start over.
 *   invalid_request / invalid_code / expired_code / invalid_verifier: the
 *     webmail's 400 answers
 *   rate_limited: 429; forbidden: 403 (a same-origin refusal)
 *   network / server / bad_response: the request itself
 */
export type HandoffRedeemReason =
  | 'invalid_request'
  | 'invalid_code'
  | 'expired_code'
  | 'invalid_verifier'
  | 'rate_limited'
  | 'forbidden'
  | 'network'
  | 'server'
  | 'bad_response';

export class HandoffRedeemError extends HandoffError {
  readonly reason: HandoffRedeemReason;
  readonly status?: number;

  constructor(reason: HandoffRedeemReason, message: string, status?: number) {
    super(message);
    this.name = 'HandoffRedeemError';
    this.reason = reason;
    this.status = status;
  }
}

export const HANDOFF_REDEEM_TIMEOUT_MS = 15_000;
const HANDOFF_400_REASONS: readonly HandoffRedeemReason[] = ['invalid_request', 'invalid_code', 'expired_code', 'invalid_verifier'];

/**
 * Trade the one-time code from the callback link for the parked sign-in.
 * Sent like every native request, without Origin or Sec-Fetch-Site, which
 * the route would refuse as cross-origin. The code is a credential, so a
 * redirect to another host is not followed.
 */
export async function redeemHandoffCode(
  webmailUrl: string,
  code: string,
  codeVerifier: string,
): Promise<Record<string, unknown>> {
  const base = webmailUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new HandoffRedeemError('network', 'Timed out redeeming the sign-in code'));
    }, HANDOFF_REDEEM_TIMEOUT_MS);
  });
  let status: number;
  let ok: boolean;
  let data: Record<string, unknown> | null;
  try {
    const exchange = (async () => {
      let response: Response;
      try {
        response = await fetchWithoutForeignRedirect(`${base}/api/auth/handoff/redeem`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ code, code_verifier: codeVerifier }),
          signal: controller.signal,
          timeoutMs: HANDOFF_REDEEM_TIMEOUT_MS,
        });
      } catch (err) {
        throw new HandoffRedeemError(
          'network',
          `Could not redeem the sign-in code: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return { status: response.status, ok: response.ok, data: await readJsonBody(response) };
    })();
    ({ status, ok, data } = await Promise.race([exchange, deadline]));
  } finally {
    clearTimeout(timer);
  }

  if (!ok) {
    const error = data ? stringField(data, 'error') : undefined;
    if (status === 400) {
      const reason = HANDOFF_400_REASONS.find((r) => r === error) ?? 'invalid_code';
      throw new HandoffRedeemError(reason, `The sign-in code was refused (${error ?? status}). Sign in again.`, status);
    }
    if (status === 429) throw new HandoffRedeemError('rate_limited', 'Too many sign-in attempts (429)', status);
    if (status === 403) throw new HandoffRedeemError('forbidden', 'The webmail refused the sign-in code (403)', status);
    throw new HandoffRedeemError('server', `Redeeming the sign-in code failed with status ${status}`, status);
  }
  if (!data) throw new HandoffRedeemError('bad_response', 'The sign-in response was not JSON', status);
  return data;
}

// Reads one field of the sign-in, from the fragment (strings) or the redeem
// answer (JSON, where expires_in is a number).
type BundleField = (key: string) => string | undefined;

async function handoffResultFrom(field: BundleField, webmailUrl: string): Promise<HandoffResult> {
  const flow = field('flow');
  const serverUrl = field('server_url') ?? null;
  if (!serverUrl) throw new HandoffError('Sign-in response missing server URL');
  if (!isHttpsUrl(serverUrl) && !isLoopbackHttp(serverUrl)) {
    throw new HandoffError('Sign-in response server URL must use https');
  }

  if (flow === 'password') {
    const username = field('username');
    const password = field('password');
    if (!username || !password) {
      throw new HandoffError('Sign-in response missing credentials');
    }
    return { flow: 'password', serverUrl, username, password };
  }

  if (flow === 'oauth') {
    const accessToken = field('access_token');
    const tokenEndpoint = field('token_endpoint');
    const clientId = field('client_id');
    if (!accessToken || !tokenEndpoint || !clientId) {
      throw new HandoffError('Sign-in response missing OAuth tokens');
    }
    if (!(await isTrustedHandoffEndpoint(tokenEndpoint, serverUrl, webmailUrl, clientId))) {
      throw new HandoffError('Sign-in response token endpoint is not trusted');
    }
    const refreshToken = field('refresh_token');
    const expiresIn = Number.parseInt(field('expires_in') ?? '', 10);
    return {
      flow: 'oauth',
      serverUrl,
      tokens: {
        accessToken,
        refreshToken,
        expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
        tokenEndpoint,
        clientId,
        source: 'handoff',
      },
    };
  }

  throw new HandoffError(`Unknown sign-in flow: ${flow ?? 'missing'}`);
}

export async function runWebmailHandoff(
  webmailUrl: string,
  opts?: { addAccount?: boolean },
): Promise<HandoffResult> {
  const state = randomState();
  // The redeem answer carries the sign-in, so it only goes over TLS (or
  // loopback http in development). A plain-http webmail gets no challenge
  // and answers in the fragment, as before.
  const pkce = isHttpsUrl(webmailUrl) || isLoopbackHttp(webmailUrl) ? createHandoffPkce() : null;
  const handoffUrl = buildHandoffUrl(webmailUrl, state, pkce?.challenge);

  // Adding an account: on iOS, keep the browser's webmail and identity
  // provider cookies out of the session so the signed-in account can't
  // silently come back as the "new" one. Android's Custom Tabs have no such
  // mode.
  const result = await WebBrowser.openAuthSessionAsync(
    handoffUrl,
    HANDOFF_REDIRECT_URI,
    opts?.addAccount ? { preferEphemeralSession: true } : undefined,
  );

  if (result.type === 'cancel' || result.type === 'dismiss') {
    throw new HandoffCancelledError();
  }
  if (result.type !== 'success' || !result.url) {
    throw new HandoffError(`Sign-in failed: ${result.type}`);
  }

  const fragment = parseFragment(result.url);
  const query = parseQuery(result.url);
  const err = fragment.get('error') ?? query.get('error');
  if (err) throw new HandoffError(err);

  // A webmail that got the challenge answers with a one-time code in the
  // query string; older webmails and Lite put the sign-in in the fragment.
  const code = query.get('code');
  if (pkce && code && !fragment.has('flow')) {
    // CSRF guard: the state must round-trip unchanged before the code is
    // spent; a link with another state didn't come from this sign-in.
    if (query.get('state') !== state) throw new HandoffError('State mismatch');
    const bundle = await redeemHandoffCode(webmailUrl, code, pkce.verifier);
    const echoed = stringField(bundle, 'state');
    if (echoed !== undefined && echoed !== state) throw new HandoffError('State mismatch');
    return handoffResultFrom((key) => {
      const value = bundle[key];
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      return typeof value === 'string' && value ? value : undefined;
    }, webmailUrl);
  }

  // CSRF guard: the state we generated must round-trip through the webmail
  // unchanged. A mismatch means the redirect didn't come from the flow we
  // started, and the rest of the fragment shouldn't be trusted.
  if (fragment.get('state') !== state) {
    throw new HandoffError('State mismatch');
  }

  return handoffResultFrom((key) => fragment.get(key) || undefined, webmailUrl);
}

// QR login payloads. A QR scanned on the login screen either bootstraps the
// server URL for the normal webmail handoff (`connect`), or carries a one-time
// cross-device pairing code minted by an already-signed-in webmail (`pair`).
// The payload never contains credentials — the `pair` code is redeemed for
// tokens over the network, once. The same `bulwarkmail://` links also arrive
// as deep links (a tapped link) and as pasted text.
export type QrLoginPayload =
  | { kind: 'connect'; webmailUrl: string }
  | { kind: 'pair'; webmailUrl: string; code: string };

// `bulwarkmail://pair?…` and `bulwarkmail://pair/?…` (Android and some QR
// readers add the slash after the host).
const SIGN_IN_LINK_RE = /^bulwarkmail:\/\/(connect|pair)\/?\?([^#]*)(?:#.*)?$/i;
// The webmail mints 64 hex characters; accept any URL-safe token of sane
// length so a future format does not break older apps.
const PAIRING_CODE_RE = /^[A-Za-z0-9_-]{8,512}$/;

export function parseQrLoginPayload(raw: string): QrLoginPayload | null {
  const trimmed = raw.trim();

  // Custom scheme: bulwarkmail://connect?server=... | bulwarkmail://pair?server=...&code=...
  const match = SIGN_IN_LINK_RE.exec(trimmed);
  if (match) {
    const kind = match[1].toLowerCase();
    const params = new URLSearchParams(match[2]);
    const server = params.get('server')?.trim();
    if (!server || !/^https?:\/\/[^/?#\s]+/i.test(server)) return null;
    if (kind === 'pair') {
      // The code is redeemed at this address, and the answer carries
      // credentials: only over TLS, or plain http on loopback for development.
      if (!isHttpsUrl(server) && !isLoopbackHttp(server)) return null;
      const code = params.get('code')?.trim();
      if (!code || !PAIRING_CODE_RE.test(code)) return null;
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

/**
 * The code is redeemed at the webmail, and the answer carries credentials:
 * only over TLS, or plain http on loopback for development.
 */
export function isInsecurePairingUrl(webmailUrl: string): boolean {
  return !isHttpsUrl(webmailUrl) && !isLoopbackHttp(webmailUrl);
}

/**
 * The host a sign-in link talks to, for the user to check. Read the way the
 * network stack reads the address: `https://mail.example.com@evil.example`
 * and `https://evil.example\@mail.example.com` both go to evil.example, so
 * that is the host named.
 */
export function signInLinkHost(url: string): string {
  const authority = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/\\?#]/)[0];
  return authority.slice(authority.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * Why parseQrLoginPayload refused a pairing link, when the reason is its
 * plain-http webmail (the code, and the credentials it buys, would cross the
 * network in clear), so a scanned, pasted or tapped link can say so instead
 * of "not a Bulwark sign-in code". Only ever an error to show: the parser
 * stays the one gate and never yields such a link. Takes the link alone or
 * pasted text around it; null for anything else.
 */
export function insecurePairingLinkError(text: string): PairingError | null {
  const link = (/bulwarkmail:\/\/\S+/i.exec(text)?.[0] ?? '').replace(/[)\]>.,;'"]+$/, '');
  const match = SIGN_IN_LINK_RE.exec(link);
  if (!match || match[1].toLowerCase() !== 'pair') return null;
  const params = new URLSearchParams(match[2]);
  const server = params.get('server')?.trim();
  const code = params.get('code')?.trim();
  if (!server || !/^http:\/\/[^/?#\s]+/i.test(server) || !isInsecurePairingUrl(server)) return null;
  if (!code || !PAIRING_CODE_RE.test(code)) return null;
  return new PairingError('insecure', 'Pairing needs an https webmail address', {
    host: signInLinkHost(server),
  });
}

/**
 * Pasted text: the link on its own, or a message that contains it ("Open
 * bulwarkmail://pair?… on your phone"). Falls back to the whole text so a
 * pasted webmail address still works like a scanned one.
 */
export function parsePastedSignInLink(text: string): QrLoginPayload | null {
  const embedded = /bulwarkmail:\/\/\S+/i.exec(text)?.[0];
  if (embedded) {
    const payload = parseQrLoginPayload(embedded.replace(/[)\]>.,;'"]+$/, ''));
    if (payload) return payload;
  }
  return parseQrLoginPayload(text);
}

export const PAIRING_REDEEM_TIMEOUT_MS = 15_000;

// Host (and port) for messages: "Can't reach mail.example.com".
function displayHost(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
}

// A JSON body, or null for an empty, HTML or otherwise unparseable one. A
// proxy error page or a webmail too old to have the route answers with HTML.
async function readJsonBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const data: unknown = await response.json();
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value ? value : undefined;
}

// Map a failed redeem onto what the user should do about it.
function redeemFailure(status: number, body: Record<string, unknown> | null, host: string): PairingError {
  const error = body ? stringField(body, 'error') : undefined;
  if (status === 410) {
    if (error === 'expired_code') return new PairingError('expired', 'The pairing code has expired', { host });
    if (error === 'used_code') return new PairingError('used', 'The pairing code was already used', { host });
    return new PairingError('expired_or_used', 'The pairing code has expired or was already used', { host });
  }
  if (status === 400) {
    if (error === 'invalid_code') return new PairingError('invalid', 'The pairing code is not valid', { host });
    // Webmail up to 1.11 answers every failure with a 400 and
    // "Invalid or expired pairing code" / "Missing pairing code".
    return new PairingError('expired_or_used', 'The pairing code has expired or was already used', { host });
  }
  if (status === 404 || status === 405 || (status >= 300 && status < 400)) {
    return new PairingError('unsupported', `No pairing endpoint at ${host} (${status})`, { host });
  }
  if (status === 429) return new PairingError('rate_limited', 'Too many pairing attempts (429)', { host });
  return new PairingError('server', `Pairing failed with status ${status}`, { host });
}

// Cross-device pairing redemption. Posts the scanned code to the webmail that
// minted it and maps the answer into the same shape the in-browser handoff
// produces: an OAuth token bundle for connectWithOAuth, or an app password
// (the account password on servers without app passwords) for login().
export async function redeemPairingCode(webmailUrl: string, code: string): Promise<HandoffResult> {
  const base = webmailUrl.replace(/\/+$/, '');
  const host = displayHost(base);
  // The login screen refuses these links already; never send a code in clear.
  if (isInsecurePairingUrl(base)) {
    throw new PairingError('insecure', 'Pairing needs an https webmail address', { host });
  }

  // secureFetch's native (client-certificate) path ignores `signal`, so the
  // deadline is also passed as `timeoutMs` and enforced here with a race; the
  // body read counts against it too.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PairingError('network', `Timed out reaching ${host}`, { host }));
    }, PAIRING_REDEEM_TIMEOUT_MS);
  });

  let status: number;
  let ok: boolean;
  let data: Record<string, unknown> | null;
  try {
    const exchange = (async () => {
      let response: Response;
      try {
        // The code is a one-time credential: never let a redirect carry it
        // to another host.
        response = await fetchWithoutForeignRedirect(`${base}/api/auth/pair/redeem`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ pairing_code: code }),
          signal: controller.signal,
          timeoutMs: PAIRING_REDEEM_TIMEOUT_MS,
        });
      } catch (err) {
        throw new PairingError(
          'network',
          `Could not reach ${host}: ${err instanceof Error ? err.message : String(err)}`,
          { host, cause: err },
        );
      }
      return { status: response.status, ok: response.ok, data: await readJsonBody(response) };
    })();
    ({ status, ok, data } = await Promise.race([exchange, deadline]));
  } finally {
    clearTimeout(timer);
  }

  if (!ok) throw redeemFailure(status, data, host);
  if (!data) throw new PairingError('bad_response', 'The pairing response was not JSON', { host });

  const serverUrl = stringField(data, 'server_url');
  if (!serverUrl) throw new PairingError('bad_response', 'Pairing response missing server URL', { host });
  if (!isHttpsUrl(serverUrl) && !isLoopbackHttp(serverUrl)) {
    throw new PairingError('insecure', 'Pairing response server URL must use https', { host });
  }

  // Webmail up to 1.11 always sends `flow: 'oauth'`; a bundle without the
  // field but with a token is the same thing.
  const flow = stringField(data, 'flow') ?? (stringField(data, 'access_token') ? 'oauth' : undefined);

  if (flow === 'password') {
    const username = stringField(data, 'username');
    const password = stringField(data, 'password');
    if (!username || !password) {
      throw new PairingError('bad_response', 'Pairing response missing credentials', { host });
    }
    return { flow: 'password', serverUrl, username, password };
  }

  if (flow === 'oauth') {
    const accessToken = stringField(data, 'access_token');
    const tokenEndpoint = stringField(data, 'token_endpoint');
    const clientId = stringField(data, 'client_id');
    if (!accessToken || !tokenEndpoint || !clientId) {
      throw new PairingError('bad_response', 'Pairing response missing token material', { host });
    }
    // The mail server's own host, the webmail's token proxy
    // (`<webmail>/api/auth/pair/token`), or an external identity provider the
    // webmail itself names; nothing else gets the refresh token.
    if (!(await isTrustedHandoffEndpoint(tokenEndpoint, serverUrl, base, clientId))) {
      throw new PairingError('untrusted', 'Pairing response token endpoint is not trusted', { host });
    }
    const expiresIn = typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) ? data.expires_in : undefined;
    return {
      flow: 'oauth',
      serverUrl,
      tokens: {
        accessToken,
        refreshToken: stringField(data, 'refresh_token'),
        expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
        tokenEndpoint,
        clientId,
        source: 'pairing',
      },
    };
  }

  throw new PairingError('bad_response', `Unknown pairing flow: ${flow ?? 'missing'}`, { host });
}

const activeRefreshes = new Map<string, Promise<OAuthTokens>>();

// Stalwart 1.0 rotates refresh tokens, and a superseded one presented after
// its successor was used revokes the whole grant (access token 401, current
// refresh token invalid_grant; checked on 1.0.0). Several holders refresh the
// same account from their own copy of the bundle: the live client, the
// unified inbox, the background push task. One that still holds the old
// token after another rotated it gets the successor here instead of spending
// the dead token and signing the account out.
const rotatedTo = new Map<string, OAuthTokens>();
const ROTATED_MAX = 64;
// A successor whose access token has less left than this is refreshed in
// turn rather than handed out.
const SUCCESSOR_MIN_LIFETIME_MS = 60_000;
// Refresh tokens whose chain was dropped on sign-out. A refresh that was in
// flight then returns afterwards and must not put the chain back.
const forgotten = new Set<string>();
const FORGOTTEN_MAX = 256;

function markForgotten(refreshToken: string): void {
  forgotten.delete(refreshToken);
  if (forgotten.size >= FORGOTTEN_MAX) {
    const oldest = forgotten.values().next().value;
    if (oldest !== undefined) forgotten.delete(oldest);
  }
  forgotten.add(refreshToken);
}

function rememberRotation(previous: string, next: OAuthTokens): void {
  if (!next.refreshToken || next.refreshToken === previous) return;
  if (forgotten.has(previous)) {
    markForgotten(next.refreshToken);
    return;
  }
  if (!rotatedTo.has(previous) && rotatedTo.size >= ROTATED_MAX) {
    const oldest = rotatedTo.keys().next().value;
    if (oldest !== undefined) rotatedTo.delete(oldest);
  }
  rotatedTo.set(previous, next);
}

function latestRotation(refreshToken: string): OAuthTokens | null {
  let latest: OAuthTokens | null = null;
  let key = refreshToken;
  for (let hop = 0; hop < ROTATED_MAX; hop++) {
    const next = rotatedTo.get(key);
    if (!next?.refreshToken) break;
    latest = next;
    key = next.refreshToken;
  }
  return latest;
}

/** Test hook. */
export function resetRefreshRotations(): void {
  rotatedTo.clear();
  forgotten.clear();
}

/**
 * Drop the rotation chain `refreshToken` is part of, its predecessors and
 * successors both, when its account signs out. A stale copy of the bundle
 * refreshed later would otherwise get the successor from here and could
 * write the removed account's tokens back. A refresh of the chain still in
 * flight doesn't add it again when it returns.
 */
export function forgetRefreshRotations(refreshToken: string | undefined): void {
  if (!refreshToken) return;
  const chain = new Set<string>([refreshToken]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [previous, next] of rotatedTo) {
      const linked = chain.has(previous) || (!!next.refreshToken && chain.has(next.refreshToken));
      if (!linked) continue;
      if (!chain.has(previous)) { chain.add(previous); grew = true; }
      if (next.refreshToken && !chain.has(next.refreshToken)) { chain.add(next.refreshToken); grew = true; }
    }
  }
  for (const token of chain) {
    rotatedTo.delete(token);
    markForgotten(token);
  }
}

// OAuth refresh — exchanges the refresh token at the original token endpoint
// for a new access token. Returns the updated bundle so the caller can
// persist it.
export async function refreshOAuthAccessToken(tokens: OAuthTokens): Promise<OAuthTokens> {
  if (!tokens.refreshToken) {
    throw new HandoffError('No refresh token available');
  }

  const successor = latestRotation(tokens.refreshToken);
  if (successor) {
    if (successor.expiresAt == null || successor.expiresAt - Date.now() > SUCCESSOR_MIN_LIFETIME_MS) {
      return { ...successor, source: tokens.source };
    }
    return refreshOAuthAccessToken({ ...successor, source: tokens.source });
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
        // The refresh token goes in the body: a redirect to another host than
        // the token endpoint's own comes back unfollowed (a transient failure
        // below) instead of taking the token along.
        let response: Response;
        try {
          response = await fetchWithoutForeignRedirect(tokens.tokenEndpoint, {
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
        // A 200 that is not JSON is a captive portal or a proxy page, not an
        // answer from the token endpoint; the refresh token may still be
        // good, so keep the account (a SyntaxError here used to evict it).
        let data: {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          id_token?: string;
        };
        try {
          data = (await response.json()) as typeof data;
        } catch (err) {
          throw new TransientRefreshError(
            `Token refresh response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (!data || typeof data !== 'object') {
          throw new TransientRefreshError('Token refresh response was not a JSON object');
        }
        if (!data.access_token) {
          throw new HandoffError('Token refresh response missing access_token');
        }
        const next: OAuthTokens = {
          accessToken: data.access_token,
          refreshToken: data.refresh_token ?? tokens.refreshToken!,
          expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
          tokenEndpoint: tokens.tokenEndpoint,
          clientId: tokens.clientId,
          source: tokens.source,
          idToken: typeof data.id_token === 'string' && data.id_token ? data.id_token : tokens.idToken,
        };
        rememberRotation(cacheKey, next);
        return next;
      } finally {
        activeRefreshes.delete(cacheKey);
      }
    })();
    activeRefreshes.set(cacheKey, promise);
  }

  return promise;
}

WebBrowser.maybeCompleteAuthSession();
