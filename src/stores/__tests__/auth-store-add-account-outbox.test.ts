import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Adding an account while the one in use has edits queued. The JMAP client
// serves the new account as soon as its session is up (connect), but the
// stores, and with them the outbox, move to it only once its server was
// checked. The queue must not replay through the new account meanwhile:
// Stalwart's ids repeat across accounts, so a queued move or destroy of A's
// "x" would hit C's "x".

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
        accountCapabilities: {
          'urn:ietf:params:jmap:mail': {},
          'urn:stalwart:jmap': {},
          'urn:ietf:params:jmap:principals:owner': {},
          'urn:ietf:params:jmap:metadata': {},
        },
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
      // Bumped by every sign-in, load and restore, as JMAPClient's session
      // epoch: one that a later one overtook installs nothing.
      epoch: 0,
      connectGate: Promise.resolve() as Promise<unknown>,
      connectError: null as Error | null,
      loadGate: Promise.resolve() as Promise<unknown>,
      // loadAccount() fails for these, as for a server that does not answer.
      loadErrors: {} as Record<string, Error>,
      requestGate: null as Promise<unknown> | null,
      emailSets: [] as Array<{ served: string; args: Record<string, unknown> }>,
    },
    SessionSupersededError: class SessionSupersededError extends Error {
      constructor() {
        super('Another account was opened before this one finished loading');
        this.name = 'SessionSupersededError';
      }
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
      return client.served ? client.session(client.jmapIds[client.served]) : null;
    },
    get username() { return client.served ? client.served.split('@')[0] : null; },
    get serverUrl() { return client.served ? 'https://mail.example.org' : null; },
    connect: vi.fn(async (_url: string, username: string) => {
      const epoch = ++client.epoch;
      client.served = null;
      await client.connectGate;
      if (epoch !== client.epoch) throw new SessionSupersededError();
      if (client.connectError) throw client.connectError;
      client.served = `${username}@mail.example.org`;
      return client.session(client.jmapIds[client.served]);
    }),
    loadAccount: vi.fn(async (accountId: string) => {
      const epoch = ++client.epoch;
      client.served = null;
      await client.loadGate;
      if (epoch !== client.epoch) throw new SessionSupersededError();
      if (client.loadErrors[accountId]) throw client.loadErrors[accountId];
      client.served = accountId;
      return true;
    }),
    snapshot: vi.fn(() => ({ served: client.served })),
    restoreSnapshot: vi.fn((snap: { served: string | null }) => {
      client.epoch += 1;
      client.served = snap.served;
    }),
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
      const served = client.served;
      for (const [name, args] of calls) {
        if (name === 'Email/set') client.emailSets.push({ served, args });
      }
      if (client.requestGate) await client.requestGate;
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
  SessionSupersededError,
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

const { A, B, C } = client;
const queued = (emailId: string, createdAt = 1) => ({
  id: `q-${emailId}`, createdAt, attempts: 0, op: { kind: 'keywords', emailId, patch: { $seen: true } },
});
const storedQueue = async (account: string) =>
  (JSON.parse((await AsyncStorage.getItem(`webmail:outbox:v1:${account}`)) ?? '[]') as Array<{ op: { emailId: string } }>)
    .map((e) => e.op.emailId);
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}
const readStored = vi.mocked(AsyncStorage.getItem).getMockImplementation()!;
// Hold the new account's server check, the window between its session coming
// up and the stores moving to it.
function holdServerCheck(account: string): () => void {
  const check = deferred();
  vi.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) => {
    if (key === `server-fingerprint:v1:${account}`) await check.promise;
    return readStored(key);
  });
  return check.open;
}
const addC = () => useAuthStore.getState().login('https://mail.example.org', 'userc', 'pw', { addAccount: true });

// A has these ops queued (one the server refused once and that is retried,
// or made offline), stored as the outbox stores them.
async function queueForA(...ops: ReturnType<typeof queued>[]): Promise<void> {
  await AsyncStorage.setItem(`webmail:outbox:v1:${A}`, JSON.stringify(ops));
  useOutboxStore.setState({ entries: ops as never });
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await AsyncStorage.clear();
  client.connectGate = Promise.resolve();
  client.connectError = null;
  client.loadGate = Promise.resolve();
  client.loadErrors = {};
  client.requestGate = null;
  client.emailSets.length = 0;
  const entry = (id: string, username: string) => ({
    id, serverUrl: 'https://mail.example.org', username, displayName: username, email: id,
    avatarColor: '#000', lastLoginAt: 0, isConnected: true, hasError: false, isDefault: id === A,
  });
  useAccountStore.setState({ accounts: [entry(A, 'usera'), entry(B, 'userb')], activeAccountId: A, defaultAccountId: A });
  for (const [account, jmapId] of [[A, 'd'], [B, 'e'], [C, 'f']]) {
    await writeServerFingerprint(account, sessionFingerprint(client.session(jmapId) as unknown as JMAPSession));
  }

  // A is signed in and live.
  client.served = A;
  await useOutboxStore.getState().setAccount(null);
  useEmailStore.setState({ activeAccountId: null, accountSnapshots: {} });
  useEmailStore.getState().setActiveAccount(A);
  await useOutboxStore.getState().resume(A);
  useAuthStore.setState({
    isAuthenticated: true,
    isLoading: false,
    session: client.session('d') as unknown as JMAPSession,
    activeAccountId: A,
    accountId: 'd',
    client: null,
  });
});

afterEach(() => {
  vi.mocked(AsyncStorage.getItem).mockImplementation(readStored);
});

describe('adding an account while the one in use has queued edits (Stalwart 1.0)', () => {
  it('replays nothing through the new account while it is set up', async () => {
    await queueForA(queued('m1'));
    const checked = holdServerCheck(C);

    const login = addC();
    await settle();
    expect(client.served).toBe(C);
    expect(useOutboxStore.getState().activeAccountId).toBe(A);
    // What the retry timer, a network flip or refreshAfterResume does.
    await useOutboxStore.getState().flush();

    checked();
    await login;
    await settle();

    expect(client.emailSets).toEqual([]);
    expect(useOutboxStore.getState().activeAccountId).toBe(C);
    // A's edit waits for A.
    expect(await storedQueue(A)).toEqual(['m1']);
  });

  it('queues an edit made in that window for the account it was made in', async () => {
    const checked = holdServerCheck(C);

    const login = addC();
    await settle();
    const result = await applyOrQueue({ kind: 'keywords', emailId: 'a1', patch: { $seen: true } });
    checked();
    await login;
    await settle();

    expect(result.queued).toBe(true);
    expect(client.emailSets).toEqual([]);
    expect(await storedQueue(A)).toEqual(['a1']);
  });

  it('stops a replay under way for the account in use once the new session is up', async () => {
    await queueForA(queued('m1', 1), queued('m2', 2));
    const firstRequest = deferred();
    client.requestGate = firstRequest.promise;

    const flushing = useOutboxStore.getState().flush();
    await settle();
    // m1 is on its way to A.
    expect(client.emailSets.map((s) => s.served)).toEqual([A]);
    client.requestGate = null;

    // The user signs in to another account meanwhile; C's session comes up.
    const checked = holdServerCheck(C);
    const login = addC();
    await settle();
    expect(client.served).toBe(C);

    // m1's response arrives.
    firstRequest.open();
    await flushing;
    checked();
    await login;
    await settle();

    expect(client.emailSets.map((s) => [s.served, s.args.accountId])).toEqual([[A, 'd']]);
    expect(await storedQueue(A)).toEqual(['m2']);
  });

  it('puts the account in use and its queue back to work when the sign-in fails', async () => {
    await queueForA(queued('m1'));
    const connecting = deferred();
    client.connectGate = connecting.promise;
    client.connectError = new Error('Invalid username or password');

    const login = addC();
    await settle();
    // Held while the client signs in.
    await useOutboxStore.getState().flush();
    expect(client.emailSets).toEqual([]);
    connecting.open();
    await expect(login).rejects.toThrow('Invalid username or password');
    await settle();

    expect(client.served).toBe(A);
    expect(useOutboxStore.getState()).toMatchObject({ activeAccountId: A, resumed: true });
    expect(client.emailSets.map((s) => [s.served, s.args.accountId])).toEqual([[A, 'd']]);
    expect(await storedQueue(A)).toEqual([]);
  });

  it('leaves the client to a switch that began while the sign-in was under way', async () => {
    // A notification tap switches to B while C's sign-in waits on its server.
    const connecting = deferred();
    client.connectGate = connecting.promise;

    const login = addC();
    await settle();
    await useAuthStore.getState().switchAccount(B);
    connecting.open();
    await expect(login).rejects.toThrow('Another account was opened');
    await settle();

    expect(client.served).toBe(B);
    expect(useAuthStore.getState().activeAccountId).toBe(B);
    expect(useEmailStore.getState().activeAccountId).toBe(B);
    expect(useOutboxStore.getState()).toMatchObject({ activeAccountId: B, resumed: true });
  });

  // The sign-in the switch overtook gives up. A switch that failed put back
  // the client the sign-in held, which served no account before C's session
  // was up and C after: A's screens stayed, with every call refused, or
  // reaching C.
  it.each([
    ['before the new session is up', 'connect'],
    ['while the new account\'s server is checked', 'check'],
  ] as const)('puts the account in use back to work when that switch fails %s', async (_label, phase) => {
    await queueForA(queued('m1'));
    client.loadErrors = { [B]: new Error('Server unreachable') };
    const connecting = deferred();
    if (phase === 'connect') client.connectGate = connecting.promise;
    const checked = phase === 'check' ? holdServerCheck(C) : () => undefined;

    const login = addC();
    await settle();
    expect(client.served).toBe(phase === 'check' ? C : null);
    await useAuthStore.getState().switchAccount(B);
    connecting.open();
    checked();
    await expect(login).rejects.toThrow('Another account was opened');
    await settle();

    expect(client.served).toBe(A);
    expect(useAuthStore.getState()).toMatchObject({ activeAccountId: A, isAuthenticated: true });
    expect(useEmailStore.getState().activeAccountId).toBe(A);
    expect(useOutboxStore.getState()).toMatchObject({ activeAccountId: A, resumed: true });
    // A's queue went to A, under A's id.
    expect(client.emailSets.map((s) => [s.served, s.args.accountId])).toEqual([[A, 'd']]);
    expect(await storedQueue(A)).toEqual([]);
  });

  it('falls back on the account a switch landed on once it overtook the sign-in, not on the one the sign-in saved', async () => {
    client.loadErrors = { [A]: new Error('Server unreachable') };
    const connecting = deferred();
    client.connectGate = connecting.promise;

    const login = addC();
    await settle();
    await useAuthStore.getState().switchAccount(B);
    // B is up; C's sign-in still waits on its server.
    await useAuthStore.getState().switchAccount(A);
    connecting.open();
    await expect(login).rejects.toThrow('Another account was opened');
    await settle();

    expect(client.served).toBe(B);
    expect(useAuthStore.getState().activeAccountId).toBe(B);
    expect(useEmailStore.getState().activeAccountId).toBe(B);
    expect(useOutboxStore.getState()).toMatchObject({ activeAccountId: B, resumed: true });
  });
});
