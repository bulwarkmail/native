/**
 * The folders messages were last moved to, per signed-in account, most
 * recent first (webmail lib/move-recent.ts, 56e833fe6). Kept on this device
 * only; the Move sheet shows the few that still exist. Held in memory and in
 * AsyncStorage.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'bulwark.moveRecent.v1';
const KEPT = 8;

/** How many recent folders the Move sheet shows. */
export const MOVE_RECENT_SHOWN = 3;
/** Above this many folders the Move sheet gets a filter field. */
export const MOVE_FILTER_THRESHOLD = 12;

let store: Record<string, string[]> = {};
let loaded: Promise<void> | null = null;

export function loadRecentMoveTargets(): Promise<void> {
  loaded ??= (async () => {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const read: Record<string, string[]> = {};
      for (const [account, ids] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(ids)) read[account] = ids.filter((id): id is string => typeof id === 'string').slice(0, KEPT);
      }
      // What this run noted already comes first.
      for (const [account, ids] of Object.entries(store)) {
        read[account] = [...ids, ...(read[account] ?? []).filter((id) => !ids.includes(id))].slice(0, KEPT);
      }
      store = read;
    } catch {
      // Unreadable: no recents.
    }
  })();
  return loaded;
}

export function readRecentMoveTargets(accountId: string | null | undefined): string[] {
  if (!accountId) return [];
  return store[accountId] ?? [];
}

/**
 * Notes a move. The list has it at once; it is saved once what earlier runs
 * noted has been read, which a save before that replaced on a cold start.
 */
export function noteMoveTarget(accountId: string | null | undefined, mailboxId: string): Promise<void> {
  if (!accountId || !mailboxId) return Promise.resolve();
  store = { ...store, [accountId]: [mailboxId, ...(store[accountId] ?? []).filter((id) => id !== mailboxId)].slice(0, KEPT) };
  return loadRecentMoveTargets().then(() => {
    try {
      void AsyncStorage.setItem(KEY, JSON.stringify(store)).catch(() => undefined);
    } catch {
      // Storage off: the list just has no recents.
    }
  });
}

/** Lowercased, without accents, for matching a typed filter. */
export function foldForFilter(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

interface FilterNode<T> {
  children: T[];
}

/** The tree with only the nodes whose label matches `query`, and their ancestors. */
export function filterTree<T extends FilterNode<T>>(nodes: T[], query: string, labelOf: (node: T) => string): T[] {
  const q = foldForFilter(query.trim());
  if (!q) return nodes;
  const keep = (list: T[]): T[] =>
    list.reduce<T[]>((acc, node) => {
      const children = keep(node.children);
      if (foldForFilter(labelOf(node)).includes(q) || children.length) acc.push({ ...node, children });
      return acc;
    }, []);
  return keep(nodes);
}

export function resetRecentMoveTargetsForTests(): void {
  store = {};
  loaded = null;
}
