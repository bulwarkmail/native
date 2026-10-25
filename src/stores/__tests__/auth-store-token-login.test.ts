import { describe, it, expect, vi, beforeEach } from 'vitest';

// Access-token sign-in: the pasted token is cleaned up before it is sent, the
// account is named after the session, and a refused token leaves nothing
// registered.

const { InvalidTokenError, SESSION, connectWithToken } = vi.hoisted(() => {
  class InvalidTokenError extends Error {
    constructor() {
      super('Invalid access token');
      this.name = 'InvalidTokenError';
    }
  }
  const SESSION = { apiUrl: 'https://api.fastmail.com/jmap/api/', username: 'ada@fastmail.com' };
  const connectWithToken = vi.fn(async (_serverUrl: string, _token: string) => ({
    session: SESSION,
    username: 'ada@fastmail.com',
    accountId: 'ada@fastmail.com@api.fastmail.com',
  }));
  return { InvalidTokenError, SESSION, connectWithToken };
});

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    connectWithToken: (serverUrl: string, token: string) => connectWithToken(serverUrl, token),
    snapshot: vi.fn(() => ({ session: null, credentials: null, accountId: null })),
    restoreSnapshot: vi.fn(),
    onAuthFailure: vi.fn(() => () => undefined),
    onTokenRefresh: vi.fn(() => () => undefined),
    hasAccountCapability: vi.fn(() => false),
    getAccountName: () => undefined,
    getSharedMailAccounts: () => [],
    request: vi.fn(async () => ({ methodResponses: [] })),
    accountId: 'acc-1',
    isConnected: true,
    currentSession: SESSION,
    username: 'ada@fastmail.com',
    serverUrl: 'https://api.fastmail.com',
  },
  AuthenticationError: class AuthenticationError extends Error {},
  NetworkError: class NetworkError extends Error {},
  InvalidTokenError,
}));

vi.mock('../../lib/push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
}));

import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';

beforeEach(() => {
  connectWithToken.mockClear();
  useAccountStore.setState({ accounts: [], activeAccountId: null });
  useAuthStore.setState({ isAuthenticated: false, error: null, activeAccountId: null });
});

describe('loginWithToken', () => {
  it('sends the bare token and registers the account the session names', async () => {
    await useAuthStore.getState().loginWithToken('https://api.fastmail.com/', '  Bearer fmu1-abc  ');

    expect(connectWithToken).toHaveBeenCalledWith('https://api.fastmail.com', 'fmu1-abc');
    const account = useAccountStore.getState().getActiveAccount();
    expect(account?.id).toBe('ada@fastmail.com@api.fastmail.com');
    expect(account?.serverUrl).toBe('https://api.fastmail.com');
    expect(useAuthStore.getState()).toMatchObject({
      isAuthenticated: true,
      username: 'ada@fastmail.com',
      activeAccountId: 'ada@fastmail.com@api.fastmail.com',
    });
  });

  it('refuses a token with spaces inside without asking the server', async () => {
    await expect(useAuthStore.getState().loginWithToken('https://api.fastmail.com', 'fmu1 abc'))
      .rejects.toThrow(InvalidTokenError);
    expect(connectWithToken).not.toHaveBeenCalled();
    expect(useAuthStore.getState().error).toBe('Invalid access token');
  });

  it('registers nothing when the server refuses the token', async () => {
    connectWithToken.mockRejectedValueOnce(new InvalidTokenError());

    await expect(useAuthStore.getState().loginWithToken('https://api.fastmail.com', 'fmu1-expired'))
      .rejects.toThrow(InvalidTokenError);
    expect(useAccountStore.getState().accounts).toHaveLength(0);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});
