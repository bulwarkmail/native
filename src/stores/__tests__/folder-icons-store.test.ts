import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => storage.get(k) ?? null,
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
});
