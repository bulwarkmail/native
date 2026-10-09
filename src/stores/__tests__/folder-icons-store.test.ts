import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
const io = { failReads: 0 };
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => {
      if (io.failReads > 0) { io.failReads -= 1; throw new Error('disk'); }
      return storage.get(k) ?? null;
    },
    setItem: async (k: string, v: string) => { storage.set(k, v); },
  },
}));

import { useFolderIconsStore, folderIconOf } from '../folder-icons-store';

const KEY = 'folderIcons:v1';
const s = () => useFolderIconsStore.getState();
const setIcon = (...a: Parameters<ReturnType<typeof s>['setIcon']>) => s().setIcon(...a);
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  storage.clear();
  io.failReads = 0;
  useFolderIconsStore.setState({ icons: {}, hydrated: false });
  await s().hydrate();
});

describe('folder icons store', () => {
  it('keys icons by app account: account B never sees account A\'s icon for the same mailbox id', () => {
    setIcon('appA', 'c', 'Heart');
    expect(folderIconOf(s(), 'appA', 'c')).toBe('Heart');
    expect(folderIconOf(s(), 'appB', 'c')).toBeUndefined();
    expect(folderIconOf(s(), null, 'c')).toBeUndefined();
  });

  it('clearing an icon removes the entry, and prune drops ids no longer listed for that account only', async () => {
    setIcon('appA', 'a', 'Star');
    setIcon('appA', 'b', 'Bell');
    setIcon('appB', 'a', 'Zap');
    setIcon('appA', 'a', null);
    expect(s().icons.appA).toEqual({ b: 'Bell' });
    s().prune('appA', ['x']); // the first prune spares icons set since the last one
    s().prune('appA', ['x']);
    expect(s().icons.appA).toBeUndefined();
    expect(s().icons.appB).toEqual({ a: 'Zap' });
    await flush();
    expect(JSON.parse(storage.get(KEY)!)).toEqual({ appB: { a: 'Zap' } });
  });

  it('forgetAccount removes only that account', async () => {
    setIcon('appA', 'a', 'Star');
    setIcon('appB', 'a', 'Zap');
    s().forgetAccount('appA');
    expect(s().icons).toEqual({ appB: { a: 'Zap' } });
    await flush();
    expect(JSON.parse(storage.get(KEY)!)).toEqual({ appB: { a: 'Zap' } });
  });

  it('hydrate drops unknown icon names and malformed data', async () => {
    storage.set(KEY, JSON.stringify({
      appA: { a: 'Heart', b: 'Trash2', c: 7 },
      appB: 'nope',
      appC: ['Heart'],
      appD: { d: 'Bell' },
    }));
    useFolderIconsStore.setState({ icons: {}, hydrated: false });
    await s().hydrate();
    expect(s().icons).toEqual({ appA: { a: 'Heart' }, appD: { d: 'Bell' } });

    storage.set(KEY, 'not json');
    useFolderIconsStore.setState({ icons: {}, hydrated: false });
    await s().hydrate();
    expect(s().icons).toEqual({});
    expect(s().hydrated).toBe(true);

    storage.set(KEY, JSON.stringify(['Heart']));
    useFolderIconsStore.setState({ icons: {}, hydrated: false });
    await s().hydrate();
    expect(s().icons).toEqual({});
  });

  it('a change made before hydrate finishes is applied to the stored icons, not lost', async () => {
    storage.set(KEY, JSON.stringify({ appA: { a: 'Heart' }, appB: { a: 'Zap' } }));
    useFolderIconsStore.setState({ icons: {}, hydrated: false });
    s().forgetAccount('appB');
    setIcon('appA', 'b', 'Bell');
    await s().hydrate();
    await flush();
    expect(s().icons).toEqual({ appA: { a: 'Heart', b: 'Bell' } });
    expect(JSON.parse(storage.get(KEY)!)).toEqual({ appA: { a: 'Heart', b: 'Bell' } });
  });

  it('an icon set since the last prune survives one prune, for a sync that started before the folder was created', () => {
    s().prune('appA', ['a']);
    setIcon('appA', 'new', 'Heart');
    s().prune('appA', ['a']);
    expect(folderIconOf(s(), 'appA', 'new')).toBe('Heart');
    s().prune('appA', ['a', 'new']);
    s().prune('appA', ['a', 'new']);
    expect(folderIconOf(s(), 'appA', 'new')).toBe('Heart');
    s().prune('appA', ['a']);
    expect(folderIconOf(s(), 'appA', 'new')).toBeUndefined();
  });

  it('a remount pruning the same list again does not use up the spare', () => {
    s().prune('appA', ['a'], 'appA|s1');
    setIcon('appA', 'new', 'Heart');
    // A sync that started before the create: its list lacks the folder.
    s().prune('appA', ['a'], 'appA|s2');
    // Settings opened again on that same list.
    s().prune('appA', ['a'], 'appA|s2');
    expect(folderIconOf(s(), 'appA', 'new')).toBe('Heart');
    s().prune('appA', ['a', 'new'], 'appA|s3');
    expect(folderIconOf(s(), 'appA', 'new')).toBe('Heart');
  });

  it('a failed read writes nothing: the stored icons survive a change made meanwhile, which applies once a read succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      storage.set(KEY, JSON.stringify({ appA: { a: 'Heart' }, appB: { a: 'Zap' } }));
      useFolderIconsStore.setState({ icons: {}, hydrated: false });
      io.failReads = 1;
      await s().hydrate();
      expect(s().hydrated).toBe(false);
      s().forgetAccount('appB');
      await flush();
      await flush();
      expect(JSON.parse(storage.get(KEY)!)).toEqual({ appA: { a: 'Heart' } });
      expect(s().hydrated).toBe(true);

      // Every read failing: nothing is written at all.
      storage.set(KEY, JSON.stringify({ appA: { a: 'Heart' } }));
      useFolderIconsStore.setState({ icons: {}, hydrated: false });
      io.failReads = 99;
      setIcon('appA', 'b', 'Bell');
      await flush();
      await flush();
      expect(JSON.parse(storage.get(KEY)!)).toEqual({ appA: { a: 'Heart' } });
      expect(folderIconOf(s(), 'appA', 'b')).toBe('Bell');
      io.failReads = 0;
      await s().hydrate();
      await flush();
      expect(JSON.parse(storage.get(KEY)!)).toEqual({ appA: { a: 'Heart', b: 'Bell' } });
    } finally {
      warn.mockRestore();
    }
  });
});
