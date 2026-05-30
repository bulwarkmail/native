import * as SecureStore from 'expo-secure-store';
import type {
  JMAPSession,
  JMAPMethodCall,
  JMAPRequestBody,
  JMAPResponseBody,
} from './types';
import { CAPABILITIES } from './types';
import { generateAccountId } from '../lib/account-utils';
import { secureFetch } from '../lib/client-cert';
import { refreshOAuthAccessToken, type OAuthTokens } from '../lib/oauth';

// Refresh OAuth access tokens this many ms before they actually expire so
// in-flight requests don't race the expiry window.
const TOKEN_REFRESH_LEEWAY_MS = 60_000;

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
}

export class JMAPClient {
  private session: JMAPSession | null = null;
  private credentials: StoredCredentials | null = null;
  private _accountId: string | null = null;

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

  async connect(serverUrl: string, username: string, password: string): Promise<JMAPSession> {
    // Normalise URL
    const baseUrl = serverUrl.replace(/\/+$/, '');
    this.credentials = { serverUrl: baseUrl, username, password };

    this.session = this.rewriteSessionUrls(await this.fetchSession(baseUrl), baseUrl);
    this._accountId = this.resolveAccountId(this.session);

    const accountId = generateAccountId(username, baseUrl);
    await SecureStore.setItemAsync(
      credentialsKey(accountId),
      JSON.stringify(this.credentials),
    );

    return this.session;
  }

  async connectWithToken(serverUrl: string, accessToken: string): Promise<JMAPSession> {
    const baseUrl = serverUrl.replace(/\/+$/, '');
    this.credentials = { serverUrl: baseUrl, username: '', password: '', accessToken };

    this.session = this.rewriteSessionUrls(await this.fetchSession(baseUrl), baseUrl);
    this._accountId = this.resolveAccountId(this.session);

    return this.session;
  }

  // OAuth login via webmail handoff. The webmail did the OAuth dance against
  // Stalwart and handed us a complete token bundle. We persist the bundle
  // so subsequent launches can refresh without prompting the user again.
  async connectWithOAuth(
    serverUrl: string,
    tokens: OAuthTokens,
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
    };

    this.session = this.rewriteSessionUrls(await this.fetchSession(baseUrl), baseUrl);
    this._accountId = this.resolveAccountId(this.session);

    // The JMAP session document carries the authenticated user's identifier
    // — use it as the username so per-account storage keys are stable across
    // restarts and OAuth re-logins.
    const username = this.session.username || tokens.accessToken.slice(0, 8);
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
    };
  }

  // Proactive refresh: when the access token is about to expire, swap it for
  // a fresh one. Quiet no-op for password credentials.
  private async ensureFreshToken(): Promise<void> {
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
  // so the caller can retry the original request.
  private async forceRefreshToken(): Promise<boolean> {
    const tokens = this.currentOAuthTokens();
    if (!tokens) return false;
    try {
      const next = await refreshOAuthAccessToken(tokens);
      await this.persistRefreshedTokens(next);
      return true;
    } catch {
      return false;
    }
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
      // Anything else is treated as transport-level. Wrapping rather than
      // rethrowing the raw fetch error gives callers a single check.
      throw new NetworkError(
        err instanceof Error ? err.message : 'Server unreachable',
      );
    }
    this._accountId = this.resolveAccountId(this.session);
    return true;
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
  // the Android emulator can't resolve the host's "localhost").
  //
  // Splits via plain string indexing rather than `new URL()` because RN's
  // URL polyfill mutates inputs (appends trailing slashes, normalises
  // characters) and would corrupt the RFC 6570 templates {accountId}/{blobId}
  // before the caller has a chance to substitute values into them.
  private rewriteSessionUrls(session: JMAPSession, serverUrl: string): JMAPSession {
    const serverOrigin = this.extractOrigin(serverUrl);
    const rewrite = (url: string | undefined): string | undefined => {
      if (!url) return url;
      const origin = this.extractOrigin(url);
      if (!origin || !serverOrigin || origin === serverOrigin) return url;
      return serverOrigin + url.slice(origin.length);
    };
    return {
      ...session,
      apiUrl: rewrite(session.apiUrl) ?? session.apiUrl,
      downloadUrl: rewrite(session.downloadUrl) ?? session.downloadUrl,
      uploadUrl: rewrite(session.uploadUrl) ?? session.uploadUrl,
      eventSourceUrl: rewrite(session.eventSourceUrl) ?? session.eventSourceUrl,
    };
  }

  private extractOrigin(url: string): string | null {
    const m = url.match(/^(https?:\/\/[^/?#]+)/i);
    return m ? m[1] : null;
  }

  // Reset in-memory state without touching persisted credentials (used on
  // account switch so the active account's stored creds remain available).
  reset(): void {
    this.session = null;
    this.credentials = null;
    this._accountId = null;
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

  // ── Session Discovery ─────────────────────────────────

  private async fetchSession(baseUrl: string): Promise<JMAPSession> {
    const url = `${baseUrl}/.well-known/jmap`;
    await this.ensureFreshToken();
    const doFetch = () =>
      secureFetch(url, {
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json',
        },
      });
    let response = await doFetch();
    if (response.status === 401 && (await this.forceRefreshToken())) {
      response = await doFetch();
    }

    if (response.status === 401) {
      throw new AuthenticationError('Invalid credentials');
    }
    if (!response.ok) {
      throw new Error(`Session discovery failed: ${response.status} ${response.statusText}`);
    }

    return response.json();
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

    await this.ensureFreshToken();
    const doFetch = () =>
      secureFetch(this.session!.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.authHeader,
        },
        body: JSON.stringify(body),
      });

    let response = await doFetch();
    if (response.status === 401 && (await this.forceRefreshToken())) {
      response = await doFetch();
    }

    if (response.status === 401) {
      throw new AuthenticationError('Session expired');
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const ms = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
      throw new RateLimitError(ms);
    }

    if (!response.ok) {
      throw new Error(`JMAP request failed: ${response.status}`);
    }

    return response.json();
  }

  // ── Capability Check ──────────────────────────────────

  hasCapability(urn: string): boolean {
    return Boolean(this.session?.capabilities?.[urn]);
  }

  getMaxObjectsInGet(): number {
    const core = this.session?.capabilities?.[CAPABILITIES.CORE] as
      | { maxObjectsInGet?: number }
      | undefined;
    return core?.maxObjectsInGet || 500;
  }

  // ── Scheduled send (FUTURERELEASE) ────────────────────
  // The JMAP submission capability advertises `maxDelayedSend` (max hold in
  // seconds) and a `submissionExtensions` map; FUTURERELEASE support is what
  // lets us defer delivery via the SMTP HOLDFOR parameter. Mirrors the webmail
  // implementation so behaviour stays in sync across platforms.

  private get submissionCapability():
    | { maxDelayedSend?: number; submissionExtensions?: unknown }
    | undefined {
    return this.session?.capabilities?.[CAPABILITIES.SUBMISSION] as
      | { maxDelayedSend?: number; submissionExtensions?: unknown }
      | undefined;
  }

  getMaxDelayedSend(): number {
    const max = this.submissionCapability?.maxDelayedSend;
    return typeof max === 'number' ? max : 0;
  }

  hasDelayedSend(): boolean {
    const cap = this.submissionCapability;
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
    return hasFutureRelease && this.getMaxDelayedSend() > 0;
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
  getBlobDownloadUrl(blobId: string, name?: string, type?: string): string {
    if (!this.session?.downloadUrl) {
      throw new Error('Download URL not available - not connected');
    }
    return this.session.downloadUrl
      .replace('{accountId}', encodeURIComponent(this.accountId))
      .replace('{blobId}', encodeURIComponent(blobId))
      .replace('{name}', encodeURIComponent(name || 'download'))
      .replace('{type}', encodeURIComponent(type || 'application/octet-stream'));
  }

  async fetchBlobArrayBuffer(blobId: string, name?: string, type?: string): Promise<ArrayBuffer> {
    const url = this.getBlobDownloadUrl(blobId, name, type);
    await this.ensureFreshToken();
    const doFetch = () => secureFetch(url, { headers: { Authorization: this.authHeader } });
    let response = await doFetch();
    if (response.status === 401 && (await this.forceRefreshToken())) {
      response = await doFetch();
    }
    if (response.status === 401) throw new AuthenticationError('Session expired');
    if (!response.ok) throw new Error(`Failed to fetch blob: ${response.status}`);
    return response.arrayBuffer();
  }
}

// ── Error Classes ─────────────────────────────────────────

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
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
