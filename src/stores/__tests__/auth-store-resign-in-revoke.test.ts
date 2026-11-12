import { describe, it, expect, vi, beforeEach } from 'vitest';

// Signing in again to an account already on the phone stores a new token
// bundle over the old one. The old refresh token is revoked once the new one
// is stored (webmail 66d46d23a, #1571), so the old grant doesn't stay open on
// the server. Only the replaced token, only Stalwart's own, never a paired one.

const store = vi.hoisted(() => ({ tokens: new Map<string, Record<string, unknown>>(), next: null as Record<string, unknown> | null }));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    // Stores the new bundle over the old one, as the real connect does.
    connect: vi.fn(async (serverUrl: string, username: string) => {
      if (store.next) store.tokens.set(`${username}@${new URL(serverUrl).host}`, store.next);
      return { apiUrl: 'https://mail.example.com/jmap/' };
    }),
    getStoredOAuthTokens: vi.fn(async (id: string) => store.tokens.get(id) ?? null),
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
    currentSession: { apiUrl: 'https://mail.example.com/jmap/' },
    username: 'user@example.com',
    serverUrl: 'https://mail.example.com',
  },
  AuthenticationError: class AuthenticationError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));

vi.mock('../../lib/push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
}));

const revoked = vi.hoisted(() => ({ calls: [] as Array<{ serverUrl: string; tokens: Record<string, unknown>; storedThen: unknown }> }));
vi.mock('../../lib/oauth-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/oauth-native')>();
  return {
    ...actual,
    revokeRefreshToken: vi.fn(async (serverUrl: string, tokens: Record<string, unknown>) => {
      revoked.calls.push({ serverUrl, tokens, storedThen: store.tokens.get('user@example.com@mail.example.com')?.refreshToken });
    }),
  };
});

import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';
import { generateAccountId } from '../../lib/account-utils';

const SERVER = 'https://mail.example.com';
const ACCOUNT = generateAccountId('user@example.com', SERVER);

function bundle(refreshToken: string, extra: Record<string, unknown> = {}) {
  return { accessToken: `at-${refreshToken}`, refreshToken, tokenEndpoint: `${SERVER}/auth/token`, clientId: 'swc1.x', source: 'totp', ...extra };
}

beforeEach(() => {
  revoked.calls = [];
  store.tokens.clear();
  store.next = null;
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  useAuthStore.setState({ isAuthenticated: false, isLoading: false, error: null, reauth: null });
});

function registered(): void {
  useAccountStore.getState().addAccount({
    serverUrl: SERVER, username: 'user@example.com', displayName: 'user', email: 'user@example.com',
    lastLoginAt: 1, isConnected: false, hasError: false,
  });
}

describe('signing in again to an account on the phone', () => {
  it('revokes the refresh token it replaced, after the new one is stored', async () => {
    expect(ACCOUNT).toBe('user@example.com@mail.example.com');
    registered();
    store.tokens.set(ACCOUNT, bundle('rt-old'));
    store.next = bundle('rt-new');

    await useAuthStore.getState().login(SERVER, 'user@example.com', 'pw', { totp: '123456' });

    await vi.waitFor(() => expect(revoked.calls).toHaveLength(1));
    expect(revoked.calls[0].tokens.refreshToken).toBe('rt-old');
    expect(revoked.calls[0].storedThen).toBe('rt-new');
  });

  it('revokes nothing for a first sign-in, an unchanged token, a paired bundle or another provider', async () => {
    store.next = bundle('rt-new');
    await useAuthStore.getState().login(SERVER, 'user@example.com', 'pw', { totp: '1' });

    store.tokens.set(ACCOUNT, bundle('rt-same'));
    store.next = bundle('rt-same');
    await useAuthStore.getState().login(SERVER, 'user@example.com', 'pw', { totp: '2' });

    store.tokens.set(ACCOUNT, bundle('rt-paired', { source: 'pairing' }));
    store.next = bundle('rt-new2');
    await useAuthStore.getState().login(SERVER, 'user@example.com', 'pw', { totp: '3' });

    store.tokens.set(ACCOUNT, bundle('rt-idp', { tokenEndpoint: 'https://sso.example.net/token', source: 'native' }));
    store.next = bundle('rt-new3');
    await useAuthStore.getState().login(SERVER, 'user@example.com', 'pw', { totp: '4' });

    await new Promise((r) => setTimeout(r, 20));
    expect(revoked.calls).toEqual([]);
  });
});
