import * as SecureStore from 'expo-secure-store';
import type {
  JMAPSession,
  JMAPMethodCall,
  JMAPRequestBody,
  JMAPResponseBody,
} from './types';
import { CAPABILITIES } from './types';
import { generateAccountId } from '../lib/account-utils';

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
      return false;
    }
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
    const response = await fetch(url, {
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
      },
    });

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

    const response = await fetch(this.session.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authHeader,
      },
      body: JSON.stringify(body),
    });

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
    const response = await fetch(url, {
      headers: { Authorization: this.authHeader },
    });
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
