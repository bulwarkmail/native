import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Switching accounts: the email store, and with it the outbox, moves to the
// new account first; the JMAP client only once loadAccount() has the new
// session, and the server behind it is checked after that. An op queued for
// one account must never reach another, nor a replaced server.

const { client } = vi.hoisted(() => {
  const A = 'usera@mail.example.org';
  const B = 'userb@mail.example.org';
  const jmapIds: Record<string, string> = { [A]: 'd', [B]: 'e' };
  const session = (version: string, jmapId: string) => ({
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
        accountCapabilities: {
          'urn:ietf:params:jmap:mail': {},
          'urn:stalwart:jmap': {},
          ...(version === '1.0' ? { 'urn:ietf:params:jmap:principals:owner': {}, 'urn:ietf:params:jmap:metadata': {} } : {}),
        },
      },
    },
    capabilities: {
      'urn:ietf:params:jmap:core': {},
      'urn:ietf:params:jmap:mail': {},
      ...(version === '1.0' ? { 'urn:ietf:params:jmap:metadata': {} } : {}),
    },
    state: 'b3bed0bb',
  });
  return {
    client: {
      A,
      B,
      jmapIds,
      session,
      version: '1.0',
      // The local account (username@host) the client serves; null while it
      // serves none, as during loadAccount().
      served: null as string | null,
      // loadAccount() has the new session once this settles.
      loadGate: Promise.resolve() as Promise<unknown>,
      loadError: null as Error | null,
      emailSets: [] as Array<{ served: string; args: Record<string, unknown> }>,
    },
  };
});

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    get isConnected() { return client.served !== null; },
    get accountId() {
      if (!client.served) throw new Error('Not authenticated - call connect() first');
      return client.jmapIds[client.served];
    },
    get currentSession() {
      return client.served ? client.session(client.version, client.jmapIds[client.served]) : null;
    },
    get username() { return client.served ? client.served.split('@')[0] : null; },
    get serverUrl() { return client.served ? 'https://mail.example.org' : null; },
    loadAccount: vi.fn(async (accountId: string) => {
      client.served = null;
      await client.loadGate;
      if (client.loadError) throw client.loadError;
      client.served = accountId;
      return true;
    }),
    snapshot: vi.fn(() => ({ served: client.served })),
    restoreSnapshot: vi.fn((snap: { served: string | null }) => { client.served = snap.served; }),
    consumeLegacyCredentials: vi.fn(async () => null),
    clearAccountCredentials: vi.fn(async () => undefined),
    reset: vi.fn(),
    onAuthFailure: vi.fn(() => () => undefined),
    onTokenRefresh: vi.fn(() => () => undefined),
    hasAccountCapability: vi.fn(() => true),
    hasCapability: vi.fn(() => false),
    getMaxObjectsInGet: () => 500,
    getMaxObjectsInSet: () => 500,
    getMaxCallsInRequest: () => 16,
    getSharedMailAccounts: () => [],
    getAccountName: () => 'user',
    getStoredOAuthTokens: vi.fn(async () => null),
    request: vi.fn(async (calls: Array<[string, Record<string, unknown>, string]>) => {
      if (!client.served) throw new Error('Not connected');
      for (const [name, args] of calls) {
        if (name === 'Email/set') client.emailSets.push({ served: client.served, args });
      }
      return {
        methodResponses: calls.map(([name, args, id]) => [name, {
          accountId: args.accountId, state: 's1', list: [], notFound: [],
          ...(name === 'Email/set'
            ? { updated: Object.fromEntries(Object.keys((args.update ?? {}) as object).map((k) => [k, null])) }
            : {}),
        }, id]),
      };
    }),
  },
  AuthenticationError: class AuthenticationError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));

vi.mock('../../lib/push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
  forgetPushServerState: vi.fn(async () => undefined),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { JMAPSession } from '../../api/types';
import { sessionFingerprint, writeServerFingerprint } from '../../lib/server-fingerprint';
import { useAccountStore } from '../account-store';
import { useAuthStore } from '../auth-store';
import { useEmailStore } from '../email-store';
import { applyOrQueue, useOutboxStore } from '../outbox-store';

const { A, B } = client;
const fingerprint = (version: string, account: string) =>
  sessionFingerprint(client.session(version, client.jmapIds[account]) as unknown as JMAPSession);
const queued = (emailId: string) => ({
  id: `q-${emailId}`, createdAt: 1, attempts: 0, op: { kind: 'keywords', emailId, patch: { $seen: true } },
});
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const updatedIds = () => client.emailSets.flatMap(({ args }) => Object.keys((args.update ?? {}) as object));

function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

const readStored = vi.mocked(AsyncStorage.getItem).getMockImplementation()!;

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await AsyncStorage.clear();
  client.version = '1.0';
  client.loadGate = Promise.resolve();
  client.loadError = null;
  client.emailSets.length = 0;
  const entry = (id: string, username: string) => ({
    id, serverUrl: 'https://mail.example.org', username, displayName: username, email: id,
    avatarColor: '#000', lastLoginAt: 0, isConnected: true, hasError: false, isDefault: id === A,
  });
  useAccountStore.setState({ accounts: [entry(A, 'usera'), entry(B, 'userb')], activeAccountId: A, defaultAccountId: A });
  await writeServerFingerprint(A, fingerprint('1.0', A));
  await writeServerFingerprint(B, fingerprint('1.0', B));

  // A is signed in and live; B has an edit queued from before.
  await AsyncStorage.setItem(`webmail:outbox:v1:${B}`, JSON.stringify([queued('m1')]));
  client.served = A;
  await useOutboxStore.getState().setAccount(null);
  useEmailStore.setState({ activeAccountId: null, accountSnapshots: {} });
  useEmailStore.getState().setActiveAccount(A);
  await useOutboxStore.getState().resume(A);
  useAuthStore.setState({
    isAuthenticated: true,
    isLoading: false,
    session: client.session('1.0', 'd') as unknown as JMAPSession,
    activeAccountId: A,
    accountId: 'd',
    client: null,
  });
});

afterEach(() => {
  vi.mocked(AsyncStorage.getItem).mockImplementation(readStored);
});

describe('switching accounts with queued edits', () => {
  it('sends the new account its queue only once the switch is done and its server was checked (Stalwart 1.0)', async () => {
    const load = deferred();
    client.loadGate = load.promise;
    const check = deferred();
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) => {
      if (key === `server-fingerprint:v1:${B}`) await check.promise;
      return readStored(key);
    });

    const switching = useAuthStore.getState().switchAccount(B);
    await settle();
    // The session is still loading. What App.tsx does when the network comes
    // back, and an edit the user makes in B's cached list:
    expect(useOutboxStore.getState().activeAccountId).toBe(B);
    await useOutboxStore.getState().flush();
    expect((await applyOrQueue({ kind: 'keywords', emailId: 'm2', patch: { $flagged: true } })).queued).toBe(true);
    expect(client.emailSets).toEqual([]);

    // B's session is up, its server not checked yet.
    load.open();
    await settle();
    expect(client.served).toBe(B);
    await useOutboxStore.getState().flush();
    expect(client.emailSets).toEqual([]);

    check.open();
    await switching;
    await settle();

    expect(client.emailSets.length).toBeGreaterThan(0);
    for (const { served, args } of client.emailSets) {
      expect(served).toBe(B);
      expect(args.accountId).toBe('e');
    }
    expect(updatedIds()).toEqual(['m1', 'm2']);
    expect(useOutboxStore.getState().entries).toEqual([]);
  });

  it('drops the queue of an account whose server was replaced before anything is sent (0.16.23 to 1.0)', async () => {
    await writeServerFingerprint(B, fingerprint('0.16.23', B));

    await useAuthStore.getState().switchAccount(B);
    await settle();

    expect(client.emailSets).toEqual([]);
    expect(useOutboxStore.getState().activeAccountId).toBe(B);
    expect(useOutboxStore.getState().entries).toEqual([]);
    expect(await AsyncStorage.getItem(`webmail:outbox:v1:${B}`)).toBeNull();
  });

  it('puts the previous account and its queue back to work when the switch fails (Stalwart 1.0)', async () => {
    client.loadError = new Error('Server unreachable');

    await useAuthStore.getState().switchAccount(B);
    await settle();

    expect(client.served).toBe(A);
    expect(useOutboxStore.getState().activeAccountId).toBe(A);
    expect(useOutboxStore.getState().resumed).toBe(true);
    const result = await applyOrQueue({ kind: 'keywords', emailId: 'a1', patch: { $seen: true } });
    expect(result.queued).toBe(false);
    expect(client.emailSets).toEqual([{ served: A, args: { accountId: 'd', update: { a1: { 'keywords/$seen': true } } } }]);
    // B's queue stays for B.
    expect(JSON.parse((await AsyncStorage.getItem(`webmail:outbox:v1:${B}`))!)).toHaveLength(1);
  });
});
