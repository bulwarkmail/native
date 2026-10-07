import { describe, it, expect, vi, beforeEach } from 'vitest';

// A sign-in records the login's JMAP account id on the account entry, so a
// composer opened after an offline cold start can queue its send. It is
// recorded only while the client serves that very account: JMAP ids repeat
// across servers, and a connect that lands mid-switch must not stamp one
// account's id onto another.

const client = vi.hoisted(() => ({
  username: 'user@example.com' as string | null,
  serverUrl: 'https://mail.example.com' as string | null,
  connectedAccountId: 'acc-1' as string | null,
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    connect: vi.fn(async () => ({ apiUrl: 'https://mail.example.com/jmap/' })),
    snapshot: vi.fn(() => ({ session: null, credentials: null, accountId: null })),
    restoreSnapshot: vi.fn(),
    onAuthFailure: vi.fn(() => () => undefined),
    onTokenRefresh: vi.fn(() => () => undefined),
    hasAccountCapability: vi.fn(() => true),
    getAccountName: () => undefined,
    getSharedMailAccounts: () => [],
    request: vi.fn(async () => { throw new Error('offline'); }),
    get accountId() { return client.connectedAccountId ?? 'acc-1'; },
    get connectedAccountId() { return client.connectedAccountId; },
    isConnected: true,
    currentSession: { apiUrl: 'https://mail.example.com/jmap/' },
    get username() { return client.username; },
    get serverUrl() { return client.serverUrl; },
  },
  AuthenticationError: class AuthenticationError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));

vi.mock('../../lib/push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
}));

import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';

const ID = 'user@example.com@mail.example.com';

beforeEach(() => {
  client.username = 'user@example.com';
  client.serverUrl = 'https://mail.example.com';
  client.connectedAccountId = 'acc-1';
});

describe('applyConnectedState records the JMAP account id', () => {
  it('records it on the account the client serves', async () => {
    await useAuthStore.getState().login('https://mail.example.com', 'user@example.com', 'pass');
    expect(useAccountStore.getState().getAccountById(ID)?.jmapAccountId).toBe('acc-1');
  });

  it('updates it when the server reports another one', async () => {
    client.connectedAccountId = 'acc-2';
    await useAuthStore.getState().login('https://mail.example.com', 'user@example.com', 'pass');
    expect(useAccountStore.getState().getAccountById(ID)?.jmapAccountId).toBe('acc-2');
  });

  it('records nothing while the client serves another account', async () => {
    client.username = 'other@example.com';
    await useAuthStore.getState().login('https://mail.example.com', 'second@example.com', 'pass');
    const entry = useAccountStore.getState().getAccountById('second@example.com@mail.example.com');
    expect(entry).toBeDefined();
    expect(entry?.jmapAccountId).toBeUndefined();
    // The account the client does serve is not written to either.
    expect(useAccountStore.getState().getAccountById(ID)?.jmapAccountId).toBe('acc-2');
  });

  it('records nothing without a connected JMAP account', async () => {
    client.username = 'third@example.com';
    client.connectedAccountId = null;
    await useAuthStore.getState().login('https://mail.example.com', 'third@example.com', 'pass');
    expect(useAccountStore.getState().getAccountById('third@example.com@mail.example.com')?.jmapAccountId).toBeUndefined();
  });
});
