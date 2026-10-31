import { describe, it, expect, vi, beforeEach } from 'vitest';

// U-133: a sign-in that hangs had no way out. The sign-in screen now hands
// the store an AbortSignal; once it fires, the sign-in rejects at once, the
// client goes back to what it served before, and nothing of the account the
// sign-in was adding stays behind, even when the connect finishes later.

let finishConnect: ((value: unknown) => void) | null = null;

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    connect: vi.fn(() => new Promise((resolve) => { finishConnect = resolve; })),
    snapshot: vi.fn(() => ({ session: 'previous', credentials: null, accountId: 'prev' })),
    restoreSnapshot: vi.fn(),
    reset: vi.fn(),
    clearAccountCredentials: vi.fn(async () => undefined),
    onAuthFailure: vi.fn(() => () => undefined),
    onTokenRefresh: vi.fn(() => () => undefined),
  },
  AuthenticationError: class AuthenticationError extends Error {},
  InvalidTokenError: class InvalidTokenError extends Error {},
  NetworkError: class NetworkError extends Error {},
  SessionSupersededError: class SessionSupersededError extends Error {},
}));

vi.mock('../../lib/push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
}));

import { jmapClient } from '../../api/jmap-client';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';

const SERVER = 'https://mail.example.com';

beforeEach(() => {
  vi.clearAllMocks();
  finishConnect = null;
  useAccountStore.setState({ accounts: [], activeAccountId: null });
  useAuthStore.setState({ isAuthenticated: false, isLoading: false, error: null });
});

async function connectStarted(): Promise<void> {
  await vi.waitFor(() => expect(finishConnect).not.toBeNull());
}

describe('cancelling a sign-in', () => {
  it('rejects at once while the server has not answered, and keeps no error', async () => {
    const controller = new AbortController();
    const pending = useAuthStore.getState().login(SERVER, 'ada@example.com', 'pw', { signal: controller.signal });
    await connectStarted();

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'SignInCancelledError' });

    expect(useAuthStore.getState()).toMatchObject({ isLoading: false, error: null, isAuthenticated: false });
    // The client must not go on serving the half-connected account.
    expect(jmapClient.reset).toHaveBeenCalled();
    expect(useAccountStore.getState().accounts).toEqual([]);
  });

  it('drops the credentials a connect stores after the user cancelled', async () => {
    const controller = new AbortController();
    const pending = useAuthStore.getState().login(SERVER, 'ada@example.com', 'pw', { signal: controller.signal });
    await connectStarted();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'SignInCancelledError' });

    finishConnect!({ apiUrl: `${SERVER}/jmap/` });
    await vi.waitFor(() => {
      expect(jmapClient.clearAccountCredentials).toHaveBeenCalledWith('ada@example.com@mail.example.com');
    });
    expect(useAccountStore.getState().accounts).toEqual([]);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('puts the account in use back when adding one is cancelled', async () => {
    useAuthStore.setState({ isAuthenticated: true });
    const controller = new AbortController();
    const pending = useAuthStore.getState().login(SERVER, 'bob@example.com', 'pw', {
      addAccount: true,
      signal: controller.signal,
    });
    await connectStarted();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'SignInCancelledError' });

    expect(jmapClient.restoreSnapshot).toHaveBeenCalledWith({ session: 'previous', credentials: null, accountId: 'prev' });
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('does not start when the signal fired before', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      useAuthStore.getState().loginWithToken(SERVER, 'tok', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'SignInCancelledError' });
    expect(useAuthStore.getState().error).toBeNull();
  });
});
