import { create } from 'zustand';
import type { Identity } from '../api/types';
import { getIdentities as fetchIdentities } from '../api/identity';

export interface SettingsState {
  identities: Identity[];
  loading: boolean;
  error: string | null;

  fetchIdentities: () => Promise<void>;
  reset: () => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  identities: [],
  loading: false,
  error: null,

  fetchIdentities: async () => {
    set({ loading: true, error: null });
    try {
      const identities = await fetchIdentities();
      set({ identities, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load identities' });
    }
  },

  reset: () => set({
    identities: [],
    loading: false,
    error: null,
  }),
}));
