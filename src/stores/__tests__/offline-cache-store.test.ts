import { describe, it, expect, beforeEach } from 'vitest';
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
