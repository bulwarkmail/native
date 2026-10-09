import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  SHARED_CLEANUP,
  FORGET_PENDING_KEY,
  readForgetPending,
  markForgetPending,
  clearForgetPending,
} from '../forget-pending';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await AsyncStorage.clear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  vi.restoreAllMocks();
});

describe('the pending sign-out cleanups row', () => {
  it('keeps one entry per key, and reads a corrupt row as nothing', async () => {
    await markForgetPending({ key: 'A', kind: 'signOut', withShared: true });
    await markForgetPending({ key: 'A', kind: 'evict' });
    await markForgetPending({ key: SHARED_CLEANUP, kind: 'shared' });
    expect(await readForgetPending()).toEqual([{ key: 'A', kind: 'evict' }, { key: SHARED_CLEANUP, kind: 'shared' }]);
    await AsyncStorage.setItem(FORGET_PENDING_KEY, '{not json');
    expect(await readForgetPending()).toEqual([]);
  });

  it('loses neither of two writes made back to back', async () => {
    await Promise.all([markForgetPending({ key: 'A', kind: 'evict' }), markForgetPending({ key: 'B', kind: 'evict' }), clearForgetPending('A')]);
    expect((await readForgetPending()).map((e) => e.key)).toEqual(['B']);
  });

  it('keeps every field of an entry', async () => {
    const entry = { key: 'A', kind: 'signOut' as const, serverUrl: 'https://x', username: 'me@x', discardQueuedSends: true, withShared: false };
    await markForgetPending(entry);
    expect(await readForgetPending()).toEqual([entry]);
  });

  it('reads a row that is no list, or entries it cannot run, as nothing', async () => {
    await AsyncStorage.setItem(FORGET_PENDING_KEY, '{"key":"A","kind":"evict"}');
    expect(await readForgetPending()).toEqual([]);
    await AsyncStorage.setItem(FORGET_PENDING_KEY, JSON.stringify([
      { kind: 'evict' },
      { key: 7, kind: 'evict' },
      { key: 'A', kind: 'wipeEverything' },
      { key: 'A', kind: 'shared' },
      { key: SHARED_CLEANUP, kind: 'evict' },
      { key: 'A', kind: 'signOut' },
      null,
      { key: 'B', kind: 'evict' },
    ]));
    expect(await readForgetPending()).toEqual([{ key: 'B', kind: 'evict' }]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('never throws when storage fails to read', async () => {
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('disk'));
    expect(await readForgetPending()).toEqual([]);
  });

  it('drops the row once the last entry is cleared', async () => {
    await markForgetPending({ key: 'A', kind: 'evict' });
    await clearForgetPending('A');
    expect(await AsyncStorage.getItem(FORGET_PENDING_KEY)).toBeNull();
  });

  it('goes on writing after a write that failed', async () => {
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('full'));
    await expect(markForgetPending({ key: 'A', kind: 'evict' })).rejects.toThrow('full');
    await markForgetPending({ key: 'B', kind: 'evict' });
    expect((await readForgetPending()).map((e) => e.key)).toEqual(['B']);
  });
});
