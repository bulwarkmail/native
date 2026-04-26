import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Identity } from '../api/types';
import { getIdentities as fetchIdentities } from '../api/identity';

export type ExternalContentPolicy = 'allow' | 'block' | 'ask';

const STORAGE_KEY = 'webmail:settings:v1';

interface PersistedSettings {
  externalContentPolicy: ExternalContentPolicy;
  trustedSenders: string[];
  senderFavicons: boolean;
  groupContactsByLetter: boolean;
}

const DEFAULT_PERSISTED: PersistedSettings = {
  externalContentPolicy: 'ask',
  trustedSenders: [],
  senderFavicons: true,
  groupContactsByLetter: true,
};

export interface SettingsState {
  identities: Identity[];
  loading: boolean;
  error: string | null;

  externalContentPolicy: ExternalContentPolicy;
  trustedSenders: string[];
  senderFavicons: boolean;
  groupContactsByLetter: boolean;
  hydrated: boolean;

  fetchIdentities: () => Promise<void>;
  hydrate: () => Promise<void>;
  setExternalContentPolicy: (policy: ExternalContentPolicy) => void;
  setSenderFavicons: (enabled: boolean) => void;
  setGroupContactsByLetter: (enabled: boolean) => void;
  addTrustedSender: (email: string) => void;
  removeTrustedSender: (email: string) => void;
  isSenderTrusted: (email: string) => boolean;
  reset: () => void;
}

function persist(state: PersistedSettings): void {
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch((err) => {
    console.warn('[settings-store] persist failed', err);
  });
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  identities: [],
  loading: false,
  error: null,

  externalContentPolicy: DEFAULT_PERSISTED.externalContentPolicy,
  trustedSenders: DEFAULT_PERSISTED.trustedSenders,
  senderFavicons: DEFAULT_PERSISTED.senderFavicons,
  groupContactsByLetter: DEFAULT_PERSISTED.groupContactsByLetter,
  hydrated: false,

  fetchIdentities: async () => {
    set({ loading: true, error: null });
    try {
      const identities = await fetchIdentities();
      set({ identities, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load identities' });
    }
  },

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
        set({
          externalContentPolicy: parsed.externalContentPolicy ?? DEFAULT_PERSISTED.externalContentPolicy,
          trustedSenders: Array.isArray(parsed.trustedSenders) ? parsed.trustedSenders : [],
          senderFavicons: typeof parsed.senderFavicons === 'boolean' ? parsed.senderFavicons : DEFAULT_PERSISTED.senderFavicons,
          groupContactsByLetter: typeof parsed.groupContactsByLetter === 'boolean' ? parsed.groupContactsByLetter : DEFAULT_PERSISTED.groupContactsByLetter,
          hydrated: true,
        });
        return;
      }
    } catch (err) {
      console.warn('[settings-store] hydrate failed', err);
    }
    set({ hydrated: true });
  },

  setExternalContentPolicy: (policy) => {
    set({ externalContentPolicy: policy });
    persist({
      externalContentPolicy: policy,
      trustedSenders: get().trustedSenders,
      senderFavicons: get().senderFavicons,
      groupContactsByLetter: get().groupContactsByLetter,
    });
  },

  setSenderFavicons: (enabled) => {
    set({ senderFavicons: enabled });
    persist({
      externalContentPolicy: get().externalContentPolicy,
      trustedSenders: get().trustedSenders,
      senderFavicons: enabled,
      groupContactsByLetter: get().groupContactsByLetter,
    });
  },

  setGroupContactsByLetter: (enabled) => {
    set({ groupContactsByLetter: enabled });
    persist({
      externalContentPolicy: get().externalContentPolicy,
      trustedSenders: get().trustedSenders,
      senderFavicons: get().senderFavicons,
      groupContactsByLetter: enabled,
    });
  },

  addTrustedSender: (email) => {
    const normalized = email.toLowerCase().trim();
    if (!normalized) return;
    const current = get().trustedSenders;
    if (current.includes(normalized)) return;
    const next = [...current, normalized];
    set({ trustedSenders: next });
    persist({
      externalContentPolicy: get().externalContentPolicy,
      trustedSenders: next,
      senderFavicons: get().senderFavicons,
      groupContactsByLetter: get().groupContactsByLetter,
    });
  },

  removeTrustedSender: (email) => {
    const normalized = email.toLowerCase().trim();
    const next = get().trustedSenders.filter((e) => e !== normalized);
    set({ trustedSenders: next });
    persist({
      externalContentPolicy: get().externalContentPolicy,
      trustedSenders: next,
      senderFavicons: get().senderFavicons,
      groupContactsByLetter: get().groupContactsByLetter,
    });
  },

  isSenderTrusted: (email) => {
    const normalized = email.toLowerCase().trim();
    return get().trustedSenders.includes(normalized);
  },

  reset: () => set({
    identities: [],
    loading: false,
    error: null,
  }),
}));
