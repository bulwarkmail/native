import { describe, it, expect, vi, beforeEach } from 'vitest';

// The server refusing an account's stored sign-in (a Stalwart 0.16 server
// moved to 1.0, an expired pasted token, a changed password) used to remove
// the account with "Your session has expired". It stays now, with its caches
// and credentials, and the app asks for a new sign-in to it.

const stored = vi.hoisted(() => ({ creds: null as Record<string, unknown> | null }));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    connect: vi.fn(),
    logout: vi.fn(),
    loadAccount: vi.fn(),
    consumeLegacyCredentials: vi.fn(async () => null),
    clearAccountCredentials: vi.fn(async () => undefined),
    clearAllCredentials: vi.fn(async () => undefined),
    getStoredCredentials: vi.fn(async () => stored.creds),
    getStoredOAuthTokens: vi.fn(async () => null),
    reset: vi.fn(),
    snapshot: vi.fn(() => ({ session: 'live', credentials: 'live', accountId: 'live' })),
    restoreSnapshot: vi.fn(),
    onAuthFailure: vi.fn(() => () => undefined),
    onTokenRefresh: vi.fn(() => () => undefined),
    hasAccountCapability: vi.fn(() => false),
    request: vi.fn(async () => { throw new Error('not mocked'); }),
    accountId: 'acc-1',
    currentSession: null,
  },
  AuthenticationError: class AuthenticationError extends Error {
    constructor(msg: string) { super(msg); this.name = 'AuthenticationError'; }
  },
  NetworkError: class NetworkError extends Error {
    constructor(msg: string) { super(msg); this.name = 'NetworkError'; }
  },
  SessionSupersededError: class SessionSupersededError extends Error {},
}));

vi.mock('../../lib/push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
}));

import { AuthenticationError, jmapClient } from '../../api/jmap-client';
import { useAuthStore } from '../auth-store';
import { useAccountStore, type AccountEntry } from '../account-store';
import { reauthStart } from '../../screens/login/reauth-start';

const loadAccount = jmapClient.loadAccount as ReturnType<typeof vi.fn>;
const clearCredentials = jmapClient.clearAccountCredentials as ReturnType<typeof vi.fn>;

const A = 'usera@example.org@mail.example.org';
const B = 'userb@example.org@mail.example.org';

function entry(id: string, username: string): AccountEntry {
  return {
    id, username, serverUrl: 'https://mail.example.org', displayName: username, email: username,
    avatarColor: '#000', lastLoginAt: 1, isConnected: false, hasError: false, isDefault: id === A,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stored.creds = { serverUrl: 'https://mail.example.org', username: 'usera@example.org', password: 'old' };
  useAccountStore.setState({
    accounts: [entry(A, 'usera@example.org'), entry(B, 'userb@example.org')],
    activeAccountId: A,
    defaultAccountId: A,
  });
  useAuthStore.setState({
    isAuthenticated: false, isLoading: false, hasRestoredSession: false, error: null,
    serverUrl: null, username: null, session: null, accountId: null, activeAccountId: null, client: null,
    reauth: null,
  });
});

describe('a refused stored sign-in', () => {
  it('keeps the account on a cold start and asks for a new sign-in to it', async () => {
    loadAccount.mockRejectedValue(new AuthenticationError('Session expired'));

    await useAuthStore.getState().restoreSession();

    const account = useAccountStore.getState().getAccountById(A);
    expect(account).toBeDefined();
    expect(account?.needsSignIn).toBe(true);
    expect(clearCredentials).not.toHaveBeenCalled();
    const state = useAuthStore.getState();
    expect(state.error).toBeNull();
    expect(state.isAuthenticated).toBe(true);
    expect(state.reauth).toEqual({
      accountId: A, serverUrl: 'https://mail.example.org', username: 'usera@example.org', method: 'password',
    });
  });

  it('asks a pasted-token account for a new token', async () => {
    stored.creds = { serverUrl: 'https://mail.example.org', username: 'usera@example.org', password: '', accessToken: 'tok' };
    loadAccount.mockRejectedValue(new AuthenticationError('Session expired'));

    await useAuthStore.getState().restoreSession();

    const reauth = useAuthStore.getState().reauth;
    expect(reauth?.method).toBe('token');
    expect(reauthStart(reauth)).toEqual({ step: 'password', email: '', serverUrl: 'https://mail.example.org', tokenMode: true });
  });

  it('keeps an account switched to and goes back to the one in use', async () => {
    useAuthStore.setState({ isAuthenticated: true, session: { apiUrl: 'x' } as never, activeAccountId: A });
    loadAccount.mockRejectedValue(new AuthenticationError('Session expired'));

    await useAuthStore.getState().switchAccount(B);

    expect(useAccountStore.getState().getAccountById(B)?.needsSignIn).toBe(true);
    expect(clearCredentials).not.toHaveBeenCalled();
    expect(jmapClient.restoreSnapshot).toHaveBeenCalled();
    expect(useAuthStore.getState().reauth?.accountId).toBe(B);
    expect(useAuthStore.getState().error).toBeNull();
  });
});

describe('reauthStart', () => {
  it('opens a password account on the form and an OAuth one on its sign-in page, filled in', () => {
    expect(reauthStart({ accountId: A, serverUrl: 'https://m', username: 'u@x', method: 'password' }))
      .toEqual({ step: 'password', email: 'u@x', serverUrl: 'https://m', tokenMode: false });
    expect(reauthStart({ accountId: A, serverUrl: 'https://m', username: 'u@x', method: 'oauth' }))
      .toEqual({ step: 'confirm', email: 'u@x', serverUrl: 'https://m', tokenMode: false });
    expect(reauthStart(null).step).toBe('choose');
  });
});
