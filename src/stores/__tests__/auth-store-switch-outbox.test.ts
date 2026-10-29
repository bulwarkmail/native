import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Switching accounts: the email store, and with it the outbox, moves to the
// new account first; the JMAP client only once loadAccount() has the new
// session, and the server behind it is checked after that. An op queued for
// one account must never reach another, nor a replaced server.

const { client, SessionSupersededError } = vi.hoisted(() => {
  const A = 'usera@mail.example.org';
  const B = 'userb@mail.example.org';
  const C = 'userc@mail.example.org';
  const jmapIds: Record<string, string> = { [A]: 'd', [B]: 'e', [C]: 'f' };
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
      C,
      jmapIds,
      session,
      version: '1.0',
      // The local account (username@host) the client serves; null while it
      // serves none, as during loadAccount().
      served: null as string | null,
      // Bumped by every load and restore, as JMAPClient's session epoch: a
      // load that a later one overtook installs nothing.
      epoch: 0,
      // A client without that guard: an overtaken load's session lands anyway.
      ignoreEpoch: false,
      // loadAccount() has the new session once this settles.
      loadGate: Promise.resolve() as Promise<unknown>,
      // Per account, where two loads overlap.
      gates: {} as Record<string, Promise<unknown>>,
      loadError: null as Error | null,
      loadErrors: {} as Record<string, Error>,
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
      return client.served ? client.session(client.version, client.jmapIds[client.served]) : null;
    },
    get username() { return client.served ? client.served.split('@')[0] : null; },
    get serverUrl() { return client.served ? 'https://mail.example.org' : null; },
    loadAccount: vi.fn(async (accountId: string) => {
      const epoch = ++client.epoch;
      client.served = null;
      await (client.gates[accountId] ?? client.loadGate);
      if (epoch !== client.epoch && !client.ignoreEpoch) throw new SessionSupersededError();
      const error = client.loadErrors[accountId] ?? client.loadError;
      if (error) throw error;
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
import { useFilterStore } from '../filter-store';
import { useVacationStore } from '../vacation-store';

const { A, B, C } = client;
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
  client.gates = {};
  client.loadError = null;
  client.loadErrors = {};
  client.ignoreEpoch = false;
  client.emailSets.length = 0;
  const entry = (id: string, username: string) => ({
    id, serverUrl: 'https://mail.example.org', username, displayName: username, email: id,
    avatarColor: '#000', lastLoginAt: 0, isConnected: true, hasError: false, isDefault: id === A,
  });
  useAccountStore.setState({
    accounts: [entry(A, 'usera'), entry(B, 'userb'), entry(C, 'userc')],
    activeAccountId: A,
    defaultAccountId: A,
  });
  await writeServerFingerprint(A, fingerprint('1.0', A));
  await writeServerFingerprint(B, fingerprint('1.0', B));
  await writeServerFingerprint(C, fingerprint('1.0', C));

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

// The account rows have no busy state and a notification tap switches too:
// B can be tapped, then C, before B's session is up.
describe('switches that overlap (Stalwart 1.0)', () => {
  const where = () => ({
    email: useEmailStore.getState().activeAccountId,
    outbox: useOutboxStore.getState().activeAccountId,
    resumed: useOutboxStore.getState().resumed,
    auth: useAuthStore.getState().activeAccountId,
    registry: useAccountStore.getState().activeAccountId,
    client: client.served,
  });
  const on = (account: string) => ({
    email: account, outbox: account, resumed: true, auth: account, registry: account, client: account,
  });
  // An edit the user makes in the list on screen.
  const editOnScreen = () => applyOrQueue({ kind: 'keywords', emailId: 'x1', patch: { $seen: true } });
  const sent = () => client.emailSets.map(({ served, args }) => [served, args.accountId, Object.keys((args.update ?? {}) as object)]);

  it('lands on the account tapped last when the switch before it ends later', async () => {
    const toB = deferred();
    const toC = deferred();
    client.gates = { [B]: toB.promise, [C]: toC.promise };

    const switchingToB = useAuthStore.getState().switchAccount(B);
    await settle();
    const switchingToC = useAuthStore.getState().switchAccount(C);
    await settle();
    toC.open();
    await switchingToC;
    await settle();
    toB.open();
    await switchingToB;
    await settle();

    expect(where()).toEqual(on(C));
    expect((await editOnScreen()).queued).toBe(false);
    // Neither B's queue nor the edit went to B.
    expect(sent()).toEqual([[C, 'f', ['x1']]]);
    expect(JSON.parse((await AsyncStorage.getItem(`webmail:outbox:v1:${B}`))!)).toHaveLength(1);
  });

  it('keeps an edit on screen from the account an overtaken switch left in the client', async () => {
    // As above, with a client that installs the overtaken load's session.
    client.ignoreEpoch = true;
    const toB = deferred();
    const toC = deferred();
    client.gates = { [B]: toB.promise, [C]: toC.promise };

    const switchingToB = useAuthStore.getState().switchAccount(B);
    await settle();
    const switchingToC = useAuthStore.getState().switchAccount(C);
    await settle();
    toC.open();
    await switchingToC;
    toB.open();
    await switchingToB;
    await settle();

    expect(client.served).toBe(B);
    expect(useEmailStore.getState().activeAccountId).toBe(C);
    expect((await editOnScreen()).queued).toBe(true);
    expect(client.emailSets).toEqual([]);
  });

  it('does not put back the account left when an overtaken switch fails', async () => {
    client.ignoreEpoch = true;
    client.loadErrors = { [B]: new Error('Server unreachable') };
    const toB = deferred();
    const toC = deferred();
    client.gates = { [B]: toB.promise, [C]: toC.promise };

    const switchingToB = useAuthStore.getState().switchAccount(B);
    await settle();
    const switchingToC = useAuthStore.getState().switchAccount(C);
    await settle();
    toC.open();
    await switchingToC;
    toB.open();
    await switchingToB;
    await settle();

    expect(where()).toEqual(on(C));
    expect(useAuthStore.getState().error).toBeNull();
  });

  it('puts back the account the first switch left when the last one fails', async () => {
    client.loadErrors = { [C]: new Error('Server unreachable') };
    const toB = deferred();
    const toC = deferred();
    client.gates = { [B]: toB.promise, [C]: toC.promise };

    const switchingToB = useAuthStore.getState().switchAccount(B);
    await settle();
    const switchingToC = useAuthStore.getState().switchAccount(C);
    await settle();
    toB.open();
    await switchingToB;
    toC.open();
    await switchingToC;
    await settle();

    // Not the account-less client C's switch began with.
    expect(where()).toEqual(on(A));
    expect(useAuthStore.getState().error).toBe('Server unreachable');
    expect((await editOnScreen()).queued).toBe(false);
    expect(sent()).toEqual([[A, 'd', ['x1']]]);
  });

  it('goes straight back when the account left is tapped while a switch is under way', async () => {
    const toB = deferred();
    client.gates = { [B]: toB.promise };

    const switchingToB = useAuthStore.getState().switchAccount(B);
    await settle();
    await useAuthStore.getState().switchAccount(A);
    expect(useAuthStore.getState().isLoading).toBe(false);
    await settle();

    expect(where()).toEqual(on(A));
    toB.open();
    await switchingToB;
    await settle();

    expect(where()).toEqual(on(A));
    expect((await editOnScreen()).queued).toBe(false);
    expect(sent()).toEqual([[A, 'd', ['x1']]]);
  });

  // A cold start shows the last account's cached mail while its session
  // loads, drawer and all. The restore a switch overtook gave up, and with
  // the switch failing too, the app went to the sign-in screen.
  it('lets the restore of a cold start land first, and puts it back when the switch fails', async () => {
    client.served = null;
    await useOutboxStore.getState().setAccount(null);
    useEmailStore.setState({ activeAccountId: null, accountSnapshots: {} });
    useAuthStore.setState({ isAuthenticated: false, hasRestoredSession: false, session: null, activeAccountId: null, accountId: null });
    const restoringA = deferred();
    client.gates = { [A]: restoringA.promise };
    client.loadErrors = { [B]: new Error('Server unreachable') };

    const restoring = useAuthStore.getState().restoreSession();
    await settle();
    const switchingToB = useAuthStore.getState().switchAccount(B);
    await settle();
    restoringA.open();
    expect(await restoring).toBe(true);
    await switchingToB;
    await settle();

    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, hasRestoredSession: true, error: 'Server unreachable' });
    expect(where()).toEqual(on(A));
    expect((await editOnScreen()).queued).toBe(false);
    expect(sent()).toEqual([[A, 'd', ['x1']]]);
  });
});

// The vacation and filter stores are not per login: shown after a switch,
// the previous login's auto-reply, forwarding and rules could be saved into
// the new one.
describe('switching accounts clears the vacation and filters', () => {
  it('shows nothing of the previous login once the switch starts', async () => {
    useVacationStore.setState({ hasLoaded: true, isEnabled: true, subject: 'A is away', forward: { enabled: true, to: 'a@example.org', keepCopy: true } });
    useFilterStore.setState({ isSupported: true, activeScriptId: 's1', rawScript: 'keep;', rules: [{
      id: 'r1', name: 'A rule', enabled: true, matchType: 'all', stopProcessing: false,
      conditions: [{ field: 'from', comparator: 'contains', value: 'x' }], actions: [{ type: 'mark_read' }],
    }] });
    const load = deferred();
    client.loadGate = load.promise;

    const switching = useAuthStore.getState().switchAccount(B);
    await settle();
    expect(useVacationStore.getState()).toMatchObject({ hasLoaded: false, isEnabled: false, subject: '', forward: null });
    expect(useFilterStore.getState()).toMatchObject({ rules: [], activeScriptId: null, rawScript: '' });

    load.open();
    await switching;
  });
});
