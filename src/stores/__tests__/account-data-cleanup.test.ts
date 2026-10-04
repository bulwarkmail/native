import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: () => () => undefined,
    fetch: async () => ({ isConnected: true, isInternetReachable: true }),
  },
}));
vi.mock('../../api/jmap-client', () => ({ jmapClient: { isConnected: true } }));
// The subscriptions store reads the signed-in login from auth and the calendars from the calendar store.
vi.mock('../auth-store', () => ({ useAuthStore: { getState: () => ({ serverUrl: null, username: null }) } }));
vi.mock('../calendar-store', () => ({ useCalendarStore: { getState: () => ({ calendars: [] }) } }));
vi.mock('../../api/calendar', () => ({}));
vi.mock('../../api/blob', () => ({ uploadBytes: vi.fn() }));
vi.mock('react', () => ({ default: {} }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { forgetAccountData, forgetSharedData } from '../account-data-cleanup';
import { useOutboxStore } from '../outbox-store';
import { useOfflineCacheStore } from '../offline-cache-store';
import { useSearchHistoryStore } from '../search-history-store';
import { useCalendarSubscriptionsStore, subscriptionOwner } from '../calendar-subscriptions-store';

const A = 'a@mail.example.com';
const B = 'b@mail.example.com';

function sub(id: string, owner: string) {
  return { id, owner, name: id, url: `https://x/${id}.ics`, color: '#000', enabled: true } as any;
}

async function seed(acct: string): Promise<string[]> {
  const keys = [
    `webmail:offline-cache:index:v2:${acct}`,
    `webmail:offline-cache:entry:v2:${acct}:e1`,
    `webmail:offline-cache:entry:v2:${acct}:shared:e2`,
    `webmail:outbox:v1:${acct}`,
    `webmail:outbox:v1:${acct}:failed`,
  ];
  for (const k of keys) await AsyncStorage.setItem(k, '[]');
  return keys;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  await useOutboxStore.getState().setAccount(null);
  await useOfflineCacheStore.getState().setAccount(null);
  useSearchHistoryStore.setState({ recentSearches: [] });
  useCalendarSubscriptionsStore.setState({ subscriptions: [] });
});

describe('forgetAccountData', () => {
  it('forgets only the signed-out account\'s data', async () => {
    const aKeys = await seed(A);
    const bKeys = await seed(B);
    const ownerA = subscriptionOwner('https://mail.example.com', 'a');
    const ownerB = subscriptionOwner('https://mail.example.com', 'b');
    useCalendarSubscriptionsStore.setState({ subscriptions: [sub('s1', ownerA), sub('s2', ownerB)] });
    // B is the live account; its in-memory outbox must survive A's removal.
    await useOutboxStore.getState().setAccount(B);
    useOutboxStore.setState({ entries: [{ id: 'q1' } as any] });

    await forgetAccountData({
      appAccountId: A, serverUrl: 'https://mail.example.com', username: 'a',
    });

    for (const k of aKeys) expect(await AsyncStorage.getItem(k)).toBeNull();
    for (const k of bKeys) expect(await AsyncStorage.getItem(k)).not.toBeNull();
    expect(useCalendarSubscriptionsStore.getState().subscriptions.map((s) => s.id)).toEqual(['s2']);
    expect(useOutboxStore.getState().entries).toHaveLength(1);
  });

  it('keeps queued outbox changes so they replay on the next sign-in', async () => {
    await AsyncStorage.setItem(`webmail:outbox:v1:${A}`, JSON.stringify([{ id: 'q1' }]));
    await AsyncStorage.setItem(`webmail:outbox:v1:${B}:failed`, JSON.stringify([{ id: 'f1' }]));
    await forgetAccountData({ appAccountId: A });
    await forgetAccountData({ appAccountId: B });
    expect(await AsyncStorage.getItem(`webmail:outbox:v1:${A}`)).not.toBeNull();
    expect(await AsyncStorage.getItem(`webmail:outbox:v1:${B}:failed`)).not.toBeNull();
  });

  it('keeps the active account\'s unsent in-memory changes', async () => {
    await useOutboxStore.getState().setAccount(A);
    useOutboxStore.setState({ entries: [{ id: 'q1' } as any] });
    await forgetAccountData({ appAccountId: A });
    expect(useOutboxStore.getState().entries).toHaveLength(1);
  });

  it('keeps stored changes when the active outbox has not hydrated yet', async () => {
    await AsyncStorage.setItem(`webmail:outbox:v1:${A}`, JSON.stringify([{ id: 'q1' }]));
    useOutboxStore.setState({ activeAccountId: A, entries: [], failed: [], hydrated: false });
    await forgetAccountData({ appAccountId: A });
    expect(await AsyncStorage.getItem(`webmail:outbox:v1:${A}`)).not.toBeNull();
  });

  it('does not touch an account whose id merely starts with the signed-out one', async () => {
    const other = await seed('a@mail.example.com.au');
    const mine = await seed(A);
    await forgetAccountData({ appAccountId: A });
    for (const k of mine) expect(await AsyncStorage.getItem(k)).toBeNull();
    for (const k of other) expect(await AsyncStorage.getItem(k)).not.toBeNull();
  });

  it('keeps subscriptions when the login is unknown', async () => {
    useCalendarSubscriptionsStore.setState({ subscriptions: [sub('s1', subscriptionOwner('https://mail.example.com', 'a'))] });
    await forgetAccountData({ appAccountId: A, serverUrl: 'https://mail.example.com' });
    expect(useCalendarSubscriptionsStore.getState().subscriptions).toHaveLength(1);
  });

  it('keeps the search history while another account stays signed in', async () => {
    useSearchHistoryStore.setState({ recentSearches: ['invoice'] });
    await forgetAccountData({ appAccountId: A });
    expect(useSearchHistoryStore.getState().recentSearches).toEqual(['invoice']);
  });

  it('clears the search history and every subscription when the last account signs out', async () => {
    useSearchHistoryStore.setState({ recentSearches: ['invoice', 'lunch'] });
    useCalendarSubscriptionsStore.setState({ subscriptions: [sub('s1', ''), sub('s2', 'other|x')] });
    await forgetAccountData({ appAccountId: A }, { lastAccount: true });
    expect(useSearchHistoryStore.getState().recentSearches).toEqual([]);
    expect(useCalendarSubscriptionsStore.getState().subscriptions).toEqual([]);
  });

  it('forgetSharedData clears them without an account', async () => {
    useSearchHistoryStore.setState({ recentSearches: ['x'] });
    useCalendarSubscriptionsStore.setState({ subscriptions: [sub('s1', '')] });
    await forgetSharedData();
    expect(useSearchHistoryStore.getState().recentSearches).toEqual([]);
    expect(useCalendarSubscriptionsStore.getState().subscriptions).toEqual([]);
  });
});
