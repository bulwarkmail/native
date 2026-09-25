import { describe, it, expect, beforeEach } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useOfflineCacheStore } from '../offline-cache-store';

const ACCOUNT = 'acc-1';

beforeEach(async () => {
  await useOfflineCacheStore.getState().setAccount(null);
  await useOfflineCacheStore.getState().setAccount(ACCOUNT);
  await useOfflineCacheStore.getState().clearAll();
});

describe('offline cache patch', () => {
  it('applies a keyword patch to the cached copy instead of replacing its keywords', async () => {
    const cache = useOfflineCacheStore.getState();
    await cache.put({
      id: 'e1',
      receivedAt: '2026-01-01T00:00:00Z',
      keywords: { $flagged: true, '$label:work': true },
      mailboxIds: { inbox: true },
    } as any, 100);

    await useOfflineCacheStore.getState().patch('e1', { keywords: { $seen: true, $flagged: null } });

    const cached = await useOfflineCacheStore.getState().get('e1');
    expect(cached?.keywords).toEqual({ '$label:work': true, $seen: true });
    expect(cached?.mailboxIds).toEqual({ inbox: true });
  });

  it('replaces mailboxIds wholesale', async () => {
    await useOfflineCacheStore.getState().put({
      id: 'e1', receivedAt: '2026-01-01T00:00:00Z', keywords: { $seen: true }, mailboxIds: { inbox: true },
    } as any, 100);

    await useOfflineCacheStore.getState().patch('e1', { mailboxIds: { trash: true } });

    const cached = await useOfflineCacheStore.getState().get('e1');
    expect(cached?.mailboxIds).toEqual({ trash: true });
    expect(cached?.keywords).toEqual({ $seen: true });
  });
});

describe('buckets that change under a write or a read', () => {
  const OTHER = 'acc-2';
  const body = (id: string) => ({ id, receivedAt: '2026-01-01T00:00:00Z', keywords: {}, mailboxIds: { inbox: true } } as any);
  const entryKey = (account: string, id: string) => `webmail:offline-cache:entry:v2:${account}:${id}`;
  const indexKey = (account: string) => `webmail:offline-cache:index:v2:${account}`;

  beforeEach(async () => {
    await AsyncStorage.removeItem(indexKey(OTHER));
    await AsyncStorage.removeItem(entryKey(OTHER, 'e1'));
  });

  it('drops a put made for an account whose bucket is no longer loaded', async () => {
    await useOfflineCacheStore.getState().setAccount(OTHER);

    await useOfflineCacheStore.getState().put(body('e1'), 100, undefined, ACCOUNT);

    expect(useOfflineCacheStore.getState().totalCount()).toBe(0);
    expect(await AsyncStorage.getItem(entryKey(OTHER, 'e1'))).toBeNull();
    expect(await AsyncStorage.getItem(entryKey(ACCOUNT, 'e1'))).toBeNull();
  });

  it('keeps a bucket cleared while its index was still loading cleared', async () => {
    // The server check drops the cache of a replaced server while the cold
    // start is still reading its index.
    await AsyncStorage.setItem(entryKey(OTHER, 'e1'), JSON.stringify(body('e1')));
    await AsyncStorage.setItem(indexKey(OTHER), JSON.stringify({
      entries: { e1: { id: 'e1', receivedAt: '2026-01-01T00:00:00Z', size: 100, cachedAt: 1 } },
    }));

    const attaching = useOfflineCacheStore.getState().setAccount(OTHER);
    await useOfflineCacheStore.getState().clearAccount(OTHER);
    await attaching;

    expect(useOfflineCacheStore.getState().totalCount()).toBe(0);
    expect(useOfflineCacheStore.getState().hydrated).toBe(true);
    expect(await AsyncStorage.getItem(entryKey(OTHER, 'e1'))).toBeNull();
    expect(await AsyncStorage.getItem(indexKey(OTHER))).toBeNull();
  });

  it('does not index a body a put was still writing when the bucket was cleared', async () => {
    await useOfflineCacheStore.getState().setAccount(OTHER);

    const putting = useOfflineCacheStore.getState().put(body('e1'), 100);
    await useOfflineCacheStore.getState().clearAccount(OTHER);
    await putting;

    expect(useOfflineCacheStore.getState().totalCount()).toBe(0);
    expect(await useOfflineCacheStore.getState().get('e1')).toBeNull();
    expect(await AsyncStorage.getItem(indexKey(OTHER))).toBeNull();
  });
});
