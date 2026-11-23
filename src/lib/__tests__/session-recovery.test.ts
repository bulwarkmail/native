import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    connect: vi.fn(),
    logout: vi.fn(),
    restoreSession: vi.fn(),
    loadAccount: vi.fn(),
    loadAccountFromCache: vi.fn(async () => false),
    revalidateSession: vi.fn(async () => null),
    consumeLegacyCredentials: vi.fn(async () => null),
    clearAccountCredentials: vi.fn(async () => undefined),
    clearAllCredentials: vi.fn(async () => undefined),
    reset: vi.fn(),
    snapshot: vi.fn(() => ({ session: null, credentials: null, accountId: null })),
    restoreSnapshot: vi.fn(),
    onAuthFailure: vi.fn(() => () => undefined),
    onTokenRefresh: vi.fn(() => () => undefined),
    hasAccountCapability: vi.fn(() => false),
    request: vi.fn(async () => { throw new Error('not mocked'); }),
    getStoredOAuthTokens: vi.fn(async () => null),
    getStoredCredentials: vi.fn(async () => null),
    accountId: 'acc-1',
    connectedAccountId: 'acc-1',
    currentSession: { apiUrl: 'https://mail.example.com/jmap/' },
    username: 'user',
    serverUrl: 'https://mail.example.com',
  },
  AuthenticationError: class AuthenticationError extends Error {},
  NetworkError: class NetworkError extends Error {},
  SessionSupersededError: class SessionSupersededError extends Error {},
}));

vi.mock('../push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
}));

import { AppState } from 'react-native';
import { jmapClient } from '../../api/jmap-client';
import { useAuthStore } from '../../stores/auth-store';
import { useAccountStore } from '../../stores/account-store';
import { useNetworkStore } from '../../stores/network-store';
import { recoverSession, refreshWithSession, watchSessionRecovery } from '../session-recovery';

const mockLoadAccount = jmapClient.loadAccount as ReturnType<typeof vi.fn>;
const mockLoadFromCache = jmapClient.loadAccountFromCache as ReturnType<typeof vi.fn>;
const mockRevalidate = jmapClient.revalidateSession as ReturnType<typeof vi.fn>;

let appStateListeners: ((state: string) => void)[] = [];
const setAppState = (state: string) => appStateListeners.forEach((listener) => listener(state));

// A launch whose session discovery the server refused (#172): the account
// shows what is cached, with the error, and no live session.
async function startWithRefusedSessionDiscovery(): Promise<void> {
  useAccountStore.setState({
    accounts: [{
      id: 'acc-1', serverUrl: 'https://mail.example.com', username: 'acc-1', displayName: 'acc-1',
      email: 'acc-1', avatarColor: '#000', lastLoginAt: 0, isConnected: true, hasError: false, isDefault: true,
    }],
    activeAccountId: 'acc-1',
    defaultAccountId: 'acc-1',
  });
  mockLoadFromCache.mockResolvedValueOnce(true);
  mockRevalidate.mockRejectedValueOnce(new Error('Session discovery failed: 400 Bad Request'));
  await useAuthStore.getState().restoreSession();
  await vi.waitFor(() => expect(useAccountStore.getState().accounts[0].hasError).toBe(true));
  expect(useAuthStore.getState().session).toBeNull();
}

let stop: (() => void) | null = null;

beforeEach(() => {
  mockLoadAccount.mockReset();
  mockLoadFromCache.mockReset().mockResolvedValue(false);
  mockRevalidate.mockReset().mockResolvedValue(null);
  appStateListeners = [];
  vi.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, listener: (state: string) => void) => {
    appStateListeners.push(listener);
    return { remove: () => { appStateListeners = appStateListeners.filter((l) => l !== listener); } };
  }) as never);
  useNetworkStore.setState({ online: true });
  useAuthStore.setState({
    isAuthenticated: false, isLoading: false, hasRestoredSession: false, error: null,
    serverUrl: null, username: null, session: null, accountId: null, activeAccountId: null, client: null,
  });
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.restoreAllMocks();
});

describe('a session that failed to come up', () => {
  it('comes back when the app returns to the foreground', async () => {
    await startWithRefusedSessionDiscovery();
    stop = watchSessionRecovery();
    mockLoadAccount.mockResolvedValue(true);

    setAppState('background');
    expect(mockLoadAccount).not.toHaveBeenCalled();
    setAppState('active');

    await vi.waitFor(() => expect(useAuthStore.getState().session).not.toBeNull());
    expect(mockLoadAccount).toHaveBeenCalledWith('acc-1');
    expect(useAccountStore.getState().accounts[0]).toMatchObject({ isConnected: true, hasError: false });
  });

  it('comes back on a pull to refresh, before the refresh runs', async () => {
    await startWithRefusedSessionDiscovery();
    mockLoadAccount.mockResolvedValue(true);
    const load = vi.fn(async () => useAuthStore.getState().session);

    const sessionSeenByLoad = await refreshWithSession(load);

    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(sessionSeenByLoad).not.toBeNull();
  });

  it('comes back when the network does', async () => {
    await startWithRefusedSessionDiscovery();
    stop = watchSessionRecovery();
    mockLoadAccount.mockResolvedValue(true);

    useNetworkStore.setState({ online: false });
    useNetworkStore.setState({ online: true });

    await vi.waitFor(() => expect(useAuthStore.getState().session).not.toBeNull());
  });

  it('loads the account once for calls that come together', async () => {
    await startWithRefusedSessionDiscovery();
    mockLoadAccount.mockResolvedValue(true);

    await Promise.all([recoverSession(), recoverSession(), refreshWithSession(async () => undefined)]);

    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
  });

  it('leaves a live session alone', async () => {
    await startWithRefusedSessionDiscovery();
    mockLoadAccount.mockResolvedValue(true);
    await recoverSession();
    stop = watchSessionRecovery();

    setAppState('background');
    setAppState('active');
    await refreshWithSession(async () => undefined);

    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
  });
});
