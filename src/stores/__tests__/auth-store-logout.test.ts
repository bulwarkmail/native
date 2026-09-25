import { describe, it, expect, vi, beforeEach } from 'vitest';

// Signing out of the active account: the app moves on to the next signed-in
// account, and to the sign-in screen after the last one.

const { client, SessionSupersededError } = vi.hoisted(() => {
  const A = 'usera@mail.example.org';
  const B = 'userb@mail.example.org';
  const C = 'userc@mail.example.org';
  const jmapIds: Record<string, string> = { [A]: 'd', [B]: 'e', [C]: 'f' };
  const session = (jmapId: string) => ({
    apiUrl: 'https://mail.example.org/jmap/',
    downloadUrl: '',
    uploadUrl: '',
    eventSourceUrl: '',
    primaryAccounts: { 'urn:ietf:params:jmap:mail': jmapId },
    accounts: {
      [jmapId]: {
        name: jmapId,
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: { 'urn:ietf:params:jmap:mail': {}, 'urn:ietf:params:jmap:principals:owner': {} },
      },
    },
    capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:mail': {}, 'urn:ietf:params:jmap:metadata': {} },
    state: 'b3bed0bb',
  });
  return {
    client: {
      A,
      B,
      C,
      jmapIds,
      session,
      // The local account (username@host) the client serves; null while it
      // serves none.
      served: null as string | null,
      epoch: 0,
      loadErrors: {} as Record<string, Error>,
    },
    SessionSupersededError: class SessionSupersededError extends Error {},
  };
});

vi.mock('../../api/jmap-client', () => {
  class AuthenticationError extends Error {}
  class NetworkError extends Error {}
  return {
    jmapClient: {
      get isConnected() { return client.served !== null; },
      get accountId() {
        if (!client.served) throw new Error('Not authenticated - call connect() first');
        return client.jmapIds[client.served];
      },
      get connectedAccountId() { return client.served ? client.jmapIds[client.served] : null; },
      get currentSession() { return client.served ? client.session(client.jmapIds[client.served]) : null; },
      get username() { return client.served ? client.served.split('@')[0] : null; },
      get serverUrl() { return client.served ? 'https://mail.example.org' : null; },
      loadAccount: vi.fn(async (accountId: string) => {
        const epoch = ++client.epoch;
        client.served = null;
        await Promise.resolve();
        if (epoch !== client.epoch) throw new SessionSupersededError();
        const error = client.loadErrors[accountId];
        if (error) throw error;
        client.served = accountId;
        return true;
      }),
      snapshot: vi.fn(() => ({ served: client.served })),
      restoreSnapshot: vi.fn((snap: { served: string | null }) => {
        client.epoch += 1;
        client.served = snap.served;
      }),
      reset: vi.fn(() => {
        client.epoch += 1;
        client.served = null;
      }),
      logout: vi.fn(async () => undefined),
      consumeLegacyCredentials: vi.fn(async () => null),
      clearAccountCredentials: vi.fn(async () => undefined),
      getStoredOAuthTokens: vi.fn(async () => null),
      onAuthFailure: vi.fn(() => () => undefined),
      onTokenRefresh: vi.fn(() => () => undefined),
      hasAccountCapability: vi.fn(() => true),
      hasCapability: vi.fn(() => false),
      getMaxObjectsInGet: () => 500,
      getMaxObjectsInSet: () => 500,
      getMaxCallsInRequest: () => 16,
      getSharedMailAccounts: () => [],
      getAccountName: () => 'user',
      request: vi.fn(async (calls: Array<[string, Record<string, unknown>, string]>) => {
        if (!client.served) throw new Error('Not connected');
        return {
          methodResponses: calls.map(([name, args, id]) => [name, {
            accountId: args.accountId, state: 's1', list: [], notFound: [],
          }, id]),
        };
      }),
    },
    AuthenticationError,
    NetworkError,
    SessionSupersededError,
  };
});

vi.mock('../../lib/push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
  forgetPushServerState: vi.fn(async () => undefined),
  forgetPushSubscriptionExpiry: vi.fn(async () => undefined),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { JMAPSession } from '../../api/types';
import { AuthenticationError, NetworkError } from '../../api/jmap-client';
import { sessionFingerprint, writeServerFingerprint } from '../../lib/server-fingerprint';
import { useAccountStore } from '../account-store';
import { useAuthStore } from '../auth-store';
import { useEmailStore } from '../email-store';
import { useOutboxStore } from '../outbox-store';

const { A, B, C } = client;
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

async function signedIn(...accounts: string[]): Promise<void> {
  const entry = (id: string) => ({
    id, serverUrl: 'https://mail.example.org', username: id.split('@')[0], displayName: id, email: id,
    avatarColor: '#000', lastLoginAt: 0, isConnected: true, hasError: false, isDefault: id === accounts[0],
  });
  useAccountStore.setState({ accounts: accounts.map(entry), activeAccountId: accounts[0], defaultAccountId: accounts[0] });
  for (const account of accounts) {
    await writeServerFingerprint(account, sessionFingerprint(client.session(client.jmapIds[account]) as unknown as JMAPSession));
  }
  client.served = accounts[0];
  await useOutboxStore.getState().setAccount(null);
  useEmailStore.setState({ activeAccountId: null, accountSnapshots: {} });
  useEmailStore.getState().setActiveAccount(accounts[0]);
  await useOutboxStore.getState().resume(accounts[0]);
  useAuthStore.setState({
    isAuthenticated: true,
    isLoading: false,
    hasRestoredSession: true,
    session: client.session(client.jmapIds[accounts[0]]) as unknown as JMAPSession,
    activeAccountId: accounts[0],
    accountId: client.jmapIds[accounts[0]],
    serverUrl: 'https://mail.example.org',
    username: accounts[0].split('@')[0],
    client: null,
  });
}

const where = () => ({
  signedIn: useAuthStore.getState().isAuthenticated,
  auth: useAuthStore.getState().activeAccountId,
  registry: useAccountStore.getState().activeAccountId,
  email: useEmailStore.getState().activeAccountId,
  client: client.served,
});

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await AsyncStorage.clear();
  client.loadErrors = {};
});

describe('signing out of the active account (Stalwart 1.0)', () => {
  it('shows the sign-in screen after the last account', async () => {
    await signedIn(A);

    await useAuthStore.getState().logout();

    expect(where()).toEqual({ signedIn: false, auth: null, registry: null, email: null, client: null });
    expect(useAccountStore.getState().accounts).toEqual([]);
  });

  it('moves on to the next account', async () => {
    await signedIn(A, B);

    await useAuthStore.getState().logout();
    await settle();

    expect(where()).toEqual({ signedIn: true, auth: B, registry: B, email: B, client: B });
    expect(useAccountStore.getState().accounts.map((a) => a.id)).toEqual([B]);
  });

  it('shows the next account offline when its server does not answer, not the one signed out', async () => {
    await signedIn(A, B);
    client.loadErrors = { [B]: new NetworkError('Network request failed') };

    await useAuthStore.getState().logout();
    await settle();

    expect(where()).toEqual({ signedIn: true, auth: B, registry: B, email: B, client: null });
    expect(useAuthStore.getState().session).toBeNull();
    expect(useOutboxStore.getState().activeAccountId).toBe(B);
  });

  it('skips a next account whose sign-in is refused', async () => {
    await signedIn(A, B, C);
    client.loadErrors = { [B]: new AuthenticationError('Invalid credentials') };

    await useAuthStore.getState().logout();
    await settle();

    expect(where()).toEqual({ signedIn: true, auth: C, registry: C, email: C, client: C });
    expect(useAccountStore.getState().accounts.map((a) => a.id)).toEqual([C]);
  });
});
