import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A sign-out waits for the device cleanup only so long; the rest goes on in
// the background. Signing the same account straight back in reuses its app
// account id, so that cleanup must stop before it forgets the live account's
// data. The real cleanup runs here, against the real stores.

vi.mock('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: () => () => undefined,
    fetch: async () => ({ isConnected: true, isInternetReachable: true }),
  },
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    connect: vi.fn(),
    logout: vi.fn(),
    loadAccount: vi.fn(),
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
    isConnected: true,
    currentSession: { apiUrl: 'https://mail.example.com/jmap/' },
    username: 'user',
    serverUrl: 'https://mail.example.com',
  },
  AuthenticationError: class AuthenticationError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));

vi.mock('../../lib/push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
  clearStoredRelayBaseUrl: vi.fn(async () => undefined),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { jmapClient } from '../../api/jmap-client';
import { useAuthStore, EVICTION_CLEANUP_TIMEOUT_MS, resetCleanupMemoryForTests } from '../auth-store';
import { readForgetPending, markForgetPending, FORGET_PENDING_KEY, SHARED_CLEANUP } from '../forget-pending';
import { clearStoredRelayBaseUrl } from '../../lib/push-notifications';
import { useAccountStore } from '../account-store';
import { useSettingsStore, discardSettingsEditsForTests } from '../settings-store';
import { readsLegacyCalendarColors } from '../../lib/calendar-color-keys';
import { useOfflineCacheStore } from '../offline-cache-store';
import { useSendQueueStore, type QueuedSend } from '../send-queue-store';
import { useCalendarSubscriptionsStore, subscriptionOwner } from '../calendar-subscriptions-store';
import { useSearchHistoryStore } from '../search-history-store';
import { generateAccountId } from '../../lib/account-utils';
import { IDENTITY_CACHE_PREFIX } from '../../lib/identity-cache';
import { AccountLimitError } from '../../lib/account-utils';
import { AuthenticationError, NetworkError } from '../../api/jmap-client';

const SERVER = 'https://mail.example.com';
const USER = 'me@mail.example.com';
const ID = generateAccountId(USER, SERVER);
const OWNER = subscriptionOwner(SERVER, USER);

function queued(): Omit<QueuedSend, 'messageId'> {
  return {
    id: 'q1', appAccountId: ID, jmapAccountId: 'acc-1', identityId: 'i1',
    outgoing: { from: [{ email: USER }], to: [{ email: 'you@x.test' }], subject: 's', textBody: 'hi', messageId: 'mid-1@x.test' },
    createdAt: '2026-10-09T08:00:00.000Z', state: 'queued',
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  vi.clearAllMocks();
  // No cleanup of an earlier case still tracked.
  resetCleanupMemoryForTests();
  await useSendQueueStore.getState().clearAccount(ID);
  await AsyncStorage.clear();
  useCalendarSubscriptionsStore.setState({ subscriptions: [] });
  useSearchHistoryStore.setState({ recentSearches: [] });
  useAccountStore.setState({
    accounts: [{
      id: ID, serverUrl: SERVER, username: USER, displayName: USER, email: USER, avatarColor: '#000',
      lastLoginAt: 0, isConnected: true, hasError: false, isDefault: true,
    }],
    activeAccountId: ID,
    defaultAccountId: ID,
  });
  useAuthStore.setState({ isAuthenticated: true, activeAccountId: ID, serverUrl: SERVER, username: USER });
  (jmapClient.connect as ReturnType<typeof vi.fn>).mockResolvedValue({ apiUrl: `${SERVER}/jmap/` });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  warn.mockRestore();
  vi.restoreAllMocks();
});

describe('a sign-out cleanup still running when the account signs in again', () => {
  it('never forgets the re-signed-in account\'s queued send, identities, subscriptions or search history', async () => {
    // The first cleanup step (the offline cache) hangs.
    let release!: () => void;
    const hung = new Promise<void>((r) => { release = r; });
    vi.spyOn(useOfflineCacheStore.getState(), 'clearAccount').mockImplementation(() => hung);

    const signedOut = useAuthStore.getState().logout();
    await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
    await signedOut;
    expect(useAccountStore.getState().accounts).toEqual([]);

    // Straight back in: the same app account id.
    const signedIn = useAuthStore.getState().login(SERVER, USER, 'pw');
    await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
    await signedIn;
    expect(useAuthStore.getState().activeAccountId).toBe(ID);

    // The new session's data.
    await useSendQueueStore.getState().hydrateAccount(ID);
    await useSendQueueStore.getState().enqueue(queued());
    await AsyncStorage.setItem(`${IDENTITY_CACHE_PREFIX}${ID}`, '[{"id":"i1"}]');
    useCalendarSubscriptionsStore.setState({
      subscriptions: [{ id: 's1', owner: OWNER, name: 's1', url: 'https://x/secret.ics', color: '#000', enabled: true } as never],
    });
    useSearchHistoryStore.setState({ recentSearches: ['invoice'] });

    // The hung step ends, and every step bound runs out.
    release();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await AsyncStorage.getItem(`webmail:sendqueue:v1:${ID}:q1`)).not.toBeNull();
    expect(useSendQueueStore.getState().entries[ID]?.map((e) => e.id)).toEqual(['q1']);
    expect(await AsyncStorage.getItem(`${IDENTITY_CACHE_PREFIX}${ID}`)).not.toBeNull();
    expect(useCalendarSubscriptionsStore.getState().subscriptions.map((s) => s.id)).toEqual(['s1']);
    expect(useSearchHistoryStore.getState().recentSearches).toEqual(['invoice']);
  });

  describe('a sign-in of it that fails', () => {
    const secret = () => ({ id: 's1', owner: OWNER, name: 's1', url: 'https://x/secret.ics', color: '#000', enabled: true } as never);
    // What the signed-out account left behind, the queued send the user chose to discard among it.
    async function leftBehind() {
      await AsyncStorage.setItem(`${IDENTITY_CACHE_PREFIX}${ID}`, '[{"id":"i1"}]');
      await AsyncStorage.setItem(`webmail:sendqueue:v1:${ID}:q1`, JSON.stringify({ ...queued(), messageId: 'mid-1@x.test' }));
      useCalendarSubscriptionsStore.setState({ subscriptions: [secret()] });
      useSearchHistoryStore.setState({ recentSearches: ['invoice'] });
    }
    async function expectAllForgotten() {
      expect(await AsyncStorage.getItem(`${IDENTITY_CACHE_PREFIX}${ID}`)).toBeNull();
      expect(await AsyncStorage.getItem(`webmail:sendqueue:v1:${ID}:q1`)).toBeNull();
      expect(useCalendarSubscriptionsStore.getState().subscriptions).toEqual([]);
      expect(useSearchHistoryStore.getState().recentSearches).toEqual([]);
    }
    function hangFirstStep(): () => void {
      let release!: () => void;
      const hung = new Promise<void>((r) => { release = r; });
      vi.spyOn(useOfflineCacheStore.getState(), 'clearAccount').mockImplementationOnce(() => hung);
      return release;
    }

    it('lets the cleanup go on when the password is refused', async () => {
      await leftBehind();
      const release = hangFirstStep();
      const signedOut = useAuthStore.getState().logout({ discardQueuedSends: true });
      await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
      await signedOut;

      (jmapClient.connect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new AuthenticationError('bad password'));
      const signIn = useAuthStore.getState().login(SERVER, USER, 'wrong').catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
      expect(await signIn).toBeInstanceOf(AuthenticationError);
      expect(useAccountStore.getState().accounts).toEqual([]);

      release();
      await vi.advanceTimersByTimeAsync(60_000);
      await expectAllForgotten();
    });

    it('runs the skipped cleanup again when the registry refuses the account', async () => {
      await leftBehind();
      const release = hangFirstStep();
      const signedOut = useAuthStore.getState().logout({ discardQueuedSends: true });
      await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
      await signedOut;

      vi.spyOn(useAccountStore.getState(), 'addAccount').mockImplementationOnce(() => { throw new AccountLimitError(); });
      const signIn = useAuthStore.getState().login(SERVER, USER, 'pw').catch((e: unknown) => e);
      // The hung step ends while the sign-in holds the cleanup: every later step is skipped for it.
      release();
      await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
      expect(await signIn).toBeInstanceOf(AccountLimitError);
      expect(useAccountStore.getState().accounts).toEqual([]);

      await vi.advanceTimersByTimeAsync(60_000);
      await expectAllForgotten();
    });

    it('does not run it again when the sign-in succeeded', async () => {
      const release = hangFirstStep();
      const signedOut = useAuthStore.getState().logout({ discardQueuedSends: true });
      await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
      await signedOut;

      const signIn = useAuthStore.getState().login(SERVER, USER, 'pw');
      release();
      await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
      await signIn;
      await leftBehind();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await AsyncStorage.getItem(`${IDENTITY_CACHE_PREFIX}${ID}`)).not.toBeNull();
      expect(await AsyncStorage.getItem(`webmail:sendqueue:v1:${ID}:q1`)).not.toBeNull();
      expect(useCalendarSubscriptionsStore.getState().subscriptions).toHaveLength(1);
      expect(useSearchHistoryStore.getState().recentSearches).toEqual(['invoice']);
    });

    it('finishes a cleanup the app was killed in, at the next cold start', async () => {
      await leftBehind();
      hangFirstStep();
      const out = useAuthStore.getState().logout({ discardQueuedSends: true });
      await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
      await out;
      expect(await readForgetPending()).toContainEqual(expect.objectContaining({ key: ID, kind: 'signOut', discardQueuedSends: true }));

      resetCleanupMemoryForTests(); // the kill: memory gone, storage kept
      await useAuthStore.getState().restoreSession();
      // Well before the hung step's own bound: the resumed cleanup did it.
      await vi.advanceTimersByTimeAsync(1000);
      await expectAllForgotten();
      await vi.advanceTimersByTimeAsync(60_000);
      await expectAllForgotten();
      expect(await readForgetPending()).toEqual([]);
    });

    it('drops the marker of an account signed back in before the kill, and forgets nothing', async () => {
      await markForgetPending({ key: ID, kind: 'signOut', withShared: true }); // ID is registered (beforeEach)
      await markForgetPending({ key: SHARED_CLEANUP, kind: 'shared' });
      await leftBehind();
      resetCleanupMemoryForTests();
      // Offline: the account stays signed in, its credentials kept.
      (jmapClient.loadAccount as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new NetworkError('offline'));
      await useAuthStore.getState().restoreSession();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(useAccountStore.getState().accounts.map((a) => a.id)).toEqual([ID]);
      expect(await AsyncStorage.getItem(`${IDENTITY_CACHE_PREFIX}${ID}`)).not.toBeNull();
      expect(await AsyncStorage.getItem(`webmail:sendqueue:v1:${ID}:q1`)).not.toBeNull();
      expect(useCalendarSubscriptionsStore.getState().subscriptions).toHaveLength(1);
      expect(useSearchHistoryStore.getState().recentSearches).toEqual(['invoice']);
      expect(await readForgetPending()).toEqual([]);
    });

    it('finishes an eviction the app was killed in, relay included', async () => {
      useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
      await markForgetPending({ key: ID, kind: 'evict', serverUrl: SERVER, username: USER });
      await leftBehind();
      await useAuthStore.getState().restoreSession();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(clearStoredRelayBaseUrl).toHaveBeenCalledWith(ID);
      expect(await AsyncStorage.getItem(`${IDENTITY_CACHE_PREFIX}${ID}`)).toBeNull();
      // An eviction keeps the queued sends, as a sign-out does unless asked.
      expect(await AsyncStorage.getItem(`webmail:sendqueue:v1:${ID}:q1`)).not.toBeNull();
      expect(useCalendarSubscriptionsStore.getState().subscriptions).toEqual([]);
      expect(useSearchHistoryStore.getState().recentSearches).toEqual([]);
      expect(await readForgetPending()).toEqual([]);
    });

    describe('when the account registry could not be read', () => {
      const REGISTRY = 'account-registry';
      afterEach(async () => {
        // A read that works again, for the cases after these.
        await AsyncStorage.setItem(REGISTRY, JSON.stringify({ state: { accounts: [], activeAccountId: null, defaultAccountId: null }, version: 0 }));
        await useAccountStore.persist.rehydrate();
      });
      // A cold start whose registry read fails starts with no accounts, though the account is live.
      async function coldStartWithRegistry(spoil: () => Promise<void>) {
        useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
        await spoil();
        await useAccountStore.persist.rehydrate();
        expect(useAccountStore.persist.hasHydrated()).toBe(true);
        expect(useAccountStore.getState().accounts).toEqual([]);
      }
      const spoilers: Array<[string, () => Promise<void>]> = [
        ['a rejected read', async () => { vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('CursorWindow')); }],
        ['corrupt JSON', () => AsyncStorage.setItem(REGISTRY, '{corrupt')],
        ['a row with no account list', () => AsyncStorage.setItem(REGISTRY, JSON.stringify({ state: { activeAccountId: ID }, version: 0 }))],
        ['a row with an account that has no id', () => AsyncStorage.setItem(REGISTRY, JSON.stringify({ state: { accounts: [{ username: USER }], activeAccountId: ID }, version: 0 }))],
      ];

      it.each(spoilers)('keeps every marker and forgets nothing after %s', async (_, spoil) => {
        await markForgetPending({ key: ID, kind: 'signOut', discardQueuedSends: true, withShared: true });
        await leftBehind();
        await coldStartWithRegistry(spoil);
        await useAuthStore.getState().restoreSession();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await AsyncStorage.getItem(`webmail:sendqueue:v1:${ID}:q1`)).not.toBeNull();
        expect(await AsyncStorage.getItem(`${IDENTITY_CACHE_PREFIX}${ID}`)).not.toBeNull();
        expect(useCalendarSubscriptionsStore.getState().subscriptions).toHaveLength(1);
        expect(useSearchHistoryStore.getState().recentSearches).toEqual(['invoice']);
        expect(await readForgetPending()).toEqual([expect.objectContaining({ key: ID, kind: 'signOut' })]);
      });

      it.each(spoilers)('sweeps no offline mail after %s', async (_, spoil) => {
        const index = `webmail:offline-cache:index:v2:${ID}`;
        await AsyncStorage.setItem(index, '{"entries":{}}');
        await coldStartWithRegistry(spoil);
        (jmapClient.loadAccount as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new NetworkError('offline'));
        await useAuthStore.getState().restoreSession();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await AsyncStorage.getItem(index)).not.toBeNull();
      });

      // The migration writes a one-account registry: never over a stored
      // one that could not be read. The old credentials wait for a start
      // that reads it.
      it.each(spoilers)('migrates no single-slot account after %s', async (_, spoil) => {
        await coldStartWithRegistry(spoil);
        (jmapClient.consumeLegacyCredentials as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ serverUrl: SERVER, username: 'legacy@mail.example.com' });
        await useAuthStore.getState().restoreSession();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(jmapClient.consumeLegacyCredentials).not.toHaveBeenCalled();
        expect(useAccountStore.getState().accounts).toEqual([]);
        // The old slot is still there for a later start, not for the next case.
        vi.mocked(jmapClient.consumeLegacyCredentials).mockReset().mockResolvedValue(null);
      });
    });

    it('forgets the shared data after a kill while signing every account out', async () => {
      await leftBehind();
      hangFirstStep();
      const out = useAuthStore.getState().logoutAll({ discardQueuedSends: true });
      await vi.advanceTimersByTimeAsync(1000);
      // Still on the first account's bound.
      expect((await readForgetPending()).map((e) => e.key).sort()).toEqual([ID, SHARED_CLEANUP].sort());

      resetCleanupMemoryForTests(); // the kill
      await useAuthStore.getState().restoreSession();
      await vi.advanceTimersByTimeAsync(1000);
      await expectAllForgotten();
      await vi.advanceTimersByTimeAsync(60_000);
      await out;
      expect(await readForgetPending()).toEqual([]);
    });

    it('leaves the markers alone when the account registry has not loaded', async () => {
      useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
      vi.spyOn(useAccountStore.persist, 'hasHydrated').mockReturnValue(false);
      await markForgetPending({ key: ID, kind: 'signOut', withShared: true });
      await leftBehind();
      const restored = useAuthStore.getState().restoreSession();
      // The registry's own bounded wait.
      await vi.advanceTimersByTimeAsync(60_000);
      await restored;
      expect(await AsyncStorage.getItem(`${IDENTITY_CACHE_PREFIX}${ID}`)).not.toBeNull();
      expect(useSearchHistoryStore.getState().recentSearches).toEqual(['invoice']);
      expect(await readForgetPending()).toHaveLength(1);
    });

    it('starts the cleanup at once even when its marker cannot be written', async () => {
      await leftBehind();
      const setItem = AsyncStorage.setItem as ReturnType<typeof vi.fn>;
      const write = setItem.getMockImplementation() as (key: string, value: string) => Promise<void>;
      let unhang!: () => void;
      setItem.mockImplementation((key: string, value: string) => (
        key === FORGET_PENDING_KEY ? new Promise<void>((r) => { unhang = r; }) : write(key, value)
      ));
      const out = useAuthStore.getState().logout({ discardQueuedSends: true });
      await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
      await out;
      await expectAllForgotten();
      // Let the marker writes behind it through, for the cases after this one.
      setItem.mockImplementation(write);
      unhang();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await readForgetPending()).toEqual([]);
    });

    // Two sign-ins of the account overlap the hung cleanup: the first holds
    // it, the step ends while it does, and the second starts before the first
    // has settled. The second must hold the cleanup too.
    async function overlappingSignIns(secondFails: boolean) {
      await leftBehind();
      const release = hangFirstStep();
      const signedOut = useAuthStore.getState().logout({ discardQueuedSends: true });
      await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
      await signedOut;

      let connectFirst!: () => void;
      let connectSecond!: (ok: boolean) => void;
      const session = { apiUrl: `${SERVER}/jmap/` };
      (jmapClient.connect as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => new Promise((resolve) => { connectFirst = () => resolve(session); }))
        .mockImplementationOnce(() => new Promise((resolve, reject) => {
          connectSecond = (ok) => (ok ? resolve(session) : reject(new AuthenticationError('bad password')));
        }));
      vi.spyOn(useAccountStore.getState(), 'addAccount').mockImplementationOnce(() => { throw new AccountLimitError(); });

      const first = useAuthStore.getState().login(SERVER, USER, 'pw').catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);
      release(); // ends while the first sign-in holds the cleanup
      await vi.advanceTimersByTimeAsync(1000);
      const second = useAuthStore.getState().login(SERVER, USER, 'pw').catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);
      connectFirst();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await first).toBeInstanceOf(AccountLimitError);
      expect((await readForgetPending()).map((e) => e.key)).toContain(ID);
      // The second sign-in is still under way: nothing of the account is forgotten.
      expect(await AsyncStorage.getItem(`${IDENTITY_CACHE_PREFIX}${ID}`)).not.toBeNull();
      expect(await AsyncStorage.getItem(`webmail:sendqueue:v1:${ID}:q1`)).not.toBeNull();
      expect(useSearchHistoryStore.getState().recentSearches).toEqual(['invoice']);

      connectSecond(!secondFails);
      await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
      return second;
    }

    it('never runs the cleanup between two overlapping sign-ins of the account', async () => {
      expect(await overlappingSignIns(false)).toBeUndefined();
      expect(useAuthStore.getState().activeAccountId).toBe(ID);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await AsyncStorage.getItem(`${IDENTITY_CACHE_PREFIX}${ID}`)).not.toBeNull();
      expect(await AsyncStorage.getItem(`webmail:sendqueue:v1:${ID}:q1`)).not.toBeNull();
      expect(useSearchHistoryStore.getState().recentSearches).toEqual(['invoice']);
      expect(await readForgetPending()).toEqual([]);
    });

    it('runs it once afterwards when both overlapping sign-ins fail', async () => {
      expect(await overlappingSignIns(true)).toBeInstanceOf(AuthenticationError);
      expect(useAccountStore.getState().accounts).toEqual([]);
      await vi.advanceTimersByTimeAsync(60_000);
      await expectAllForgotten();
      // The first run, then the one re-run.
      expect(useOfflineCacheStore.getState().clearAccount).toHaveBeenCalledTimes(2);
      expect(await readForgetPending()).toEqual([]);
    });
  });

  it('leaves no shared cleanup parked after signing out one of two accounts', async () => {
    const OTHER = 'other@mail.example.com';
    const OTHER_ID = generateAccountId(OTHER, SERVER);
    const { accounts } = useAccountStore.getState();
    useAccountStore.setState({ accounts: [...accounts, { ...accounts[0], id: OTHER_ID, username: OTHER, email: OTHER, isDefault: false }] });
    useSearchHistoryStore.setState({ recentSearches: ['invoice'] });
    (jmapClient.loadAccount as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const signedOut = useAuthStore.getState().logout();
    await vi.advanceTimersByTimeAsync(60_000);
    await signedOut;
    expect(useAccountStore.getState().accounts.map((a) => a.id)).toEqual([OTHER_ID]);
    expect((await readForgetPending()).map((e) => e.key)).toEqual([]);
    expect(useSearchHistoryStore.getState().recentSearches).toEqual(['invoice']); // the other account's
  });

  // The last account's shared step, reached while another account is
  // briefly registered, is skipped; once that account is gone again and its
  // sign-in ends, the skip must not leave the search history behind.
  it('forgets the shared data once a brief registration of another account is undone', async () => {
    const OTHER = 'other@mail.example.com';
    const OTHER_ID = generateAccountId(OTHER, SERVER);
    useSearchHistoryStore.setState({ recentSearches: ['invoice'] });
    useCalendarSubscriptionsStore.setState({
      subscriptions: [{ id: 's0', owner: 'nobody', name: 's0', url: 'https://x/ownerless.ics', color: '#000', enabled: true } as never],
    });
    let releaseStep!: () => void;
    vi.spyOn(useOfflineCacheStore.getState(), 'clearAccount')
      .mockImplementationOnce(() => new Promise<void>((r) => { releaseStep = r; }));
    const signedOut = useAuthStore.getState().logout();
    await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
    await signedOut;
    expect(useAccountStore.getState().accounts).toEqual([]);

    // Another account's sign-in: nothing of its own to hold.
    let refuse!: (e: unknown) => void;
    (jmapClient.connect as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((_, reject) => { refuse = reject; }));
    const signIn = useAuthStore.getState().login(SERVER, OTHER, 'pw').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    // It is registered for a moment, while the signed-out account's cleanup
    // reaches its shared step.
    const { accounts } = useAccountStore.getState();
    useAccountStore.setState({ accounts: [...accounts, { ...accounts[0] ?? {}, id: OTHER_ID, serverUrl: SERVER, username: OTHER } as never] });
    releaseStep();
    await vi.advanceTimersByTimeAsync(1000);
    expect(useSearchHistoryStore.getState().recentSearches).toEqual(['invoice']);

    // Then undone, and the sign-in fails.
    useAccountStore.setState({ accounts: [] });
    refuse(new AuthenticationError('bad password'));
    await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
    expect(await signIn).toBeInstanceOf(AuthenticationError);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(useSearchHistoryStore.getState().recentSearches).toEqual([]);
    expect(useCalendarSubscriptionsStore.getState().subscriptions).toEqual([]);
  });

  // The shared step is skipped for another account's sign-in that then
  // succeeds: that account is live, so the record and its marker both go.
  it('drops the shared cleanup and its marker once the sign-in it skipped for settles', async () => {
    const OTHER = 'other@mail.example.com';
    const OTHER_ID = generateAccountId(OTHER, SERVER);
    useSearchHistoryStore.setState({ recentSearches: ['invoice'] });
    let releaseStep!: () => void;
    vi.spyOn(useOfflineCacheStore.getState(), 'clearAccount')
      .mockImplementationOnce(() => new Promise<void>((r) => { releaseStep = r; }));
    const signedOut = useAuthStore.getState().logout();
    await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
    await signedOut;

    let admit!: () => void;
    (jmapClient.connect as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((resolve) => {
      admit = () => resolve({ apiUrl: `${SERVER}/jmap/` });
    }));
    const signIn = useAuthStore.getState().login(SERVER, OTHER, 'pw');
    await vi.advanceTimersByTimeAsync(0);
    useAccountStore.setState({ accounts: [{
      id: OTHER_ID, serverUrl: SERVER, username: OTHER, displayName: OTHER, email: OTHER, avatarColor: '#000',
      lastLoginAt: 0, isConnected: true, hasError: false, isDefault: true,
    }] });
    releaseStep();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await readForgetPending()).map((e) => e.key)).toContain(SHARED_CLEANUP);

    admit();
    await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
    await signIn;
    expect(useAuthStore.getState().activeAccountId).toBe(OTHER_ID);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await readForgetPending()).toEqual([]);
    expect(useSearchHistoryStore.getState().recentSearches).toEqual(['invoice']);
  });

  // The account's own sign-in gave up waiting and released before the run
  // reached a step; the run then skips for another account's sign-in that
  // ends before it does. Nobody is left to release it, so its end decides.
  it('drops the marker of a run that ends skipped after every sign-in released it', async () => {
    const OTHER = 'other@mail.example.com';
    let releaseStep!: () => void;
    vi.spyOn(useOfflineCacheStore.getState(), 'clearAccount')
      .mockImplementationOnce(() => new Promise<void>((r) => { releaseStep = r; }));
    const signedOut = useAuthStore.getState().logout();
    await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
    await signedOut;

    let admit!: () => void;
    (jmapClient.connect as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((resolve) => {
      admit = () => resolve({ apiUrl: `${SERVER}/jmap/` });
    }));
    const other = useAuthStore.getState().login(SERVER, OTHER, 'pw', { addAccount: true }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    const own = useAuthStore.getState().login(SERVER, USER, 'pw');
    await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
    await own;
    expect(useAccountStore.getState().accounts.map((a) => a.id)).toContain(ID);

    // The run goes on (and skips) while the other sign-in ends.
    releaseStep();
    admit();
    await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
    await other;
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await readForgetPending()).map((e) => e.key)).not.toContain(ID);
  });

  it('still forgets the subscriptions when the first step hangs and nobody signs back in', async () => {
    vi.spyOn(useOfflineCacheStore.getState(), 'clearAccount').mockImplementation(() => new Promise(() => undefined));
    useCalendarSubscriptionsStore.setState({
      subscriptions: [{ id: 's1', owner: OWNER, name: 's1', url: 'https://x/secret.ics', color: '#000', enabled: true } as never],
    });
    useSearchHistoryStore.setState({ recentSearches: ['invoice'] });

    const signedOut = useAuthStore.getState().logout();
    await vi.advanceTimersByTimeAsync(60_000);
    await signedOut;

    expect(useCalendarSubscriptionsStore.getState().subscriptions).toEqual([]);
    expect(useSearchHistoryStore.getState().recentSearches).toEqual([]);
  });
});

// The old shared calendar colour keys name no app account: only the
// accounts registered at the upgrade may read them, so the list is taken
// from the stored registry, never an empty stand-in for it.
describe('the accounts that may read the old calendar colour keys', () => {
  beforeEach(async () => {
    // A failed read left by an earlier case would hold every write back.
    discardSettingsEditsForTests();
    useSettingsStore.setState({ settingsReadFailed: false, legacyCalendarColorNonReaders: [] });
    await useSettingsStore.getState().hydrate();
    useSettingsStore.getState().resetToDefaults();
    useSettingsStore.getState().setSharedCalendarColor('team|c1', '#00ff00');
    (jmapClient.loadAccount as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new NetworkError('offline'));
  });

  it('are the accounts registered at the first start after the upgrade', async () => {
    await useAuthStore.getState().restoreSession();
    expect(useSettingsStore.getState().legacyCalendarColorReaders).toEqual([ID]);
  });

  it('are not chosen, and the stored settings not rewritten, when the settings read was refused', async () => {
    const stored = JSON.stringify({ sharedCalendarColors: { 'team|c1': '#00ff00' } });
    await AsyncStorage.setItem('webmail:settings:v1', stored);
    useSettingsStore.setState({ hydrated: false, legacyCalendarColorReaders: null });
    const realGetItem = vi.mocked(AsyncStorage.getItem).getMockImplementation()!;
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) => {
      if (key === 'webmail:settings:v1') throw new Error('CursorWindow');
      return realGetItem(key);
    });
    try {
      await useAuthStore.getState().restoreSession();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(useSettingsStore.getState().legacyCalendarColorReaders).toBeNull();
      expect(await realGetItem('webmail:settings:v1')).toBe(stored);
    } finally {
      vi.mocked(AsyncStorage.getItem).mockImplementation(realGetItem);
    }
  });

  it('are none when the settings row was corrupt, which is kept aside', async () => {
    await AsyncStorage.setItem('webmail:settings:v1', '{corrupt');
    useSettingsStore.setState({ hydrated: false, legacyCalendarColorReaders: null });
    await useAuthStore.getState().restoreSession();
    await vi.advanceTimersByTimeAsync(60_000);
    // Its old colours went with it: nothing left to read.
    expect(useSettingsStore.getState().legacyCalendarColorReaders).toEqual([]);
    expect(await AsyncStorage.getItem('webmail:settings:v1:corrupt')).toBe('{corrupt');
  });

  // A start whose seed was skipped leaves the list unseeded; an account
  // signed in then is new, though the next clean start finds it registered.
  it('never include an account signed in while the list was unseeded', async () => {
    const C_USER = 'c@other.example.com';
    const C = generateAccountId(C_USER, SERVER);
    const registry = vi.spyOn(useAccountStore.persist, 'hasHydrated').mockReturnValue(false);
    const restored = useAuthStore.getState().restoreSession();
    await vi.advanceTimersByTimeAsync(60_000);
    await restored;
    expect(useSettingsStore.getState().legacyCalendarColorReaders).toBeNull();

    const signedIn = useAuthStore.getState().login(SERVER, C_USER, 'pw');
    await vi.advanceTimersByTimeAsync(60_000);
    await signedIn;
    const now = useSettingsStore.getState();
    expect(readsLegacyCalendarColors(now.legacyCalendarColorReaders, C, now.legacyCalendarColorNonReaders)).toBe(false);
    expect(readsLegacyCalendarColors(now.legacyCalendarColorReaders, ID, now.legacyCalendarColorNonReaders)).toBe(true);

    // The next cold start reads both cleanly.
    registry.mockRestore();
    expect(useAccountStore.getState().accounts.map((a) => a.id).sort()).toEqual([ID, C].sort());
    useSettingsStore.setState({ hydrated: false, legacyCalendarColorReaders: null, legacyCalendarColorNonReaders: [] });
    (jmapClient.loadAccount as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new NetworkError('offline'));
    await useAuthStore.getState().restoreSession();
    const after = useSettingsStore.getState();
    expect(after.legacyCalendarColorReaders).toEqual([ID]);
    expect(readsLegacyCalendarColors(after.legacyCalendarColorReaders, C, after.legacyCalendarColorNonReaders)).toBe(false);
  });

  it('are not chosen while the account registry has not loaded', async () => {
    vi.spyOn(useAccountStore.persist, 'hasHydrated').mockReturnValue(false);
    const restored = useAuthStore.getState().restoreSession();
    await vi.advanceTimersByTimeAsync(60_000);
    await restored;
    expect(useSettingsStore.getState().legacyCalendarColorReaders).toBeNull();
    expect(useSettingsStore.getState().sharedCalendarColors).toEqual({ 'team|c1': '#00ff00' });
  });
});
