// JSON storage for zustand `persist`, backed by AsyncStorage.
//
// A read that fails resolves as "nothing stored" instead of rejecting.
// Android's AsyncStorage can't return a row larger than its ~2 MB
// CursorWindow, and a truncated or corrupt row fails JSON.parse. zustand only
// marks a store hydrated when the read succeeds, so a rejected read left
// `persist.hasHydrated()` false for good and session restore waiting on it.
// Now the store starts empty and its next write replaces the bad row.
//
// `persist` calls setItem with the whole partialized slice on every set(),
// including one that only flips `loading`. Writes are coalesced instead: a
// slice whose fields are the same references as the last one is dropped, the
// rest wait up to PERSIST_WRITE_DELAY_MS and only the newest is serialised,
// and JSON identical to what is stored isn't written again. Pending writes
// go out as soon as the app leaves the foreground.

import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PersistStorage, StorageValue } from 'zustand/middleware';

/** How long a store's write waits to take in further changes. */
export const PERSIST_WRITE_DELAY_MS = 1000;

interface Slot {
  /** The last slice the store handed over, written or not. */
  latest?: StorageValue<unknown>;
  /** The slice waiting to be written. */
  pending?: StorageValue<unknown>;
  timer?: ReturnType<typeof setTimeout>;
  /** The JSON last written or read back. */
  stored?: string;
}

const slots = new Map<string, Slot>();

function slotFor(name: string): Slot {
  let slot = slots.get(name);
  if (!slot) {
    slot = {};
    slots.set(name, slot);
  }
  return slot;
}

// Same version and every field the same reference: nothing new to persist.
function sameSlice(a: StorageValue<unknown>, b: StorageValue<unknown>): boolean {
  if (a.version !== b.version) return false;
  if (a.state === b.state) return true;
  const x = a.state as Record<string, unknown>;
  const y = b.state as Record<string, unknown>;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((k) => Object.is(x[k], y[k]));
}

async function flush(name: string): Promise<void> {
  const slot = slots.get(name);
  if (!slot?.pending) return;
  clearTimeout(slot.timer);
  slot.timer = undefined;
  const value = slot.pending;
  slot.pending = undefined;
  try {
    const json = JSON.stringify(value);
    if (json === slot.stored) return;
    slot.stored = json;
    await AsyncStorage.setItem(name, json);
  } catch (err) {
    slot.stored = undefined;
    console.warn(`[persist] could not save '${name}'`, err);
  }
}

/** Writes every store's pending slice now. */
export async function flushPersistedWrites(): Promise<void> {
  await Promise.all([...slots.keys()].map(flush));
}

let flushesOnBackground = false;

/**
 * `writeDelayMs: 0` writes each changed slice straight away (still skipping
 * unchanged ones), for small stores that other code reads from AsyncStorage.
 */
export function createPersistStorage<S>(
  { writeDelayMs = PERSIST_WRITE_DELAY_MS }: { writeDelayMs?: number } = {},
): PersistStorage<S> {
  if (!flushesOnBackground) {
    flushesOnBackground = true;
    AppState.addEventListener('change', (next) => {
      if (next !== 'active') void flushPersistedWrites();
    });
  }
  return {
    getItem: async (name) => {
      try {
        const raw = await AsyncStorage.getItem(name);
        if (raw === null) return null;
        const value = JSON.parse(raw) as StorageValue<S>;
        slotFor(name).stored = raw;
        return value;
      } catch (err) {
        console.warn(`[persist] could not load '${name}', starting empty`, err);
        return null;
      }
    },
    setItem: (name, value) => {
      const slot = slotFor(name);
      if (slot.latest && sameSlice(slot.latest, value)) return;
      slot.latest = value;
      slot.pending = value;
      if (writeDelayMs === 0) void flush(name);
      else slot.timer ??= setTimeout(() => void flush(name), writeDelayMs);
    },
    // Forgets the pending write and the stored JSON too, so the next write
    // lands even if it matches what was there before.
    removeItem: (name) => {
      clearTimeout(slots.get(name)?.timer);
      slots.delete(name);
      return AsyncStorage.removeItem(name).catch((err) => {
        console.warn(`[persist] could not remove '${name}'`, err);
      });
    },
  };
}

/**
 * Memoises a `partialize` that builds new objects (a mapped list, a folded
 * view) on the store fields it reads. A set() that leaves those alone then
 * hands the storage the same slice, which is dropped without serialising.
 */
export function memoizeSlice<T, P>(
  inputs: (state: T) => readonly unknown[],
  build: (state: T) => P,
): (state: T) => P {
  let last: { inputs: readonly unknown[]; slice: P } | undefined;
  return (state) => {
    const next = inputs(state);
    if (last && next.every((v, i) => Object.is(v, last!.inputs[i]))) return last.slice;
    last = { inputs: next, slice: build(state) };
    return last.slice;
  };
}
