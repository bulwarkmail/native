import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { fetchLatestRelease, type LatestRelease } from '../api/updates';
import { isNewer } from '../lib/version-compare';
import { downloadAndInstallApk } from '../lib/install-update';

const STORAGE_KEY = 'webmail:updates:v1';
const MIN_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface PersistedUpdates {
  autoCheck: boolean;
  lastCheckedAt: number;
  cachedLatest: LatestRelease | null;
  dismissedTag: string | null;
}

const DEFAULT_PERSISTED: PersistedUpdates = {
  autoCheck: true,
  lastCheckedAt: 0,
  cachedLatest: null,
  dismissedTag: null,
};

export interface UpdatesState extends PersistedUpdates {
  hydrated: boolean;
  checking: boolean;
  installing: boolean;
  error: string | null;

  hydrate: () => Promise<void>;
  setAutoCheck: (enabled: boolean) => void;
  checkNow: (opts?: { force?: boolean }) => Promise<void>;
  installLatest: () => Promise<void>;
  dismissCurrent: () => void;
  currentVersion: () => string;
  hasUpdate: () => boolean;
}

function persist(state: PersistedUpdates): void {
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch((err) => {
    console.warn('[updates-store] persist failed', err);
  });
}

export const useUpdatesStore = create<UpdatesState>((set, get) => ({
  ...DEFAULT_PERSISTED,
  hydrated: false,
  checking: false,
  installing: false,
  error: null,

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedUpdates>;
        set({ ...DEFAULT_PERSISTED, ...parsed, hydrated: true });
      } else {
        set({ hydrated: true });
      }
    } catch (err) {
      console.warn('[updates-store] hydrate failed', err);
      set({ hydrated: true });
    }
  },

  setAutoCheck: (enabled) => {
    set({ autoCheck: enabled });
    const s = get();
    persist({
      autoCheck: enabled,
      lastCheckedAt: s.lastCheckedAt,
      cachedLatest: s.cachedLatest,
      dismissedTag: s.dismissedTag,
    });
  },

  checkNow: async (opts) => {
    const s = get();
    if (s.checking) return;
    const now = Date.now();
    if (!opts?.force && now - s.lastCheckedAt < MIN_CHECK_INTERVAL_MS) return;
    set({ checking: true, error: null });
    try {
      const latest = await fetchLatestRelease();
      const next: PersistedUpdates = {
        autoCheck: s.autoCheck,
        lastCheckedAt: now,
        cachedLatest: latest,
        dismissedTag: s.dismissedTag,
      };
      set({ ...next, checking: false });
      persist(next);
    } catch (err) {
      set({ checking: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  installLatest: async () => {
    const s = get();
    if (s.installing || !s.cachedLatest?.apkAsset) return;
    set({ installing: true, error: null });
    try {
      await downloadAndInstallApk(s.cachedLatest.apkAsset);
      set({ installing: false });
    } catch (err) {
      set({ installing: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  dismissCurrent: () => {
    const s = get();
    const tag = s.cachedLatest?.tag ?? null;
    set({ dismissedTag: tag });
    persist({
      autoCheck: s.autoCheck,
      lastCheckedAt: s.lastCheckedAt,
      cachedLatest: s.cachedLatest,
      dismissedTag: tag,
    });
  },

  currentVersion: () => Constants.expoConfig?.version ?? '0.0.0',

  hasUpdate: () => {
    const s = get();
    if (!s.cachedLatest) return false;
    const current = Constants.expoConfig?.version ?? '0.0.0';
    return isNewer(s.cachedLatest.tag, current);
  },
}));
