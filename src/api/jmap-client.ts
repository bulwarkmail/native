import * as SecureStore from 'expo-secure-store';
import type {
  JMAPSession,
  JMAPMethodCall,
  JMAPRequestBody,
  JMAPResponseBody,
} from './types';
import { CAPABILITIES } from './types';

const CREDENTIALS_KEY = 'jmap_credentials';

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
      throw new Error('Not authenticated — call connect() first');
    }
    return this._accountId;
  }

  get currentSession(): JMAPSession | null {
    return this.session;
  }

  get isConnected(): boolean {
    return this.session !== null && this._accountId !== null;
  }

  // ── Authentication ────────────────────────────────────

  private get authHeader(): string {
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

    this.session = await this.fetchSession(baseUrl);
    this._accountId = this.resolveAccountId(this.session);

    // Persist credentials
    await SecureStore.setItemAsync(
      CREDENTIALS_KEY,
      JSON.stringify(this.credentials),
    );

    return this.session;
  }

  async connectWithToken(serverUrl: string, accessToken: string): Promise<JMAPSession> {
    const baseUrl = serverUrl.replace(/\/+$/, '');
    this.credentials = { serverUrl: baseUrl, username: '', password: '', accessToken };

    this.session = await this.fetchSession(baseUrl);
    this._accountId = this.resolveAccountId(this.session);

    await SecureStore.setItemAsync(
      CREDENTIALS_KEY,
      JSON.stringify(this.credentials),
    );

    return this.session;
  }

  async restoreSession(): Promise<boolean> {
    const stored = await SecureStore.getItemAsync(CREDENTIALS_KEY);
    if (!stored) return false;

    try {
      const creds: StoredCredentials = JSON.parse(stored);
      this.credentials = creds;
      this.session = await this.fetchSession(creds.serverUrl);
      this._accountId = this.resolveAccountId(this.session);
      return true;
    } catch {
      await this.logout();
      return false;
    }
  }

  async logout(): Promise<void> {
    this.session = null;
    this.credentials = null;
    this._accountId = null;
    await SecureStore.deleteItemAsync(CREDENTIALS_KEY);
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
