import { describe, it, expect, vi, beforeEach } from 'vitest';

// A share from a new owner refreshes the session so its collections can be
// fetched. The fresh session is only ever applied to the account it was
// asked for: a switch or a client serving another account changes nothing.

const client = vi.hoisted(() => ({
  username: 'user@example.com' as string | null,
  serverUrl: 'https://mail.example.com' as string | null,
  session: { apiUrl: 'https://mail.example.com/jmap/', accounts: { 'acc-1': {} } } as Record<string, unknown>,
  refreshSession: vi.fn(),
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    connect: vi.fn(async () => client.session),
    snapshot: vi.fn(() => ({ session: null, credentials: null, accountId: null })),
    restoreSnapshot: vi.fn(),
    onAuthFailure: vi.fn(() => () => undefined),
    onTokenRefresh: vi.fn(() => () => undefined),
    hasAccountCapability: vi.fn(() => true),
    getAccountName: () => undefined,
    getSharedMailAccounts: () => [],
    request: vi.fn(async () => { throw new Error('offline'); }),
    refreshSession: client.refreshSession,
    accountId: 'acc-1',
    connectedAccountId: 'acc-1',
    isConnected: true,
    get currentSession() { return client.session; },
    get username() { return client.username; },
    get serverUrl() { return client.serverUrl; },
  },
  AuthenticationError: class AuthenticationError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));

vi.mock('../../lib/push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
  clearStoredRelayBaseUrl: vi.fn(async () => undefined),
}));

import { useAuthStore } from '../auth-store';

const ID = 'user@example.com@mail.example.com';
const shared = { apiUrl: 'https://mail.example.com/jmap/', accounts: { 'acc-1': {}, dana: {} } };

beforeEach(async () => {
  client.username = 'user@example.com';
  client.serverUrl = 'https://mail.example.com';
  client.session = { apiUrl: 'https://mail.example.com/jmap/', accounts: { 'acc-1': {} } };
  client.refreshSession.mockReset();
  await useAuthStore.getState().login('https://mail.example.com', 'user@example.com', 'pass');
});

describe('refreshSessionFor', () => {
  it('sets the fresh session for the active account the client serves', async () => {
    client.refreshSession.mockImplementation(async () => { client.session = shared; return shared; });
    expect(await useAuthStore.getState().refreshSessionFor(ID)).toBe(true);
    expect(useAuthStore.getState().session).toBe(shared);
  });

  it('changes nothing when the account was switched away mid-fetch', async () => {
    const before = useAuthStore.getState().session;
    client.refreshSession.mockImplementation(async () => {
      useAuthStore.setState({ activeAccountId: 'other@example.com@mail.example.com' });
      client.session = shared;
      return shared;
    });
    expect(await useAuthStore.getState().refreshSessionFor(ID)).toBe(false);
    expect(useAuthStore.getState().session).toBe(before);
  });

  it('never fetches while the client serves another account, or for an account not active', async () => {
    expect(await useAuthStore.getState().refreshSessionFor('other@example.com@mail.example.com')).toBe(false);
    client.username = 'other@example.com';
    expect(await useAuthStore.getState().refreshSessionFor(ID)).toBe(false);
    expect(client.refreshSession).not.toHaveBeenCalled();
  });

  it('keeps the live session when the fetch fails or is overtaken', async () => {
    const before = useAuthStore.getState().session;
    client.refreshSession.mockImplementation(async () => { throw new Error('offline'); });
    expect(await useAuthStore.getState().refreshSessionFor(ID)).toBe(false);
    client.refreshSession.mockImplementation(async () => null);
    expect(await useAuthStore.getState().refreshSessionFor(ID)).toBe(false);
    expect(useAuthStore.getState().session).toBe(before);
  });
});
