import { describe, it, expect, vi, beforeEach } from 'vitest';

// The offline sync reads through the JMAP client and writes into the cache's
// loaded bucket. An account switch moves the cache first and the client after
// it, so a sync running across one must stop instead of filing one account's
// mail under the other.

const { client } = vi.hoisted(() => ({
  client: {
    // The local account (username@host) the client serves.
    served: 'usera@mail.example.org' as string | null,
    fetchGate: Promise.resolve() as Promise<unknown>,
  },
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    get isConnected() { return client.served !== null; },
    get username() { return client.served ? client.served.split('@')[0] : null; },
    get serverUrl() { return client.served ? 'https://mail.example.org' : null; },
    getSharedMailAccounts: () => [],
    getMaxObjectsInGet: () => 500,
  },
}));

const queryEmailsByFilter = vi.fn(async (..._args: unknown[]) => ['m1', 'm2']);
const getFullEmails = vi.fn(async (ids: string[]) => {
  await client.fetchGate;
  return ids.map((id) => ({ id, receivedAt: '2026-09-20T10:00:00Z', mailboxIds: { a: true }, keywords: {} }));
});
vi.mock('../../api/email', () => ({
  queryEmailsByFilter: (...args: unknown[]) => queryEmailsByFilter(...args),
  getFullEmails: (ids: string[]) => getFullEmails(ids),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { runOfflineSync } from '../offline-sync';
import { useOfflineCacheStore } from '../../stores/offline-cache-store';

const A = 'usera@mail.example.org';
const B = 'userb@mail.example.org';
const entryKeys = async (account: string) =>
  ((await AsyncStorage.getAllKeys()) as string[]).filter((k) => k.startsWith(`webmail:offline-cache:entry:v2:${account}:`));

beforeEach(async () => {
  vi.clearAllMocks();
  await AsyncStorage.clear();
  client.served = A;
  client.fetchGate = Promise.resolve();
  await useOfflineCacheStore.getState().setAccount(null);
  await useOfflineCacheStore.getState().setAccount(A);
});

describe('runOfflineSync', () => {
  it('caches the bodies of the account it runs for', async () => {
    await runOfflineSync({ days: 30 });

    expect(useOfflineCacheStore.getState().totalCount()).toBe(2);
    expect(await entryKeys(A)).toHaveLength(2);
    expect(useOfflineCacheStore.getState().sync.phase).toBe('done');
  });

  it('stops without writing anywhere when the account is switched while bodies download', async () => {
    let open!: () => void;
    client.fetchGate = new Promise<void>((resolve) => { open = resolve; });

    const syncing = runOfflineSync({ days: 30 });
    await vi.waitFor(() => expect(getFullEmails).toHaveBeenCalled());
    // switchAccount: the stores move to B, then loadAccount() gets B's session.
    await useOfflineCacheStore.getState().setAccount(B);
    client.served = B;
    open();
    await syncing;

    expect(await entryKeys(A)).toEqual([]);
    expect(await entryKeys(B)).toEqual([]);
    expect(useOfflineCacheStore.getState().totalCount()).toBe(0);
    // B's progress is B's own: nothing from A's run shows up there.
    expect(useOfflineCacheStore.getState().sync.phase).toBe('idle');
  });

  it('does not start while the client still serves the account being left', async () => {
    await useOfflineCacheStore.getState().setAccount(B);

    await runOfflineSync({ days: 30 });

    expect(queryEmailsByFilter).not.toHaveBeenCalled();
    expect(await entryKeys(B)).toEqual([]);
  });
});
