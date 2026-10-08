import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => storage.get(k) ?? null,
    setItem: async (k: string, v: string) => { storage.set(k, v); },
  },
}));

import { useKeywordsStore, DEFAULT_KEYWORDS, unknownKeywordColor } from '../keywords-store';
import { useSettingsStore, mergeWithDefaults, toExportShape } from '../settings-store';

const ids = () => useKeywordsStore.getState().keywords.map((k) => k.id);

beforeEach(() => {
  storage.clear();
  useKeywordsStore.setState({ keywords: DEFAULT_KEYWORDS, hydrated: false });
  useSettingsStore.setState({ nestedTags: false });
});

describe('keywords store', () => {
  it('hydrate drops an invalid visibility and a non-string parentId', async () => {
    storage.set('webmail:keywords:v1', JSON.stringify([
      { id: 'a', label: 'A', color: 'red', visibility: 'sometimes', parentId: 7 },
      { id: 'b', label: 'B', color: 'blue', visibility: 'unread', parentId: 'a' },
      { id: 'c', label: 'C', color: 'green', visibility: 'hide', parentId: null },
      'junk',
    ]));
    await useKeywordsStore.getState().hydrate();
    expect(useKeywordsStore.getState().keywords).toEqual([
      { id: 'a', label: 'A', color: 'red' },
      { id: 'b', label: 'B', color: 'blue', visibility: 'unread', parentId: 'a' },
      { id: 'c', label: 'C', color: 'green', visibility: 'hide', parentId: null },
    ]);
  });

  it('hydrate keeps the first of two entries with one id, and repairs a bad colour or label', async () => {
    storage.set('webmail:keywords:v1', JSON.stringify([
      { id: 'a', label: 'A', color: 'red' },
      { id: 'a', label: 'Again', color: 'blue' },
      { id: 'b', label: 'B', color: 'chartreuse' },
      { id: 'c', label: 42, color: 'green' },
      { id: 'd', label: '', color: 'green' },
    ]));
    await useKeywordsStore.getState().hydrate();
    expect(useKeywordsStore.getState().keywords).toEqual([
      { id: 'a', label: 'A', color: 'red' },
      { id: 'b', label: 'B', color: unknownKeywordColor('b') },
      { id: 'c', label: 'c', color: 'green' },
      { id: 'd', label: 'd', color: 'green' },
    ]);
  });

  it('renaming keeps the keyword id', () => {
    useKeywordsStore.getState().update('red', { label: 'Urgent' });
    expect(ids()).toContain('red');
    expect(useKeywordsStore.getState().keywords.find((k) => k.id === 'red')?.label).toBe('Urgent');
  });

  it('move swaps with the adjacent tag and persists the order', () => {
    useKeywordsStore.getState().move('orange', 'up');
    expect(ids().slice(0, 2)).toEqual(['orange', 'red']);
    expect(JSON.parse(storage.get('webmail:keywords:v1')!).slice(0, 2).map((k: { id: string }) => k.id)).toEqual(['orange', 'red']);
  });

  it('move stays among siblings when nested tags are on', () => {
    useKeywordsStore.setState({ keywords: [
      { id: 'work', label: 'Work', color: 'blue' },
      { id: 'a', label: 'A', color: 'red', parentId: 'work' },
      { id: 'home', label: 'Home', color: 'green' },
    ] });
    useSettingsStore.setState({ nestedTags: true });
    useKeywordsStore.getState().move('home', 'up');
    expect(ids()).toEqual(['home', 'a', 'work']);
  });
});

describe('nestedTags setting', () => {
  it('is off by default and exported under the webmail name', () => {
    expect(mergeWithDefaults({} as never).nestedTags).toBe(false);
    expect(toExportShape(mergeWithDefaults({ nestedTags: true } as never))).toHaveProperty('nestedTags', true);
    expect(mergeWithDefaults({ nestedTags: 'yes' } as never).nestedTags).toBe(false);
  });
});
