import * as SecureStore from 'expo-secure-store';
import type {
  JMAPSession,
  JMAPMethodCall,
  JMAPRequestBody,
  JMAPResponseBody,
} from './types';
import { CAPABILITIES } from './types';
import { generateAccountId } from '../lib/account-utils';
import { secureFetch, mayFollowRedirect } from '../lib/client-cert';
import {
  refreshOAuthAccessToken,
  TransientRefreshError,
  type OAuthTokens,
  type OAuthTokenSource,
} from '../lib/oauth';
import { FirstTouchGate } from './first-touch-gate';

// Refresh OAuth access tokens this many ms before they actually expire so
// in-flight requests don't race the expiry window.
const TOKEN_REFRESH_LEEWAY_MS = 60_000;

// Deadline on response headers for an ordinary JMAP call, and for blob
// transfers (uploads/downloads can legitimately take minutes on cellular).
// Mirrors the webmail's REQUEST_TIMEOUT_MS / blob timeout (#702): iOS suspends
// sockets in the background and hands back dead pooled connections on resume;
// without a deadline a send or save hangs forever.
export const REQUEST_TIMEOUT_MS = 30_000;
export const BLOB_TIMEOUT_MS = 300_000;

// Base back-off per attempt when the server refuses a request for being one
// too many in parallel (maxConcurrentRequests, #780).
const CONCURRENT_REQUEST_RETRY_DELAYS_MS = [200, 400, 800];

// Delay before the single transient-network retry of an idempotent request.
const TRANSIENT_RETRY_DELAY_MS = 1000;

const LEGACY_CREDENTIALS_KEY = 'jmap_credentials';
const CREDENTIALS_PREFIX = 'jmap_credentials__';

// SecureStore keys: letters, digits, ".", "-", "_" only - no "@" or "/".
function credentialsKey(accountId: string): string {
  return CREDENTIALS_PREFIX + accountId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export interface StoredCredentials {
  serverUrl: string;
  username: string;
  password: string;
  accessToken?: string;
  // OAuth-only — present when credentials came in via the webmail handoff
  // OAuth path rather than password auth. The token endpoint and client id
  // are needed for refresh; without them the access token would just expire.
  refreshToken?: string;
  expiresAt?: number;
  tokenEndpoint?: string;
  clientId?: string;
  tokenSource?: OAuthTokenSource;
}

/**
 * RFC 8620 §3.6.1 limit error naming the server's parallel-request ceiling.
 * Stalwart refuses the surplus of a burst with 400 jmap:error:limit /
 * maxConcurrentRequests BEFORE any method runs, so the request is safe to
 * replay - even a /set.
 */
export function isConcurrentRequestRefusal(status: number, body: string): boolean {
  if (status !== 400) return false;
  try {
    const parsed = JSON.parse(body) as { type?: unknown; limit?: unknown } | null;
    return (
      parsed?.type === 'urn:ietf:params:jmap:error:limit' &&
      parsed?.limit === 'maxConcurrentRequests'
    );
  } catch {
    return false;
  }
}

/**
 * Seconds or HTTP-date `Retry-After`, capped at 5 minutes, defaulting to 60 s
 * when missing or unparseable (an HTTP-date used to turn into `NaN` ms).
 */
export function parseRetryAfter(header: string | null): number {
  if (!header) return 60_000;
  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 300_000);
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const ms = date - Date.now();
    return ms > 0 ? Math.min(ms, 300_000) : 60_000;
  }
  return 60_000;
}

// Methods whose bodies must never be replayed automatically: a retried
// EmailSubmission/set would send the mail twice.
function hasNonIdempotentMethod(methodCalls: ReadonlyArray<JMAPMethodCall>): boolean {
  return methodCalls.some(
    ([name]) =>
      name === 'EmailSubmission/set' ||
      name === 'Email/import' ||
      name === 'Blob/upload',
  );
}

function fetchSessionDescribes(session: unknown): session is JMAPSession {
  if (!session || typeof session !== 'object') return false;
  const s = session as Partial<JMAPSession>;
  return typeof s.apiUrl === 'string';
}

/**
 * `url` with the scheme and host lowercased and a default port dropped, so a
 * response's final URL can be compared with the requested one.
 */
function canonicalUrl(url: string): string {
  const m = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(url);
  if (!m) return url;
  const scheme = m[1].toLowerCase();
  const host = m[2].toLowerCase().replace(scheme === 'https' ? /:443$/ : /:80$/, '');
  return `${scheme}://${host}${m[3]}`;
}

// Shared response helpers live in ./jmap-result (dependency-free) and are
// re-exported here for convenience.
export {
  JMAPMethodError, requireMethodResult, assertSetResult, batched, ScheduleTooLateError, parseHoldLimit,
} from './jmap-result';

/**
 * Stalwart advertises `maxDelayedSend` as a fixed 30 days, while its MTA
 * rejects any hold beyond the `futureRelease` limit, 7 days by default.
 */
const STALWART_ADVERTISED_MAX_DELAYED_SEND = 30 * 24 * 60 * 60;
const STALWART_DEFAULT_MAX_HOLD = 7 * 24 * 60 * 60;

export class JMAPClient {
  private session: JMAPSession | null = null;
  private credentials: StoredCredentials | null = null;
  private _accountId: string | null = null;
  private firstTouchGate = new FirstTouchGate();
  private rateLimitedUntil = 0;
  private authFailureListeners = new Set<(err: AuthenticationError) => void>();
  private rateLimitListeners = new Set<(retryAfterMs: number) => void>();
  private tokenRefreshListeners = new Set<() => void>();
  /** Hold limits learned from rejected scheduled sends, per server (seconds). */
  private learnedHoldLimits = new Map<string, number>();

  get accountId(): string {
    if (!this._accountId) {
      throw new Error('Not authenticated - call connect() first');
    }
    return this._accountId;
  }

  get currentSession(): JMAPSession | null {
    return this.session;
  }

  get username(): string | null {
    return this.credentials?.username ?? null;
  }

  get serverUrl(): string | null {
    return this.credentials?.serverUrl ?? null;
  }

  // True when the session authenticates with a Bearer token (OAuth handoff or
  // token login) rather than a username/password. Used by the security screen
  // to hide password/TOTP management, which only applies to password accounts.
  get usesBearerAuth(): boolean {
    return !!this.credentials?.accessToken;
  }

  get isConnected(): boolean {
    return this.session !== null && this._accountId !== null;
  }

  // ── Lifecycle hooks ───────────────────────────────────
  // The auth store subscribes to auth failures so a revoked token/password
  // leads back to the login screen instead of a dead session; the offline
  // banner subscribes to rate-limit windows; the live-update layer recreates
  // the SSE stream whenever the bearer token rotates.

  onAuthFailure(listener: (err: AuthenticationError) => void): () => void {
    this.authFailureListeners.add(listener);
    return () => this.authFailureListeners.delete(listener);
  }

  onRateLimit(listener: (retryAfterMs: number) => void): () => void {
    this.rateLimitListeners.add(listener);
    return () => this.rateLimitListeners.delete(listener);
  }

  onTokenRefresh(listener: () => void): () => void {
    this.tokenRefreshListeners.add(listener);
    return () => this.tokenRefreshListeners.delete(listener);
  }

  private notifyAuthFailure(err: AuthenticationError): void {
    for (const l of this.authFailureListeners) {
      try { l(err); } catch { /* listener errors must not mask the request */ }
    }
  }

  isRateLimited(): boolean {
    return this.rateLimitedUntil > Date.now();
  }

  rateLimitRemainingMs(): number {
    return Math.max(0, this.rateLimitedUntil - Date.now());
  }

  private setRateLimited(retryAfterMs: number): void {
    this.rateLimitedUntil = Date.now() + retryAfterMs;
    for (const l of this.rateLimitListeners) {
      try { l(retryAfterMs); } catch { /* ignore */ }
    }
  }

  // ── Authentication ────────────────────────────────────

  // Public so blob upload/download helpers (which can't go through the JMAP
  // request body) can fetch the same Authorization header the rest of the
  // client uses. The value is recomputed each access and never cached.
  get authHeader(): string {
    if (!this.credentials) throw new Error('No credentials');
    if (this.credentials.accessToken) {
      return `Bearer ${this.credentials.accessToken}`;
    }
    const encoded = btoa(`${this.credentials.username}:${this.credentials.password}`);
    return `Basic ${encoded}`;
  }

  /**
   * Password login. When the server answers 402 "MFA code required" and no
   * `totp` was supplied, throws `TotpRequiredError` so the UI can ask for a
   * code. With a code, Stalwart 0.16+ no longer accepts the legacy
   * `password$totp` Basic convention, so the structured login endpoint is used
   * to obtain OAuth tokens (see `connectWithTotp`).
   */
  async connect(
    serverUrl: string,
    username: string,
    password: string,
    totp?: string,
  ): Promise<JMAPSession> {
    const baseUrl = serverUrl.replace(/\/+$/, '');
    if (totp) {
      return this.connectWithTotp(baseUrl, username, password, totp);
    }
    this.credentials = { serverUrl: baseUrl, username, password };

    this.session = this.rewriteSessionUrls(await this.fetchSession(baseUrl), baseUrl);
    this._accountId = this.resolveAccountId(this.session);
    this.firstTouchGate.reset();

    const accountId = generateAccountId(username, baseUrl);
    await SecureStore.setItemAsync(
      credentialsKey(accountId),
      JSON.stringify(this.credentials),
    );

    return this.session;
  }

  /**
   * TOTP login through Stalwart's structured auth endpoint (`/api/auth` with a
   * separate `mfaToken`, then `/auth/token` with PKCE). The resulting bundle is
   * persisted as an OAuth account so the normal refresh path keeps it alive.
   * Falls back to the legacy `password$totp` Basic convention when the server
   * predates the structured endpoint (404).
   */
  private async connectWithTotp(
    baseUrl: string,
    username: string,
    password: string,
    totp: string,
  ): Promise<JMAPSession> {
    const { exchangePasswordForTokens, LoginEndpointMissingError } = await import('../lib/totp-login');
    let tokens: OAuthTokens;
    try {
      tokens = await exchangePasswordForTokens(baseUrl, username, password, totp);
    } catch (err) {
      if (err instanceof LoginEndpointMissingError) {
        // Pre-0.16 Stalwart: TOTP rides along in the Basic password.
        return this.connect(baseUrl, username, `${password}$${totp}`);
      }
      throw err;
    }
    const { session } = await this.connectWithOAuth(baseUrl, tokens, username);
    return session;
  }

  async connectWithToken(serverUrl: string, accessToken: string): Promise<JMAPSession> {
    const baseUrl = serverUrl.replace(/\/+$/, '');
    this.credentials = { serverUrl: baseUrl, username: '', password: '', accessToken };

    this.session = this.rewriteSessionUrls(await this.fetchSession(baseUrl), baseUrl);
    this._accountId = this.resolveAccountId(this.session);
    this.firstTouchGate.reset();

    return this.session;
  }

  // OAuth login via webmail handoff. The webmail did the OAuth dance against
  // Stalwart and handed us a complete token bundle. We persist the bundle
  // so subsequent launches can refresh without prompting the user again.
  // `preferredUsername` (the address the user typed) wins over the session's
  // `username`, which for OIDC logins may be a bare `preferred_username`.
  async connectWithOAuth(
    serverUrl: string,
    tokens: OAuthTokens,
    preferredUsername?: string,
  ): Promise<{ session: JMAPSession; username: string; accountId: string }> {
    const baseUrl = serverUrl.replace(/\/+$/, '');
    this.credentials = {
      serverUrl: baseUrl,
      username: '',
      password: '',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      tokenEndpoint: tokens.tokenEndpoint,
      clientId: tokens.clientId,
      tokenSource: tokens.source,
    };

    this.session = this.rewriteSessionUrls(await this.fetchSession(baseUrl), baseUrl);
    this._accountId = this.resolveAccountId(this.session);
    this.firstTouchGate.reset();

    // The JMAP session document carries the authenticated user's identifier
    // — use it as the username so per-account storage keys are stable across
    // restarts and OAuth re-logins.
    const username =
      preferredUsername || this.session.username || tokens.accessToken.slice(0, 8);
    this.credentials.username = username;

    const accountId = generateAccountId(username, baseUrl);
    await SecureStore.setItemAsync(
      credentialsKey(accountId),
      JSON.stringify(this.credentials),
    );

    return { session: this.session, username, accountId };
  }

  private async persistRefreshedTokens(next: OAuthTokens): Promise<void> {
    if (!this.credentials) return;
    if (this.credentials.accessToken === next.accessToken) return;
    this.credentials = {
      ...this.credentials,
      accessToken: next.accessToken,
      // Some IdPs rotate refresh tokens; others reuse. Fall back to the
      // existing one when the response omits it.
      refreshToken: next.refreshToken ?? this.credentials.refreshToken,
      expiresAt: next.expiresAt,
      tokenEndpoint: next.tokenEndpoint,
      clientId: next.clientId,
    };
    const accountId = generateAccountId(
      this.credentials.username,
      this.credentials.serverUrl,
    );
    await SecureStore.setItemAsync(
      credentialsKey(accountId),
      JSON.stringify(this.credentials),
    );
    for (const l of this.tokenRefreshListeners) {
      try { l(); } catch { /* ignore */ }
    }
  }

  private currentOAuthTokens(): OAuthTokens | null {
    if (
      !this.credentials?.accessToken ||
      !this.credentials.refreshToken ||
      !this.credentials.tokenEndpoint ||
      !this.credentials.clientId
    ) {
      return null;
    }
    return {
      accessToken: this.credentials.accessToken,
      refreshToken: this.credentials.refreshToken,
      expiresAt: this.credentials.expiresAt,
      tokenEndpoint: this.credentials.tokenEndpoint,
      clientId: this.credentials.clientId,
      source: this.credentials.tokenSource,
    };
  }

  /** OAuth bundle stored for `accountId` (null for password accounts). */
  async getStoredOAuthTokens(accountId: string): Promise<OAuthTokens | null> {
    const creds = await this.getStoredCredentials(accountId);
    if (!creds?.accessToken || !creds.refreshToken || !creds.tokenEndpoint || !creds.clientId) return null;
    return {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
      tokenEndpoint: creds.tokenEndpoint,
      clientId: creds.clientId,
      source: creds.tokenSource,
    };
  }

  // Proactive refresh: when the access token is about to expire, swap it for
  // a fresh one. Quiet no-op for password credentials. Public so long-lived
  // consumers of `authHeader` (SSE stream, file downloads) can make sure the
  // header they capture is not about to expire.
  async ensureFreshToken(): Promise<void> {
    const tokens = this.currentOAuthTokens();
    if (!tokens) return;
    if (tokens.expiresAt == null) return;
    if (tokens.expiresAt - Date.now() > TOKEN_REFRESH_LEEWAY_MS) return;
    try {
      const next = await refreshOAuthAccessToken(tokens);
      await this.persistRefreshedTokens(next);
    } catch {
      // Surface as AuthenticationError on the next 401; refresh may be
      // temporarily failing (network) and the reactive retry path catches it.
    }
  }

  // Reactive refresh after a 401. Returns true if a fresh token was obtained
  // so the caller can retry the original request. A transient token-endpoint
  // failure (offline, 5xx, 429) is rethrown as a NetworkError so callers keep
  // the account instead of evicting it (webmail 1.7.6 "keep the session when
  // the auth server is briefly unreachable").
  async forceRefreshToken(): Promise<boolean> {
    const tokens = this.currentOAuthTokens();
    if (!tokens) return false;
    try {
      const next = await refreshOAuthAccessToken(tokens);
      await this.persistRefreshedTokens(next);
      return true;
    } catch (err) {
      if (err instanceof TransientRefreshError) {
        throw new NetworkError(err.message);
      }
      return false;
    }
  }

  /**
   * After a successful password change the stored credential must follow,
   * otherwise the next request gets a 401 and the next launch evicts the
   * account. No-op for bearer sessions.
   */
  async updatePassword(newPassword: string): Promise<void> {
    if (!this.credentials || this.credentials.accessToken) return;
    this.credentials = { ...this.credentials, password: newPassword };
    const accountId = generateAccountId(
      this.credentials.username,
      this.credentials.serverUrl,
    );
    await SecureStore.setItemAsync(
      credentialsKey(accountId),
      JSON.stringify(this.credentials),
    );
  }

  // Legacy single-slot restore - kept for backward-compat tests. New code
  // should use loadAccount(accountId) driven by the account registry.
  async restoreSession(): Promise<boolean> {
    const stored = await SecureStore.getItemAsync(LEGACY_CREDENTIALS_KEY);
    if (!stored) return false;

    try {
      const creds: StoredCredentials = JSON.parse(stored);
      this.credentials = creds;
      this.session = this.rewriteSessionUrls(
        await this.fetchSession(creds.serverUrl),
        creds.serverUrl,
      );
      this._accountId = this.resolveAccountId(this.session);
      this.firstTouchGate.reset();
      return true;
    } catch {
      await this.logout();
      return false;
    }
  }

  async loadAccount(accountId: string): Promise<boolean> {
    const stored = await SecureStore.getItemAsync(credentialsKey(accountId));
    if (!stored) return false;

    let creds: StoredCredentials;
    try {
      creds = JSON.parse(stored);
    } catch {
      // Corrupt entry — credentials can't be used. Caller should evict.
      return false;
    }

    // Errors past this point propagate so callers can distinguish
    // unrecoverable (AuthenticationError) from transient (NetworkError) and
    // avoid clearing credentials when the server is just unreachable.
    this.credentials = creds;
    this.firstTouchGate.reset();
    try {
      this.session = this.rewriteSessionUrls(
        await this.fetchSession(creds.serverUrl),
        creds.serverUrl,
      );
    } catch (err) {
      // Don't leave a half-populated client behind; the caller needs to know
      // the session is unavailable. Credentials stay in memory so a retry
      // after the network comes back doesn't need a re-login.
      this.session = null;
      this._accountId = null;
      if (err instanceof AuthenticationError) throw err;
      if (err instanceof NetworkError) throw err;
      // Anything else is treated as transport-level. Wrapping rather than
      // rethrowing the raw fetch error gives callers a single check.
      throw new NetworkError(
        err instanceof Error ? err.message : 'Server unreachable',
      );
    }
    this._accountId = this.resolveAccountId(this.session);
    return true;
  }

  /**
   * Snapshot of the live connection so a failed "add account" / switch can put
   * the previous account back without a network round-trip.
   */
  snapshot(): ClientSnapshot {
    return {
      session: this.session,
      credentials: this.credentials,
      accountId: this._accountId,
    };
  }

  restoreSnapshot(snap: ClientSnapshot): void {
    this.session = snap.session;
    this.credentials = snap.credentials;
    this._accountId = snap.accountId;
    this.firstTouchGate.reset();
  }

  async clearAccountCredentials(accountId: string): Promise<void> {
    await SecureStore.deleteItemAsync(credentialsKey(accountId));
  }

  async clearAllCredentials(accountIds: string[]): Promise<void> {
    await Promise.all([
      SecureStore.deleteItemAsync(LEGACY_CREDENTIALS_KEY),
      ...accountIds.map((id) => SecureStore.deleteItemAsync(credentialsKey(id))),
    ]);
  }

  // One-time migration: if an old single-slot credential exists, return its
  // contents so the caller can register it in the account registry.
  async consumeLegacyCredentials(): Promise<StoredCredentials | null> {
    const stored = await SecureStore.getItemAsync(LEGACY_CREDENTIALS_KEY);
    if (!stored) return null;
    try {
      const creds: StoredCredentials = JSON.parse(stored);
      // Re-save under the per-account key before dropping the legacy entry
      const accountId = generateAccountId(creds.username, creds.serverUrl);
      await SecureStore.setItemAsync(credentialsKey(accountId), stored);
      await SecureStore.deleteItemAsync(LEGACY_CREDENTIALS_KEY);
      return creds;
    } catch {
      await SecureStore.deleteItemAsync(LEGACY_CREDENTIALS_KEY);
      return null;
    }
  }

  // Rewrite session URLs to share the origin the client connected with.
  // JMAP servers often self-report localhost/container-internal hostnames in
  // apiUrl/downloadUrl/etc. that are unreachable from mobile clients (e.g.
  // the Android emulator can't resolve the host's "localhost"), and some
  // deployments advertise relative URLs (`/jmap/`) which `fetch` can't use.
  //
  // Splits via plain string indexing rather than `new URL()` because RN's
  // URL polyfill mutates inputs (appends trailing slashes, normalises
  // characters) and would corrupt the RFC 6570 templates {accountId}/{blobId}
  // before the caller has a chance to substitute values into them.
  private rewriteSessionUrls(session: JMAPSession, serverUrl: string): JMAPSession {
    const serverOrigin = extractOrigin(serverUrl);
    const rewrite = (url: string | undefined): string | undefined =>
      rewriteSessionUrl(url, serverOrigin);
    return {
      ...session,
      apiUrl: rewrite(session.apiUrl) ?? session.apiUrl,
      downloadUrl: rewrite(session.downloadUrl) ?? session.downloadUrl,
      uploadUrl: rewrite(session.uploadUrl) ?? session.uploadUrl,
      eventSourceUrl: rewrite(session.eventSourceUrl) ?? session.eventSourceUrl,
    };
  }

  // Reset in-memory state without touching persisted credentials (used on
  // account switch so the active account's stored creds remain available).
  reset(): void {
    this.session = null;
    this.credentials = null;
    this._accountId = null;
    this.firstTouchGate.reset();
    this.rateLimitedUntil = 0;
  }

  async logout(): Promise<void> {
    const currentAccountId = this.credentials
      ? generateAccountId(this.credentials.username, this.credentials.serverUrl)
      : null;
    this.reset();
    await SecureStore.deleteItemAsync(LEGACY_CREDENTIALS_KEY);
    if (currentAccountId) {
      await SecureStore.deleteItemAsync(credentialsKey(currentAccountId));
    }
  }

  // ── Transport ─────────────────────────────────────────

  /**
   * `secureFetch` with a deadline on the response headers. The abort reason is
   * tracked separately so a caller-supplied signal (cancelled upload) can be
   * told apart from "we gave up".
   */
  private async timedFetch(
    url: string,
    init: RequestInit | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const external = init?.signal ?? undefined;
    if (controller && external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', () => controller.abort(), { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller?.abort();
    }, timeoutMs);
    try {
      return await secureFetch(url, { ...init, ...(controller ? { signal: controller.signal } : {}), timeoutMs });
    } catch (error) {
      if (timedOut) throw new RequestTimeoutError(timeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Authenticated fetch shared by the API, session and blob paths: proactive
   * token refresh, deadline, one transient retry for idempotent requests,
   * reactive refresh on 401, rate-limit bookkeeping on 429. Returns the
   * response for the caller to interpret; throws `NetworkError` /
   * `RequestTimeoutError` / `RateLimitError`.
   */
  async authenticatedFetch(
    url: string,
    init?: RequestInit,
    opts?: { timeoutMs?: number; idempotent?: boolean },
  ): Promise<Response> {
    if (this.isRateLimited()) {
      throw new RateLimitError(this.rateLimitRemainingMs());
    }
    const timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const idempotent = opts?.idempotent ?? true;

    await this.ensureFreshToken();
    const withAuth = (): RequestInit => ({
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: this.authHeader },
    });

    let response: Response;
    try {
      response = await this.timedFetch(url, withAuth(), timeoutMs);
    } catch (error) {
      if (error instanceof RequestTimeoutError) throw error;
      if (!idempotent || (error as Error)?.name === 'AbortError') {
        throw toNetworkError(error);
      }
      // Transient proxy/connection blip: one retry after a short pause.
      await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_DELAY_MS));
      try {
        response = await this.timedFetch(url, withAuth(), timeoutMs);
      } catch (retryError) {
        if (retryError instanceof RequestTimeoutError) throw retryError;
        throw toNetworkError(retryError);
      }
    }

    if (response.status === 401 && (await this.forceRefreshToken())) {
      try {
        response = await this.timedFetch(url, withAuth(), timeoutMs);
      } catch (error) {
        if (error instanceof RequestTimeoutError) throw error;
        throw toNetworkError(error);
      }
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
      this.setRateLimited(retryAfterMs);
      throw new RateLimitError(retryAfterMs);
    }

    return response;
  }

  // ── Session Discovery ─────────────────────────────────

  private async fetchSession(baseUrl: string): Promise<JMAPSession> {
    // Stalwart's discovery endpoint /.well-known/jmap 307-redirects to
    // /jmap/session. On iOS, NSURLSession drops the Authorization header when
    // it auto-follows that redirect, so the app receives an unauthenticated,
    // empty-accounts session. Request the session endpoint directly so the
    // header stays attached; fall back to the standard well-known path for
    // servers that don't serve /jmap/session (#39).
    const primary = `${baseUrl}/jmap/session`;
    const fallback = `${baseUrl}/.well-known/jmap`;
    let requested = primary;
    const fetchSessionDoc = async () => {
      const r = await this.authenticatedFetch(primary, { headers: { Accept: 'application/json' } });
      if (r.status !== 404) return r;
      requested = fallback;
      return this.authenticatedFetch(fallback, { headers: { Accept: 'application/json' } });
    };
    let response = await fetchSessionDoc();

    // A redirect the platform followed may have dropped the Authorization
    // header (iOS NSURLSession does; OkHttp does for another scheme, host or
    // port). The server then answers 401, or - Stalwart - 200 with an empty
    // session, although the credentials are fine. RN's fetch never sets
    // `response.redirected`, so also compare the final URL with the one
    // requested, and refetch it with the header (webmail #892).
    const finalUrl = canonicalUrl((response as { url?: string }).url || requested);
    const redirected =
      Boolean((response as { redirected?: boolean }).redirected) || finalUrl !== canonicalUrl(requested);
    let refetched = false;
    const refetchRedirected = async (): Promise<Response> => {
      // Credentials only follow a redirect within the same host (or its
      // https upgrade), the rule secureFetch applies. Anything else fails as
      // a discovery error, not an auth one, so a stored account survives it.
      if (!mayFollowRedirect(canonicalUrl(requested), finalUrl)) {
        throw new Error(`Session discovery failed: redirected to ${finalUrl}`);
      }
      refetched = true;
      return this.authenticatedFetch(finalUrl, { headers: { Accept: 'application/json' } });
    };
    if (redirected && response.status === 401) {
      response = await refetchRedirected();
    }

    if (response.status === 401) {
      throw new AuthenticationError('Invalid credentials');
    }
    if (response.status === 402) {
      // Stalwart answers 402 with a problem+json whose title names the
      // missing factor ("TOTP code required" / "MFA code required").
      let title = '';
      try {
        const body = (await response.json()) as { title?: string; detail?: string };
        title = `${body?.title ?? ''} ${body?.detail ?? ''}`.toLowerCase();
      } catch {
        // fall through - treat any 402 as an MFA challenge
      }
      if (!title || title.includes('totp') || title.includes('mfa') || title.includes('factor')) {
        throw new TotpRequiredError();
      }
    }
    if (!response.ok) {
      throw new Error(`Session discovery failed: ${response.status} ${response.statusText}`);
    }

    let session = (await response.json()) as JMAPSession;

    // Stalwart 307-redirects /.well-known/jmap to /jmap/session and answers
    // the header-less redirected request with a 200 empty session.
    const redirectedEmpty =
      redirected &&
      !refetched &&
      (!session?.accounts || Object.keys(session.accounts).length === 0) &&
      !session?.username;
    if (redirectedEmpty) {
      response = await refetchRedirected();
      if (response.status === 401) throw new AuthenticationError('Invalid credentials');
      if (!response.ok) {
        throw new Error(`Session discovery failed: ${response.status} ${response.statusText}`);
      }
      session = (await response.json()) as JMAPSession;
    }

    if (!fetchSessionDescribes(session)) {
      throw new Error('Session discovery failed: response is not a JMAP session');
    }
    // Stalwart answers 200 with an empty session (no accounts) for missing or
    // invalid credentials rather than a 401. Surface that as an auth failure
    // so the user sees "Invalid credentials" instead of "No account found".
    const hasAccount =
      Object.keys(session.primaryAccounts ?? {}).length > 0 ||
      Object.keys(session.accounts ?? {}).length > 0;
    if (!hasAccount) {
      throw new AuthenticationError('Invalid credentials');
    }
    return session;
  }

  private resolveAccountId(session: JMAPSession): string {
    // Try mail account first, then any personal account
    const mailAccountId = session.primaryAccounts?.[CAPABILITIES.MAIL];
    if (mailAccountId) return mailAccountId;

    const coreAccountId = session.primaryAccounts?.[CAPABILITIES.CORE];
    if (coreAccountId) return coreAccountId;

    // Fall back to first account
    const accountIds = Object.keys(session.accounts ?? {});
    if (accountIds.length > 0) return accountIds[0];

    throw new Error('No account found in JMAP session');
  }

  /**
   * Re-read the session document (capabilities, shared accounts,
   * eventSourceUrl) without disturbing credentials. Used by the keep-alive
   * and after a basic-auth 401 that may just be a stale session.
   */
  async refreshSession(): Promise<JMAPSession> {
    if (!this.credentials) throw new Error('No credentials');
    const baseUrl = this.credentials.serverUrl;
    this.session = this.rewriteSessionUrls(await this.fetchSession(baseUrl), baseUrl);
    this._accountId = this.resolveAccountId(this.session);
    return this.session;
  }

  /**
   * Cheap liveness probe (`Core/echo`). Resolves true when the server answered,
   * false on transport failure. Used by the foreground keep-alive.
   */
  async ping(): Promise<boolean> {
    if (!this.session) return false;
    try {
      await this.request([['Core/echo', { ping: Date.now() }, 'ping']], [CAPABILITIES.CORE]);
      return true;
    } catch (err) {
      if (err instanceof AuthenticationError) throw err;
      return false;
    }
  }

  // ── API Request ───────────────────────────────────────

  async request(
    methodCalls: JMAPMethodCall[],
    using?: string[],
  ): Promise<JMAPResponseBody> {
    if (!this.session) throw new Error('Not connected');

    const body: JMAPRequestBody = {
      using: using ?? [CAPABILITIES.CORE, CAPABILITIES.MAIL],
      methodCalls,
    };
    const serialized = JSON.stringify(body);
    const apiUrl = this.session.apiUrl;
    const idempotent = !hasNonIdempotentMethod(methodCalls);

    for (let attempt = 0; ; attempt++) {
      const response = await this.firstTouchGate.run(methodCalls, () =>
        this.authenticatedFetch(
          apiUrl,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: serialized,
          },
          { idempotent },
        ),
      );

      if (response.status === 401) {
        const err = new AuthenticationError('Session expired');
        this.notifyAuthFailure(err);
        throw err;
      }

      const responseText = await readBodyText(response);

      if (!response.ok) {
        // Stalwart caps parallel API requests per user (maxConcurrentRequests,
        // default 4). One push event fans out into several refreshes at once,
        // so the ceiling is reached in ordinary use. The refusal comes before
        // any method runs, so back off briefly and replay (#780).
        if (
          attempt < CONCURRENT_REQUEST_RETRY_DELAYS_MS.length &&
          isConcurrentRequestRefusal(response.status, responseText)
        ) {
          const base = CONCURRENT_REQUEST_RETRY_DELAYS_MS[attempt];
          await new Promise((r) => setTimeout(r, base + Math.random() * base));
          continue;
        }
        const detail = responseText ? ` - ${responseText.substring(0, 200)}` : '';
        throw new Error(`JMAP request failed: ${response.status}${detail}`);
      }

      try {
        return JSON.parse(responseText) as JMAPResponseBody;
      } catch {
        throw new Error('Invalid JSON response from server');
      }
    }
  }

  // ── Capability Check ──────────────────────────────────

  hasCapability(urn: string): boolean {
    return Boolean(this.session?.capabilities?.[urn]);
  }

  /**
   * True when `urn` is advertised for the account (RFC 8620 §2
   * `accountCapabilities`) or, as a fallback, at session level. Stalwart puts
   * its extension capabilities (`urn:stalwart:jmap`, filenode, …) only under
   * the account, so a session-level check alone is wrong for those.
   */
  hasAccountCapability(urn: string, accountId?: string): boolean {
    const id = accountId ?? this._accountId;
    if (!id) return this.hasCapability(urn);
    const account = this.session?.accounts?.[id];
    if (account?.accountCapabilities && urn in account.accountCapabilities) return true;
    return this.hasCapability(urn);
  }

  /**
   * The value of a capability for an account (RFC 8620 §2
   * `accountCapabilities`), falling back to the session-level object. RFC
   * 8621 puts the mail and submission limits (`maxSizeAttachmentsPerEmail`,
   * `maxDelayedSend`, `submissionExtensions`) under the account; Stalwart
   * advertises an empty `{}` for them at session level.
   */
  getAccountCapability(urn: string, accountId?: string): unknown {
    const id = accountId ?? this._accountId;
    const accountCaps = id ? this.session?.accounts?.[id]?.accountCapabilities : undefined;
    if (accountCaps && urn in accountCaps) return accountCaps[urn];
    return this.session?.capabilities?.[urn];
  }

  private get coreCapability():
    | { maxObjectsInGet?: number; maxObjectsInSet?: number; maxCallsInRequest?: number; maxSizeUpload?: number; maxSizeRequest?: number }
    | undefined {
    return this.session?.capabilities?.[CAPABILITIES.CORE] as
      | { maxObjectsInGet?: number; maxObjectsInSet?: number; maxCallsInRequest?: number; maxSizeUpload?: number; maxSizeRequest?: number }
      | undefined;
  }

  getMaxObjectsInGet(): number {
    return this.coreCapability?.maxObjectsInGet || 500;
  }

  getMaxObjectsInSet(): number {
    return this.coreCapability?.maxObjectsInSet || 500;
  }

  getMaxCallsInRequest(): number {
    return this.coreCapability?.maxCallsInRequest || 16;
  }

  /** Server-advertised upload ceiling in bytes (0 = unknown / unlimited). */
  getMaxSizeUpload(): number {
    const max = this.coreCapability?.maxSizeUpload;
    return typeof max === 'number' && max > 0 ? max : 0;
  }

  /** Per-message attachment total ceiling in bytes (0 = unknown). */
  getMaxSizeAttachmentsPerEmail(accountId?: string): number {
    const mail = this.getAccountCapability(CAPABILITIES.MAIL, accountId) as
      | { maxSizeAttachmentsPerEmail?: number }
      | undefined;
    const max = mail?.maxSizeAttachmentsPerEmail;
    return typeof max === 'number' && max > 0 ? max : 0;
  }

  // ── Shared / group accounts ───────────────────────────
  // A JMAP session lists every account the credentials can reach: the user's
  // own, plus any shared/group accounts (Stalwart "group accounts") they are a
  // member of. Non-personal accounts are the shared mailboxes.

  /**
   * Mail-capable accounts other than the primary one. Stalwart doesn't always
   * populate `accountCapabilities` on shared accounts, so an account counts as
   * mail-capable when it advertises the mail capability OR is non-personal —
   * the same rule the webmail's getSharedAccounts() applies.
   */
  getSharedMailAccounts(): { id: string; name: string }[] {
    if (!this.session || !this._accountId) return [];
    const primaryId = this._accountId;
    const out: { id: string; name: string }[] = [];
    for (const [id, info] of Object.entries(this.session.accounts ?? {})) {
      if (id === primaryId) continue;
      const advertisesMail = info.accountCapabilities
        ? CAPABILITIES.MAIL in info.accountCapabilities
        : false;
      if (!advertisesMail && info.isPersonal) continue;
      out.push({ id, name: info.name || id });
    }
    return out;
  }

  getAccountName(accountId: string): string | undefined {
    return this.session?.accounts?.[accountId]?.name;
  }

  /**
   * Primary account for a capability (RFC 8620 `primaryAccounts`), falling
   * back to the mail primary. Contacts/calendars can live in a different
   * account than mail on some servers.
   */
  getPrimaryAccountId(capability: string): string {
    const id = this.session?.primaryAccounts?.[capability];
    return id || this.accountId;
  }

  // ── Scheduled send (FUTURERELEASE) ────────────────────
  // The JMAP submission capability advertises `maxDelayedSend` (max hold in
  // seconds) and a `submissionExtensions` map; FUTURERELEASE support is what
  // lets us defer delivery via the SMTP HOLDFOR parameter. Both are account
  // capabilities (RFC 8621 §1.3.2) - Stalwart only advertises them in
  // `accountCapabilities`, so a session-level read found nothing and turned
  // scheduled send, the undo-send delay and the Scheduled view off (#57).
  // Mirrors the webmail implementation so behaviour stays in sync.

  /**
   * The account whose submission capability applies to a send from
   * `accountId` (default: the primary). An account that doesn't advertise
   * submission itself falls back to the session's primary submission account.
   */
  private submissionAccountId(accountId?: string): string | undefined {
    const id = accountId ?? this._accountId ?? undefined;
    if (id && this.session?.accounts?.[id]?.accountCapabilities?.[CAPABILITIES.SUBMISSION]) return id;
    return this.session?.primaryAccounts?.[CAPABILITIES.SUBMISSION] || id;
  }

  /**
   * Every account whose scheduled sends this session can see: the primary
   * submission account plus each shared/group account that advertises
   * submission itself. A send from a shared identity is held in that
   * account, so a lookup in the primary one alone never found it (webmail
   * #874).
   */
  getSubmissionAccountIds(): string[] {
    const ids: string[] = [];
    const primary = this.submissionAccountId();
    if (primary) ids.push(primary);
    for (const [id, account] of Object.entries(this.session?.accounts ?? {})) {
      if (!ids.includes(id) && account?.accountCapabilities?.[CAPABILITIES.SUBMISSION]) ids.push(id);
    }
    return ids;
  }

  private submissionCapability(accountId?: string):
    | { maxDelayedSend?: number; submissionExtensions?: unknown }
    | undefined {
    return this.getAccountCapability(CAPABILITIES.SUBMISSION, this.submissionAccountId(accountId)) as
      | { maxDelayedSend?: number; submissionExtensions?: unknown }
      | undefined;
  }

  /**
   * The longest hold (seconds) a send from `accountId` may ask for. On
   * Stalwart the advertised 30 days counts as the 7 its MTA accepts, and a
   * limit learned from a rejection wins over both (webmail parity).
   */
  getMaxDelayedSend(accountId?: string): number {
    const max = this.submissionCapability(accountId)?.maxDelayedSend;
    if (typeof max !== 'number' || max <= 0) return 0;
    const learned = this.serverUrl ? this.learnedHoldLimits.get(this.serverUrl) : undefined;
    if (learned !== undefined) return Math.min(max, learned);
    if (
      max === STALWART_ADVERTISED_MAX_DELAYED_SEND &&
      this.hasAccountCapability('urn:stalwart:jmap', this.submissionAccountId(accountId))
    ) {
      return STALWART_DEFAULT_MAX_HOLD;
    }
    return max;
  }

  /**
   * The latest time a send from `accountId` can be held until, or undefined
   * when it can't be held. Caps the "Pick date & time" pickers.
   */
  latestHoldDate(accountId?: string, now = Date.now()): Date | undefined {
    if (!this.hasDelayedSend(accountId)) return undefined;
    return new Date(now + this.getMaxDelayedSend(accountId) * 1000);
  }

  /**
   * Remember the hold limit a rejected submission named, so the pickers only
   * offer times the server accepts for the rest of the session.
   */
  learnHoldLimit(seconds: number): void {
    if (this.serverUrl && seconds > 0) this.learnedHoldLimits.set(this.serverUrl, seconds);
  }

  /**
   * The HOLDFOR for the undo-send delay: none when the account can't hold
   * mail, and never longer than the server allows.
   */
  undoSendHold(delaySeconds: number, accountId?: string): number | undefined {
    if (delaySeconds <= 0 || !this.hasDelayedSend(accountId)) return undefined;
    return Math.min(delaySeconds, this.getMaxDelayedSend(accountId));
  }

  hasDelayedSend(accountId?: string): boolean {
    const cap = this.submissionCapability(accountId);
    if (!cap) return false;
    const ext = cap.submissionExtensions;
    // submissionExtensions is a map of extension name → params. FUTURERELEASE
    // (RFC 4865) is the SMTP extension that backs deferred delivery.
    const hasFutureRelease =
      !!ext &&
      typeof ext === 'object' &&
      Object.keys(ext as Record<string, unknown>).some(
        (k) => k.toUpperCase() === 'FUTURERELEASE',
      );
    return hasFutureRelease && this.getMaxDelayedSend(accountId) > 0;
  }

  // ── Stored credentials (per-account) ──────────────────
  // Exposed so the unified-inbox aggregator can read another account's
  // credentials without disturbing this client's live session, and persist a
  // refreshed OAuth token back to secure storage.

  async getStoredCredentials(accountId: string): Promise<StoredCredentials | null> {
    const stored = await SecureStore.getItemAsync(credentialsKey(accountId));
    if (!stored) return null;
    try {
      return JSON.parse(stored) as StoredCredentials;
    } catch {
      return null;
    }
  }

  async setStoredCredentials(accountId: string, creds: StoredCredentials): Promise<void> {
    await SecureStore.setItemAsync(credentialsKey(accountId), JSON.stringify(creds));
  }

  // ── Blob Download ─────────────────────────────────────

  // Expand the RFC 6570 level-1 template the JMAP server advertises.
  // `accountId` targets a shared/group account, whose blobs aren't reachable
  // through the user's own account id.
  getBlobDownloadUrl(blobId: string, name?: string, type?: string, accountId?: string): string {
    if (!this.session?.downloadUrl) {
      throw new Error('Download URL not available - not connected');
    }
    return this.session.downloadUrl
      .replace('{accountId}', encodeURIComponent(accountId ?? this.accountId))
      .replace('{blobId}', encodeURIComponent(blobId))
      .replace('{name}', encodeURIComponent(name || 'download'))
      .replace('{type}', encodeURIComponent(type || 'application/octet-stream'));
  }

  async fetchBlobArrayBuffer(
    blobId: string,
    name?: string,
    type?: string,
    accountId?: string,
  ): Promise<ArrayBuffer> {
    const url = this.getBlobDownloadUrl(blobId, name, type, accountId);
    const response = await this.authenticatedFetch(url, undefined, {
      timeoutMs: BLOB_TIMEOUT_MS,
    });
    if (response.status === 401) {
      const err = new AuthenticationError('Session expired');
      this.notifyAuthFailure(err);
      throw err;
    }
    if (!response.ok) throw new Error(`Failed to fetch blob: ${response.status}`);
    return response.arrayBuffer();
  }
}

export interface ClientSnapshot {
  session: JMAPSession | null;
  credentials: StoredCredentials | null;
  accountId: string | null;
}

// ── URL helpers ──────────────────────────────────────────

export function extractOrigin(url: string): string | null {
  const m = url.match(/^(https?:\/\/[^/?#]+)/i);
  return m ? m[1] : null;
}

/**
 * Rebase a session URL onto the origin the client connected with. Relative
 * URLs (`/jmap/`) get the origin prefixed; absolute ones have their origin
 * swapped. Pure string work so `{accountId}`/`{blobId}` templates survive.
 */
export function rewriteSessionUrl(
  url: string | undefined,
  serverOrigin: string | null,
): string | undefined {
  if (!url || !serverOrigin) return url;
  const origin = extractOrigin(url);
  if (!origin) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url; // non-http scheme: leave it
    return serverOrigin + (url.startsWith('/') ? url : '/' + url);
  }
  if (origin === serverOrigin) return url;
  return serverOrigin + url.slice(origin.length);
}

async function readBodyText(response: Response): Promise<string> {
  try {
    if (typeof response.text === 'function') return await response.text();
    if (typeof response.json === 'function') return JSON.stringify(await response.json());
  } catch {
    // fall through
  }
  return '';
}

function toNetworkError(error: unknown): NetworkError {
  if (error instanceof NetworkError) return error;
  return new NetworkError(
    error instanceof Error && error.message ? error.message : 'Network request failed',
  );
}

// ── Error Classes ─────────────────────────────────────────

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

// The server wants a second factor before it will hand out a session.
export class TotpRequiredError extends AuthenticationError {
  constructor() {
    super('TOTP_REQUIRED');
    this.name = 'TotpRequiredError';
  }
}

// Server unreachable / transient transport failure. Callers should keep
// stored credentials and surface an offline state rather than logging out.
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

// No response headers within the deadline. The request may have reached the
// server (a send may have gone out), so callers must not blindly retry.
export class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'RequestTimeoutError';
  }
}

export class RateLimitError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super('Rate limited by server');
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

// Singleton instance
export const jmapClient = new JMAPClient();
