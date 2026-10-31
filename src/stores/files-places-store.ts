// Starred folders and recent files of the Files tab, kept on the device per
// signed-in account: the webmail keeps them in localStorage, and ids and
// paths of one account mean nothing in another.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createPersistStorage } from './persist-storage';
import {
  addRecentFile,
  dropFavoritesUnder,
  moveFavorites,
  pruneRecentFiles,
  removeRecentFiles,
  toggleFavorite,
  type RecentFile,
} from '../lib/files-places';

export interface FilesPlaces {
  favorites: string[];
  recent: RecentFile[];
}

/** What an account without starred or recent files has; one shared object. */
export const NO_FILES_PLACES: FilesPlaces = Object.freeze({ favorites: [], recent: [] }) as FilesPlaces;

interface FilesPlacesState {
  /** By signed-in account id. */
  places: Record<string, FilesPlaces>;
  toggleFavorite: (account: string, path: string) => void;
  moveFavorites: (account: string, oldPath: string, newPath: string) => void;
  dropFavoritesUnder: (account: string, path: string) => void;
  addRecentFile: (account: string, name: string, id: string) => void;
  removeRecentFiles: (account: string, ids: Iterable<string>) => void;
  pruneRecentFiles: (account: string, existingIds: Set<string>) => void;
}

export const useFilesPlacesStore = create<FilesPlacesState>()(
  persist(
    (set, get) => {
      const update = (account: string, change: (p: FilesPlaces) => FilesPlaces) => {
        if (!account) return;
        const current = get().places[account] ?? NO_FILES_PLACES;
        const next = change(current);
        if (next.favorites === current.favorites && next.recent === current.recent) return;
        set({ places: { ...get().places, [account]: next } });
      };
      return {
        places: {},
        toggleFavorite: (account, path) =>
          update(account, (p) => ({ ...p, favorites: toggleFavorite(p.favorites, path) })),
        moveFavorites: (account, oldPath, newPath) =>
          update(account, (p) => ({ ...p, favorites: moveFavorites(p.favorites, oldPath, newPath) })),
        dropFavoritesUnder: (account, path) =>
          update(account, (p) => ({ ...p, favorites: dropFavoritesUnder(p.favorites, path) })),
        addRecentFile: (account, name, id) =>
          update(account, (p) => ({ ...p, recent: addRecentFile(p.recent, name, id) })),
        removeRecentFiles: (account, ids) =>
          update(account, (p) => ({ ...p, recent: removeRecentFiles(p.recent, ids) })),
        pruneRecentFiles: (account, existingIds) =>
          update(account, (p) => ({ ...p, recent: pruneRecentFiles(p.recent, existingIds) })),
      };
    },
    {
      name: 'files-places',
      storage: createPersistStorage(),
      partialize: (state) => ({ places: state.places }),
    },
  ),
);
