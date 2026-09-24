import { describe, it, expect, vi, afterEach } from 'vitest';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createPersistStorage } from '../persist-storage';

const getItem = AsyncStorage.getItem as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createPersistStorage', () => {
  describe('getItem', () => {
    it('parses a stored value', async () => {
      await AsyncStorage.setItem('ok-row', JSON.stringify({ state: { n: 1 }, version: 0 }));
      expect(await createPersistStorage<{ n: number }>().getItem('ok-row')).toEqual({
        state: { n: 1 },
        version: 0,
      });
    });

    it('resolves as empty when the read fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      getItem.mockRejectedValueOnce(new Error("Couldn't read row 0, col 0 from CursorWindow"));
      expect(await createPersistStorage().getItem('big-row')).toBeNull();
      expect(warn).toHaveBeenCalled();
    });

    it('resolves as empty when the stored JSON is corrupt', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await AsyncStorage.setItem('corrupt-row', '{"state":{"n":');
      expect(await createPersistStorage().getItem('corrupt-row')).toBeNull();
    });
  });

  it('lets a store whose row cannot be read finish hydrating with its defaults', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    getItem.mockRejectedValueOnce(new Error('Row too big to fit into CursorWindow'));
    const useStore = create<{ n: number }>()(
      persist(() => ({ n: 0 }), { name: 'unreadable-row', storage: createPersistStorage() }),
    );
    await vi.waitFor(() => expect(useStore.persist.hasHydrated()).toBe(true));
    expect(useStore.getState().n).toBe(0);
  });
});
