import { describe, it, expect, vi, beforeEach } from 'vitest';

// Signing in with an access token (for example a Fastmail API token): the
// pasted text is cleaned, a rejected token reads as `invalid_token`, and a
// failed sign-in leaves no account behind and gives the live connection back.

const request = vi.fn(async (calls: Array<[string, Record<string, unknown>, string]>) => ({
  methodResponses: calls.map(([name, , id]) => {
    if (name === 'Identity/get') return [name, { list: [{ id: 'i1', name: 'Ada', email: 'ada@example.com' }] }, id];
    if (name === 'Mailbox/get') return [name, { list: [{ id: 'mb-in', name: 'Inbox', role: 'inbox' }], state: 'mbs-1' }, id];
    return ['error', { type: 'forbidden' }, id];
  }),
}));

const LIVE_SNAPSHOT = { session: 'live-session', credentials: 'live-credentials', accountId: 'live-jmap' };

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    connectWithToken: vi.fn(async () => ({
      apiUrl: 'https://api.fastmail.com/jmap/api/',
      username: 'ada@example.com',
    })),
    snapshot: vi.fn(() => LIVE_SNAPSHOT),
    restoreSnapshot: vi.fn(),
    reset: vi.fn(),
    clearAccountCredentials: vi.fn(async () => undefined),
    onAuthFailure: vi.fn(() => () => undefined),
    onTokenRefresh: vi.fn(() => () => undefined),
    hasAccountCapability: vi.fn(() => false),
    getAccountName: () => undefined,
    getSharedMailAccounts: () => [],
    request: (calls: Array<[string, Record<string, unknown>, string]>) => request(calls),
    accountId: 'acc-1',
    isConnected: true,
    currentSession: { apiUrl: 'https://api.fastmail.com/jmap/api/' },
    username: 'ada@example.com',
    serverUrl: 'https://api.fastmail.com',
  },
  AuthenticationError: class AuthenticationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AuthenticationError';
    }
  },
  TotpRequiredError: class TotpRequiredError extends Error {
    constructor() {
      super('TOTP_REQUIRED');
      this.name = 'TotpRequiredError';
    }
  },
  NetworkError: class NetworkError extends Error {},
}));

vi.mock('../../lib/push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
  clearStoredRelayBaseUrl: vi.fn(async () => undefined),
}));

import { jmapClient, AuthenticationError, TotpRequiredError } from '../../api/jmap-client';
import { cleanAccessToken } from '../../lib/access-token';
import { MAX_ACCOUNTS } from '../../lib/account-utils';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';

const SERVER = 'https://api.fastmail.com/jmap/session';
const connectWithToken = jmapClient.connectWithToken as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  useAuthStore.setState({ isAuthenticated: false, isLoading: false, error: null });
});

describe('cleanAccessToken', () => {
  it('trims and drops a Bearer prefix', () => {
    expect(cleanAccessToken('  Bearer   abc123  ')).toBe('abc123');
    expect(cleanAccessToken('bearer abc123')).toBe('abc123');
    expect(cleanAccessToken('abc123')).toBe('abc123');
  });

  it('rejects empty text and text with whitespace inside', () => {
    expect(cleanAccessToken('')).toBeNull();
    expect(cleanAccessToken('   ')).toBeNull();
    expect(cleanAccessToken('abc def')).toBeNull();
    expect(cleanAccessToken('abc\ndef')).toBeNull();
  });
});

describe('loginWithToken', () => {
  it('connects with the cleaned token and registers the account under the session username', async () => {
    await useAuthStore.getState().loginWithToken(SERVER, '  Bearer tok-123 ');

    expect(connectWithToken).toHaveBeenCalledWith(SERVER, 'tok-123');
    const accounts = useAccountStore.getState().accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0].username).toBe('ada@example.com');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().username).toBe('ada@example.com');
    expect(useAuthStore.getState().error).toBeNull();
  });

  it.each(['', '   ', 'two words'])('refuses %j as invalid_token without connecting', async (typed) => {
    await expect(useAuthStore.getState().loginWithToken(SERVER, typed)).rejects.toThrow('invalid_token');

    expect(connectWithToken).not.toHaveBeenCalled();
    expect(useAuthStore.getState().error).toBe('invalid_token');
    expect(useAccountStore.getState().accounts).toHaveLength(0);
  });

  it('maps a 401 to invalid_token and leaves no account behind', async () => {
    connectWithToken.mockRejectedValueOnce(new AuthenticationError('Invalid credentials'));

    await expect(useAuthStore.getState().loginWithToken(SERVER, 'tok')).rejects.toThrow('invalid_token');

    expect(useAuthStore.getState().error).toBe('invalid_token');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAccountStore.getState().accounts).toHaveLength(0);
  });

  it('maps a 403 to invalid_token', async () => {
    connectWithToken.mockRejectedValueOnce(new Error('Session discovery failed: 403 Forbidden'));

    await expect(useAuthStore.getState().loginWithToken(SERVER, 'tok')).rejects.toThrow('invalid_token');
    expect(useAuthStore.getState().error).toBe('invalid_token');
  });

  it('does not call a missing account name an invalid token', async () => {
    connectWithToken.mockRejectedValueOnce(new AuthenticationError('The server did not name the account'));

    await expect(useAuthStore.getState().loginWithToken(SERVER, 'tok')).rejects.toThrow('did not name the account');
    expect(useAuthStore.getState().error).toBe('The server did not name the account');
  });

  it('does not call a second-factor demand an invalid token', async () => {
    connectWithToken.mockRejectedValueOnce(new TotpRequiredError());

    await expect(useAuthStore.getState().loginWithToken(SERVER, 'tok')).rejects.toThrow('TOTP_REQUIRED');
    expect(useAuthStore.getState().error).toBe('TOTP_REQUIRED');
  });

  it('keeps other failures as they are', async () => {
    connectWithToken.mockRejectedValueOnce(new Error('Session discovery failed: 500 Server Error'));

    await expect(useAuthStore.getState().loginWithToken(SERVER, 'tok')).rejects.toThrow('500');
    expect(useAuthStore.getState().error).toContain('500');
  });

  it('never puts the token in the stored error', async () => {
    connectWithToken.mockRejectedValueOnce(new Error('Session discovery failed: 500'));
    await useAuthStore.getState().loginWithToken(SERVER, 'secret-tok').catch(() => undefined);
    expect(useAuthStore.getState().error).not.toContain('secret-tok');
  });

  it('gives the live account its connection back when adding fails', async () => {
    useAuthStore.setState({ isAuthenticated: true });
    connectWithToken.mockRejectedValueOnce(new AuthenticationError('Invalid credentials'));

    await expect(
      useAuthStore.getState().loginWithToken(SERVER, 'tok', { addAccount: true }),
    ).rejects.toThrow('invalid_token');

    expect(jmapClient.restoreSnapshot).toHaveBeenCalledWith(LIVE_SNAPSHOT);
  });

  it('does not touch the client when adding to a full registry', async () => {
    useAuthStore.setState({ isAuthenticated: true });
    useAccountStore.setState({
      accounts: Array.from({ length: MAX_ACCOUNTS }, (_, i) => ({
        id: `u${i}@x.com@mail.x.com`, serverUrl: 'https://mail.x.com', username: `u${i}@x.com`,
        displayName: 'u', email: `u${i}@x.com`, lastLoginAt: 0, isConnected: true, hasError: false,
      })) as never,
    });

    await expect(
      useAuthStore.getState().loginWithToken(SERVER, 'tok', { addAccount: true }),
    ).rejects.toThrow();

    expect(connectWithToken).not.toHaveBeenCalled();
  });

  it('undoes the connection and credentials when the registry refuses the account after connecting', async () => {
    useAuthStore.setState({ isAuthenticated: true });
    useAccountStore.setState({
      accounts: Array.from({ length: MAX_ACCOUNTS }, (_, i) => ({
        id: `u${i}@x.com@mail.x.com`, serverUrl: 'https://mail.x.com', username: `u${i}@x.com`,
        displayName: 'u', email: `u${i}@x.com`, lastLoginAt: 0, isConnected: true, hasError: false,
      })) as never,
    });
    // Not "adding" as far as the pre-check goes: the limit only shows once the
    // username is known.
    await expect(useAuthStore.getState().loginWithToken(SERVER, 'tok')).rejects.toThrow();

    // No previous session to give back: the client is reset instead.
    expect(jmapClient.reset).toHaveBeenCalled();
    expect(useAccountStore.getState().accounts).toHaveLength(MAX_ACCOUNTS);
    expect(jmapClient.clearAccountCredentials).toHaveBeenCalled();
  });
});
