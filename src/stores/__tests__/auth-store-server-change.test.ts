import { describe, it, expect, vi, beforeEach } from 'vitest';

// Restoring the session after the server at the account's address was
// replaced (Stalwart 1.0 installed fresh where 0.16.23 ran): the states the
// app persisted from the old server must never reach the new one.

const { client } = vi.hoisted(() => {
  const accountCaps = (version: string): Record<string, unknown> => ({
    'urn:ietf:params:jmap:mail': {},
    'urn:stalwart:jmap': {},
    ...(version === '1.0' ? { 'urn:ietf:params:jmap:principals:owner': {}, 'urn:ietf:params:jmap:metadata': {} } : {}),
  });
  const session = (version: string) => ({
    apiUrl: 'https://mail.example.com/jmap/',
    downloadUrl: '',
    uploadUrl: '',
    eventSourceUrl: '',
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'f' },
    accounts: { f: { name: 'user', isPersonal: true, isReadOnly: false, accountCapabilities: accountCaps(version) } },
    capabilities: {
      'urn:ietf:params:jmap:core': {},
      'urn:ietf:params:jmap:mail': {},
      ...(version === '1.0' ? { 'urn:ietf:params:jmap:metadata': {} } : {}),
    },
    state: 'b3bed0bb',
  });
  return {
    client: {
      session,
      requests: [] as Array<Array<[string, Record<string, unknown>, string]>>,
    },
  };
});

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    loadAccount: vi.fn(async () => true),
    consumeLegacyCredentials: vi.fn(async () => null),
    clearAccountCredentials: vi.fn(async () => undefined),
    reset: vi.fn(),
    snapshot: vi.fn(() => ({ session: null, credentials: null, accountId: null })),
    restoreSnapshot: vi.fn(),
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
      client.requests.push(calls);
      // The 1.0 server knows nothing of the 0.16.23 states.
      return {
        methodResponses: calls.map(([name, args, id]) => (name.endsWith('/changes')
          ? ['error', { type: 'cannotCalculateChanges' }, id]
          : [name, {
            accountId: args.accountId, state: 'sfy', list: [], notFound: [],
            ...(name === 'Email/set'
              ? { updated: Object.fromEntries(Object.keys((args.update ?? {}) as object).map((k) => [k, null])) }
              : {}),
          }, id])),
      };
    }),
    getStoredOAuthTokens: vi.fn(async () => null),
    accountId: 'f',
    isConnected: true,
    currentSession: client.session('1.0'),
    username: 'user',
    serverUrl: 'https://mail.example.com',
  },
  AuthenticationError: class AuthenticationError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));

vi.mock('../../lib/push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
  forgetPushServerState: vi.fn(async () => undefined),
  forgetPushSubscriptionExpiry: vi.fn(async () => undefined),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { forgetPushSubscriptionExpiry } from '../../lib/push-notifications';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';
import { useEmailStore } from '../email-store';
import { useOfflineCacheStore } from '../offline-cache-store';
import { useOutboxStore } from '../outbox-store';
import { readServerFingerprint, sessionFingerprint, writeServerFingerprint } from '../../lib/server-fingerprint';
import type { JMAPSession } from '../../api/types';

const ACCOUNT = 'user@mail.example.com';
const session = (version: string) => client.session(version) as unknown as JMAPSession;
const OUTBOX_KEY = `webmail:outbox:v1:${ACCOUNT}`;
// An edit made offline in the last session: mark message "b" read.
const QUEUED = [{ id: 'q1', createdAt: 1, attempts: 0, op: { kind: 'keywords', emailId: 'b', patch: { $seen: true } } }];

const emailSets = () => client.requests.flat().filter(([name]) => name === 'Email/set');

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await AsyncStorage.clear();
  client.requests.length = 0;
  // A cold start: nothing is attached yet.
  await useOutboxStore.getState().setAccount(null);
  await useOfflineCacheStore.getState().setAccount(null);
  useAccountStore.setState({
    accounts: [{
      id: ACCOUNT, serverUrl: 'https://mail.example.com', username: 'user', displayName: 'user', email: 'user',
      avatarColor: '#000', lastLoginAt: 0, isConnected: false, hasError: false, isDefault: true,
    }],
    activeAccountId: ACCOUNT,
    defaultAccountId: ACCOUNT,
  });
  // The cached view the 0.16.23 server left, as a cold start rehydrates it.
  useEmailStore.setState({
    activeAccountId: ACCOUNT,
    accountSnapshots: {},
    mailboxes: [{ id: 'a', name: 'Inbox', role: 'inbox', totalEmails: 1, unreadEmails: 0, totalThreads: 1, unreadThreads: 0, myRights: {} as never }],
    mailboxState: 's1iaq',
    emailStates: { a: 's1iaq' },
    currentMailboxId: 'a',
    mailboxSnapshots: { a: { emails: [{ id: 'b' } as never], total: 1, queryState: 's1iaq' } },
    emails: [{ id: 'b' } as never],
    totalEmails: 1,
    queryState: 's1iaq',
  });
  useAuthStore.setState({ isAuthenticated: false, session: null, activeAccountId: null, client: null });
});

describe('restoring the session on a replaced server', () => {
  it('drops the persisted 0.16.23 states before anything is sent to Stalwart 1.0', async () => {
    await writeServerFingerprint(ACCOUNT, sessionFingerprint(session('0.16.23')));
    await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(QUEUED));

    expect(await useAuthStore.getState().restoreSession()).toBe(true);
    // Let the fire-and-forget refetch run.
    await new Promise((r) => setTimeout(r, 20));

    const sent = client.requests.flat();
    expect(sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(sent)).not.toContain('s1iaq');
    expect(sent.some(([name]) => name === 'Mailbox/changes')).toBe(false);
    expect(await readServerFingerprint(ACCOUNT)).toBe(sessionFingerprint(session('1.0')));
    // "b" is another message on the new server: the edit never goes out.
    expect(emailSets()).toEqual([]);
    expect(useOutboxStore.getState().activeAccountId).toBe(ACCOUNT);
    expect(useOutboxStore.getState().entries).toEqual([]);
    expect(await AsyncStorage.getItem(OUTBOX_KEY)).toBeNull();
  });

  it('keeps the cached view and syncs from it when the server is the same (Stalwart 1.0)', async () => {
    await writeServerFingerprint(ACCOUNT, sessionFingerprint(session('1.0')));

    expect(await useAuthStore.getState().restoreSession()).toBe(true);
    await new Promise((r) => setTimeout(r, 20));

    const changes = client.requests.flat().filter(([name]) => name === 'Mailbox/changes');
    expect(changes.map(([, args]) => args.sinceState)).toEqual(['s1iaq']);
  });

  it('loads the outbox of the restored account and sends it when the server is the same (Stalwart 1.0)', async () => {
    // The persisted view already shows the account, so the email store has
    // no switch to make; the outbox and the offline cache attach anyway.
    await writeServerFingerprint(ACCOUNT, sessionFingerprint(session('1.0')));
    await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(QUEUED));

    expect(await useAuthStore.getState().restoreSession()).toBe(true);
    await new Promise((r) => setTimeout(r, 20));

    expect(emailSets().map(([, args]) => args)).toEqual([
      { accountId: 'f', update: { b: { 'keywords/$seen': true } } },
    ]);
    expect(useOutboxStore.getState().entries).toEqual([]);
    expect(JSON.parse((await AsyncStorage.getItem(OUTBOX_KEY))!)).toEqual([]);
    expect(useOfflineCacheStore.getState().activeAccountId).toBe(ACCOUNT);
  });

  it('keeps the outbox of a restored account the server cannot be reached for (Stalwart 0.16.23)', async () => {
    await writeServerFingerprint(ACCOUNT, sessionFingerprint(session('0.16.23')));
    await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(QUEUED));
    const { jmapClient, NetworkError } = await import('../../api/jmap-client');
    vi.mocked(jmapClient.loadAccount).mockRejectedValueOnce(new NetworkError('offline'));

    expect(await useAuthStore.getState().restoreSession()).toBe(true);
    await new Promise((r) => setTimeout(r, 20));

    // No session, no check: nothing is dropped and nothing is sent.
    expect(emailSets()).toEqual([]);
    expect(useOutboxStore.getState().entries.map((e) => e.op.emailId)).toEqual(['b']);
    expect(await AsyncStorage.getItem(OUTBOX_KEY)).not.toBeNull();
  });

  it('sends none of the queue the build before left, the first time this one sees the server (Stalwart 1.0)', async () => {
    // No fingerprint: the released build never recorded one, and the server
    // may have been replaced before this one ran. "b" can be another message.
    await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(QUEUED));

    expect(await useAuthStore.getState().restoreSession()).toBe(true);
    await new Promise((r) => setTimeout(r, 20));

    expect(emailSets()).toEqual([]);
    expect(useOutboxStore.getState().entries).toEqual([]);
    expect(await AsyncStorage.getItem(OUTBOX_KEY)).toBeNull();
    expect(forgetPushSubscriptionExpiry).toHaveBeenCalledWith(ACCOUNT);
    expect(await readServerFingerprint(ACCOUNT)).toBe(sessionFingerprint(session('1.0')));
  });
});
