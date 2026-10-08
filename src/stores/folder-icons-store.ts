// Icons picked for folders in Settings → Folders, kept on this device only
// (the webmail keeps them in its synced settings, which the app cannot join).
// Mailbox ids are sequential per account and repeat across accounts and
// servers, so every entry sits under the app account id: account B's folder
// `c` never shows account A's icon for its `c`.

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isFolderIconName, type FolderIconName } from '../lib/folder-icons';

const STORAGE_KEY = 'folderIcons:v1';

type IconMap = Record<string /* appAccountId */, Record<string /* Mailbox.id */, FolderIconName>>;

interface FolderIconsState {
  icons: IconMap;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** Set a folder's icon, or clear it with null. */
  setIcon: (appAccountId: string, mailboxId: string, name: FolderIconName | null) => void;
  /**
   * Drop the account's entries for folders no longer in `liveIds` (deleted
   * elsewhere). An icon set since the account's last prune is spared once:
   * a sync that started before its folder was created lists it next time.
   * `listKey` names the folder list; the list pruned last for the account is
   * not pruned again (Settings opened twice on it), which would use up the
   * spare.
   */
  prune: (appAccountId: string, liveIds: string[], listKey?: string) => void;
  /** Drop every icon of a signed-out account. */
  forgetAccount: (appAccountId: string) => void;
}

/** The icon chosen for a folder of this app account, if any. */
export function folderIconOf(
  state: Pick<FolderIconsState, 'icons'>,
  appAccountId: string | null,
  mailboxId: string,
): FolderIconName | undefined {
  if (!appAccountId) return undefined;
  const forAccount = Object.prototype.hasOwnProperty.call(state.icons, appAccountId)
    ? state.icons[appAccountId] : undefined;
  if (!forAccount || !Object.prototype.hasOwnProperty.call(forAccount, mailboxId)) return undefined;
  return forAccount[mailboxId];
}

// The stored map is hand-editable and could be written by a later build with
// more icons: keep only well-formed entries with a name this build offers.
function sanitize(parsed: unknown): IconMap {
  const out: IconMap = {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [account, entries] of Object.entries(parsed as Record<string, unknown>)) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    const kept: Record<string, FolderIconName> = {};
    for (const [id, name] of Object.entries(entries as Record<string, unknown>)) {
      if (isFolderIconName(name)) kept[id] = name;
    }
    if (Object.keys(kept).length > 0) out[account] = kept;
  }
  return out;
}

function persist(icons: IconMap): void {
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(icons)).catch((err) => {
    console.warn('[folder-icons-store] persist failed', err);
  });
}

function withAccount(icons: IconMap, appAccountId: string, entries: Record<string, FolderIconName>): IconMap {
  const next = { ...icons };
  if (Object.keys(entries).length > 0) next[appAccountId] = entries;
  else delete next[appAccountId];
  return next;
}

let hydrateInFlight: Promise<void> | null = null;
// Changes made before a read of the stored map succeeded, replayed onto it
// when one does. Until then nothing is written: a failed read must not lead
// to a write that replaces every stored icon.
let pending: ((icons: IconMap) => IconMap)[] = [];
// Per account, the folders given an icon since that account's last prune.
const setSincePrune = new Map<string, Set<string>>();
// Per account, the folder list it was last pruned by. Kept here, not in the
// screen, so a remount does not prune the same list twice.
const lastPrunedList = new Map<string, string>();

export const useFolderIconsStore = create<FolderIconsState>((set, get) => {
  // A change made before the stored map is read (a sign-out right after
  // launch) waits for it, so it applies to what is on disk and is not
  // overwritten when hydrate lands.
  const change = (apply: (icons: IconMap) => IconMap) => {
    const current = get().icons;
    const next = apply(current);
    if (get().hydrated) {
      if (next === current) return;
      set({ icons: next });
      persist(next);
      return;
    }
    // Shown at once, stored once the map on disk was read.
    if (next !== current) set({ icons: next });
    pending.push(apply);
    void get().hydrate();
  };

  return {
    icons: {},
    hydrated: false,

    hydrate: () => {
      if (get().hydrated) return Promise.resolve();
      if (!hydrateInFlight) {
        hydrateInFlight = (async () => {
          let raw: string | null;
          try {
            raw = await AsyncStorage.getItem(STORAGE_KEY);
          } catch (err) {
            // Stay un-hydrated: the next hydrate (or change) reads again.
            console.warn('[folder-icons-store] hydrate failed', err);
            return;
          }
          let icons: IconMap = {};
          try {
            if (raw) icons = sanitize(JSON.parse(raw));
          } catch (err) {
            // Unparseable: nothing in it can be kept.
            console.warn('[folder-icons-store] stored icons unreadable', err);
          }
          const replay = pending;
          pending = [];
          for (const apply of replay) icons = apply(icons);
          set({ icons, hydrated: true });
          if (replay.length > 0) persist(icons);
        })().finally(() => { hydrateInFlight = null; });
      }
      return hydrateInFlight;
    },

    setIcon: (appAccountId, mailboxId, name) => change((icons) => {
      const entries = { ...(icons[appAccountId] ?? {}) };
      if (name) {
        if (entries[mailboxId] === name) return icons;
        entries[mailboxId] = name;
        let fresh = setSincePrune.get(appAccountId);
        if (!fresh) setSincePrune.set(appAccountId, fresh = new Set());
        fresh.add(mailboxId);
      } else {
        if (!Object.prototype.hasOwnProperty.call(entries, mailboxId)) return icons;
        delete entries[mailboxId];
      }
      return withAccount(icons, appAccountId, entries);
    }),

    prune: (appAccountId, liveIds, listKey) => {
      if (listKey !== undefined) {
        if (lastPrunedList.get(appAccountId) === listKey) return;
        lastPrunedList.set(appAccountId, listKey);
      }
      change((icons) => {
        const fresh = setSincePrune.get(appAccountId);
        setSincePrune.delete(appAccountId);
        const entries = icons[appAccountId];
        if (!entries) return icons;
        const live = new Set(liveIds);
        for (const id of fresh ?? []) live.add(id);
        const kept: Record<string, FolderIconName> = {};
        for (const [id, name] of Object.entries(entries)) if (live.has(id)) kept[id] = name;
        if (Object.keys(kept).length === Object.keys(entries).length) return icons;
        return withAccount(icons, appAccountId, kept);
      });
    },

    forgetAccount: (appAccountId) => change((icons) => {
      setSincePrune.delete(appAccountId);
      lastPrunedList.delete(appAccountId);
      if (!Object.prototype.hasOwnProperty.call(icons, appAccountId)) return icons;
      const next = { ...icons };
      delete next[appAccountId];
      return next;
    }),
  };
});
