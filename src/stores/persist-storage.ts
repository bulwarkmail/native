// JSON storage for zustand `persist`, backed by AsyncStorage.
//
// A read that fails resolves as "nothing stored" instead of rejecting.
// Android's AsyncStorage can't return a row larger than its ~2 MB
// CursorWindow, and a truncated or corrupt row fails JSON.parse. zustand only
// marks a store hydrated when the read succeeds, so a rejected read left
// `persist.hasHydrated()` false for good and session restore waiting on it.
// Now the store starts empty and its next write replaces the bad row.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PersistStorage, StorageValue } from 'zustand/middleware';

export function createPersistStorage<S>(): PersistStorage<S> {
  return {
    getItem: async (name) => {
      try {
        const raw = await AsyncStorage.getItem(name);
        return raw === null ? null : (JSON.parse(raw) as StorageValue<S>);
      } catch (err) {
        console.warn(`[persist] could not load '${name}', starting empty`, err);
        return null;
      }
    },
    setItem: (name, value) => AsyncStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => AsyncStorage.removeItem(name),
  };
}
