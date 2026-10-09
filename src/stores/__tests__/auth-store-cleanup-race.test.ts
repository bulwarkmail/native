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
import { useAuthStore, EVICTION_CLEANUP_TIMEOUT_MS } from '../auth-store';
import { useAccountStore } from '../account-store';
import { useOfflineCacheStore } from '../offline-cache-store';
import { useSendQueueStore, type QueuedSend } from '../send-queue-store';
import { useCalendarSubscriptionsStore, subscriptionOwner } from '../calendar-subscriptions-store';
import { useSearchHistoryStore } from '../search-history-store';
import { generateAccountId } from '../../lib/account-utils';
import { IDENTITY_CACHE_PREFIX } from '../../lib/identity-cache';

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
