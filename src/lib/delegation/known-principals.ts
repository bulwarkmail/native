/**
 * Names of the people and groups the user gave access to, kept on this
 * device (webmail lib/delegation/known-principals.ts). Stalwart 1.0 with
 * directory queries off (its default) won't name a principal the user
 * shares with unless that principal also shares something back, so the
 * "Who has access" list would otherwise show "Unknown person" for the very
 * people the user just picked by name. Only the people who have access and
 * the one just picked are kept, never the directory; per login, at most MAX
 * entries, gone when the login is removed (pruneRememberedPrincipals) or
 * everyone signs out. A convenience: losing it costs names, not access.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Principal } from '../../api/types';

export const DELEGATE_NAMES_KEY = 'bulwark-delegate-names';
const MAX = 200;

type Entry = Pick<Principal, 'id' | 'name' | 'email' | 'type'>;
type Store = Record<string, Record<string, Entry>>;

async function readStore(): Promise<Store> {
  try {
    const raw = await AsyncStorage.getItem(DELEGATE_NAMES_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

async function writeStore(store: Store): Promise<void> {
  try {
    if (Object.keys(store).length === 0) await AsyncStorage.removeItem(DELEGATE_NAMES_KEY);
    else await AsyncStorage.setItem(DELEGATE_NAMES_KEY, JSON.stringify(store));
  } catch {
    // Storage unavailable: the list shows "Unknown person" instead.
  }
}

// Writes one after the other, so two quick remembers don't drop each other.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

/** Remember these principals for `accountKey` (the signed-in login). */
export function rememberPrincipals(accountKey: string, principals: Principal[]): Promise<void> {
  if (!accountKey || principals.length === 0) return Promise.resolve();
  return serial(async () => {
    const store = await readStore();
    const own = { ...(store[accountKey] ?? {}) };
    for (const p of principals) {
      delete own[p.id];
      own[p.id] = { id: p.id, name: p.name, email: p.email ?? null, type: p.type };
    }
    const ids = Object.keys(own);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX))) delete own[id];
    store[accountKey] = own;
    await writeStore(store);
  });
}

/** The principals remembered for `accountKey`, by id. */
export async function rememberedPrincipals(accountKey: string): Promise<Map<string, Principal>> {
  await queue;
  const own = (await readStore())[accountKey] ?? {};
  return new Map(Object.values(own).map((entry) => [entry.id, entry as Principal]));
}

/**
 * Forget the names kept for every login not in `liveAccountKeys` (removed
 * from the app, or everyone signed out).
 */
export function pruneRememberedPrincipals(liveAccountKeys: string[]): Promise<void> {
  return serial(async () => {
    const store = await readStore();
    const live = new Set(liveAccountKeys);
    const stale = Object.keys(store).filter((key) => !live.has(key));
    if (stale.length === 0) return;
    for (const key of stale) delete store[key];
    await writeStore(store);
  });
}
