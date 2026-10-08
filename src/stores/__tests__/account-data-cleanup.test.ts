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
import { signOutNeedsConfirm, countQueuedSends } from '../../lib/sign-out-guard';
import { useOutboxStore } from '../outbox-store';
import { useSendQueueStore } from '../send-queue-store';
import { useOfflineCacheStore } from '../offline-cache-store';
import { useSearchHistoryStore } from '../search-history-store';
import { useCalendarSubscriptionsStore, subscriptionOwner } from '../calendar-subscriptions-store';
import { useFolderIconsStore } from '../folder-icons-store';

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
    `webmail:identities:v1:${acct}`,
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

  it('forgets the account\'s folder icons and keeps the other account\'s', async () => {
    await useFolderIconsStore.getState().hydrate();
    useFolderIconsStore.getState().setIcon(A, 'c', 'Heart');
    useFolderIconsStore.getState().setIcon(B, 'c', 'Bell');
    await forgetAccountData({ appAccountId: A });
    expect(useFolderIconsStore.getState().icons).toEqual({ [B]: { c: 'Bell' } });
  });

  it('forgets the account\'s cached identities even when its outbox is kept', async () => {
    await AsyncStorage.setItem(`webmail:outbox:v1:${A}`, JSON.stringify([{ id: 'q1' }]));
    await AsyncStorage.setItem(`webmail:identities:v1:${A}`, '[]');
    await AsyncStorage.setItem(`webmail:identities:v1:${B}`, '[]');
    await forgetAccountData({ appAccountId: A });
    expect(await AsyncStorage.getItem(`webmail:identities:v1:${A}`)).toBeNull();
    expect(await AsyncStorage.getItem(`webmail:identities:v1:${B}`)).not.toBeNull();
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

  it('runs every later step when an earlier one fails, and logs the failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const clear = vi.spyOn(useOfflineCacheStore.getState(), 'clearAccount').mockRejectedValueOnce(new Error('disk'));
    try {
      const ownerA = subscriptionOwner('https://mail.example.com', 'a');
      useCalendarSubscriptionsStore.setState({ subscriptions: [sub('s1', ownerA)] });
      useSearchHistoryStore.setState({ recentSearches: ['invoice'] });
      await forgetAccountData(
        { appAccountId: A, serverUrl: 'https://mail.example.com', username: 'a' },
        { lastAccount: true },
      );
      expect(useCalendarSubscriptionsStore.getState().subscriptions).toEqual([]);
      expect(useSearchHistoryStore.getState().recentSearches).toEqual([]);
      expect(warn).toHaveBeenCalledWith('[sign-out] cleanup failed', expect.any(Error));
    } finally {
      clear.mockRestore();
      warn.mockRestore();
    }
  });

  it('forgetSharedData clears the search history when forgetting subscriptions fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const set = vi.spyOn(useCalendarSubscriptionsStore, 'setState').mockImplementationOnce(() => {
      throw new Error('storage');
    });
    try {
      useSearchHistoryStore.setState({ recentSearches: ['x'] });
      await forgetSharedData();
      expect(useSearchHistoryStore.getState().recentSearches).toEqual([]);
      expect(warn).toHaveBeenCalledWith('[sign-out] cleanup failed', expect.any(Error));
    } finally {
      set.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('send queue on sign-out', () => {
  const qkey = (acct: string, id: string) => `webmail:sendqueue:v1:${acct}:${id}`;

  it('keeps queued sends by default', async () => {
    await AsyncStorage.setItem(qkey(A, 'e1'), '{}');
    await forgetAccountData({ appAccountId: A });
    expect(await AsyncStorage.getItem(qkey(A, 'e1'))).not.toBeNull();
  });

  it('a kept queue leaves memory: the rows stay on disk, the Outbox and counts no longer show them', async () => {
    const row = (acct: string, id: string) => ({
      id, appAccountId: acct, jmapAccountId: 'j', identityId: 'i',
      outgoing: { from: [], to: [], subject: 's', messageId: `${id}@x` }, messageId: `${id}@x`,
      createdAt: '2026-10-04T00:00:00.000Z', state: 'queued',
    });
    await AsyncStorage.setItem(qkey(A, 'e1'), JSON.stringify(row(A, 'e1')));
    await AsyncStorage.setItem(qkey(B, 'e2'), JSON.stringify(row(B, 'e2')));
    await useSendQueueStore.getState().hydrateAccount(A);
    await useSendQueueStore.getState().hydrateAccount(B);
    expect(useSendQueueStore.getState().entries[A]).toHaveLength(1);

    await forgetAccountData({ appAccountId: A });

    expect(useSendQueueStore.getState().entries[A]).toBeUndefined();
    expect(useSendQueueStore.getState().hydrated[A]).toBeFalsy();
    expect(useSendQueueStore.getState().entries[B]).toHaveLength(1);
    expect(await AsyncStorage.getItem(qkey(A, 'e1'))).not.toBeNull();
  });

  it('with discardQueuedSends deletes only that account\'s rows; outbox keys survive', async () => {
    await AsyncStorage.setItem(qkey(A, 'e1'), '{}');
    await AsyncStorage.setItem(qkey(A, 'e2'), '{}');
    await AsyncStorage.setItem(qkey(B, 'e3'), '{}');
    await AsyncStorage.setItem(`webmail:outbox:v1:${A}`, JSON.stringify([{ id: 'q1' }]));
    await forgetAccountData({ appAccountId: A }, { discardQueuedSends: true });
    expect(await AsyncStorage.getItem(qkey(A, 'e1'))).toBeNull();
    expect(await AsyncStorage.getItem(qkey(A, 'e2'))).toBeNull();
    expect(await AsyncStorage.getItem(qkey(B, 'e3'))).not.toBeNull();
    expect(await AsyncStorage.getItem(`webmail:outbox:v1:${A}`)).not.toBeNull();
  });
});

describe('sign-out guard', () => {
  const qkey = (acct: string, id: string) => `webmail:sendqueue:v1:${acct}:${id}`;

  it('signOutNeedsConfirm is true only when something is queued', () => {
    expect(signOutNeedsConfirm([])).toBe(false);
    expect(signOutNeedsConfirm([0, 0])).toBe(false);
    expect(signOutNeedsConfirm([0, 2])).toBe(true);
  });

  it('counts persisted rows per account in every state, hydrated or not', async () => {
    const valid = (acct: string, id: string, state: string) => JSON.stringify({
      id, appAccountId: acct, jmapAccountId: 'j', identityId: 'i', outgoing: { messageId: `${id}@x` },
      messageId: `${id}@x`, createdAt: '2026-10-04T00:00:00Z', state,
    });
    await AsyncStorage.setItem(qkey(A, 'e1'), valid(A, 'e1', 'uncertain'));
    await AsyncStorage.setItem(qkey(A, 'e2'), valid(A, 'e2', 'failed'));
    await AsyncStorage.setItem(qkey(B, 'e3'), valid(B, 'e3', 'queued'));
    await AsyncStorage.setItem(`webmail:outbox:v1:${A}`, '[1]');
    expect(await countQueuedSends([A, B, 'c@x'])).toEqual([2, 1, 0]);
  });
});
