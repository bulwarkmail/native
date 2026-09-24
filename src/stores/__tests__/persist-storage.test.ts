import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

const appState = vi.hoisted(() => ({ listeners: [] as Array<(state: string) => void> }));
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_type: string, cb: (state: string) => void) => {
      appState.listeners.push(cb);
      return { remove: () => undefined };
    },
  },
}));

import {
  createPersistStorage,
  flushPersistedWrites,
  memoizeSlice,
  PERSIST_WRITE_DELAY_MS,
} from '../persist-storage';

const getItem = vi.mocked(AsyncStorage.getItem);
const setItem = vi.mocked(AsyncStorage.setItem);

let seq = 0;
const freshName = () => `persist-test-${++seq}`;
const writesTo = (name: string) => setItem.mock.calls.filter(([key]) => key === name).map(([, json]) => json);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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

  describe('writes', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('coalesces changes into one write of the newest slice', async () => {
      const storage = createPersistStorage<{ n: number }>();
      const name = freshName();
      storage.setItem(name, { state: { n: 1 }, version: 0 });
      storage.setItem(name, { state: { n: 2 }, version: 0 });
      storage.setItem(name, { state: { n: 3 }, version: 0 });

      await vi.advanceTimersByTimeAsync(PERSIST_WRITE_DELAY_MS - 1);
      expect(writesTo(name)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(writesTo(name)).toEqual([JSON.stringify({ state: { n: 3 }, version: 0 })]);
    });

    it('writes no later than the delay after the first change, however busy the store is', async () => {
      const storage = createPersistStorage<{ n: number }>();
      const name = freshName();
      for (let n = 0; n < 10; n++) {
        storage.setItem(name, { state: { n }, version: 0 });
        await vi.advanceTimersByTimeAsync(PERSIST_WRITE_DELAY_MS / 4);
      }
      expect(writesTo(name).length).toBeGreaterThanOrEqual(2);
    });

    it('drops a slice whose fields are the same references as the last one', async () => {
      const storage = createPersistStorage<{ list: number[] }>();
      const name = freshName();
      const list = [1, 2, 3];
      storage.setItem(name, { state: { list }, version: 0 });
      await vi.advanceTimersByTimeAsync(PERSIST_WRITE_DELAY_MS);
      const stringify = vi.spyOn(JSON, 'stringify');

      storage.setItem(name, { state: { list }, version: 0 });
      await vi.advanceTimersByTimeAsync(PERSIST_WRITE_DELAY_MS);

      expect(stringify).not.toHaveBeenCalled();
      expect(writesTo(name)).toHaveLength(1);
    });

    it('does not rewrite JSON identical to what is stored', async () => {
      const storage = createPersistStorage<{ list: number[] }>();
      const name = freshName();
      storage.setItem(name, { state: { list: [1, 2] }, version: 0 });
      await vi.advanceTimersByTimeAsync(PERSIST_WRITE_DELAY_MS);
      storage.setItem(name, { state: { list: [1, 2] }, version: 0 });
      await vi.advanceTimersByTimeAsync(PERSIST_WRITE_DELAY_MS);
      expect(writesTo(name)).toHaveLength(1);
    });

    it('does not rewrite a slice that matches the row it hydrated from', async () => {
      const name = freshName();
      const row = JSON.stringify({ state: { list: [1, 2] }, version: 0 });
      await AsyncStorage.setItem(name, row);
      setItem.mockClear();
      const storage = createPersistStorage<{ list: number[] }>();

      await storage.getItem(name);
      storage.setItem(name, { state: { list: [1, 2] }, version: 0 });
      await vi.advanceTimersByTimeAsync(PERSIST_WRITE_DELAY_MS);

      expect(writesTo(name)).toEqual([]);
    });

    it('writes pending slices as soon as the app leaves the foreground', async () => {
      const storage = createPersistStorage<{ n: number }>();
      const name = freshName();
      storage.setItem(name, { state: { n: 1 }, version: 0 });
      expect(appState.listeners).toHaveLength(1);

      appState.listeners[0]('background');
      await vi.advanceTimersByTimeAsync(0);

      expect(writesTo(name)).toEqual([JSON.stringify({ state: { n: 1 }, version: 0 })]);
      await vi.advanceTimersByTimeAsync(PERSIST_WRITE_DELAY_MS);
      expect(writesTo(name)).toHaveLength(1);
    });

    it('writes straight away with writeDelayMs 0', async () => {
      const storage = createPersistStorage<{ n: number }>({ writeDelayMs: 0 });
      const name = freshName();
      storage.setItem(name, { state: { n: 1 }, version: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(writesTo(name)).toHaveLength(1);
    });

    it('drops the pending write on remove and writes the same slice again afterwards', async () => {
      const storage = createPersistStorage<{ n: number }>();
      const name = freshName();
      storage.setItem(name, { state: { n: 1 }, version: 0 });
      await vi.advanceTimersByTimeAsync(PERSIST_WRITE_DELAY_MS);
      storage.setItem(name, { state: { n: 2 }, version: 0 });

      await storage.removeItem(name);
      await vi.advanceTimersByTimeAsync(PERSIST_WRITE_DELAY_MS);
      expect(writesTo(name)).toHaveLength(1);
      expect(await AsyncStorage.getItem(name)).toBeNull();

      storage.setItem(name, { state: { n: 1 }, version: 0 });
      await flushPersistedWrites();
      expect(writesTo(name)).toHaveLength(2);
    });

    it('keeps a store that only flips loading from writing', async () => {
      const name = freshName();
      type State = { items: string[]; loading: boolean };
      const useStore = create<State>()(
        persist((): State => ({ items: [], loading: false }), {
          name,
          storage: createPersistStorage(),
          partialize: (state) => ({ items: state.items }),
        }),
      );
      await vi.waitFor(() => expect(useStore.persist.hasHydrated()).toBe(true));

      useStore.setState({ items: ['a'] });
      useStore.setState({ loading: true });
      useStore.setState({ loading: false });
      await vi.advanceTimersByTimeAsync(PERSIST_WRITE_DELAY_MS);
      useStore.setState({ loading: true });
      useStore.setState({ loading: false });
      await vi.advanceTimersByTimeAsync(PERSIST_WRITE_DELAY_MS);

      expect(writesTo(name)).toEqual([JSON.stringify({ state: { items: ['a'] }, version: 0 })]);
    });
  });
});

describe('memoizeSlice', () => {
  it('returns the previous slice until an input changes', () => {
    const build = vi.fn((s: { list: number[]; loading: boolean }) => ({ doubled: s.list.map((n) => n * 2) }));
    const partialize = memoizeSlice((s: { list: number[]; loading: boolean }) => [s.list], build);
    const list = [1, 2];

    const first = partialize({ list, loading: false });
    expect(partialize({ list, loading: true })).toBe(first);
    expect(build).toHaveBeenCalledTimes(1);

    expect(partialize({ list: [1, 2, 3], loading: true })).toEqual({ doubled: [2, 4, 6] });
    expect(build).toHaveBeenCalledTimes(2);
  });
});
