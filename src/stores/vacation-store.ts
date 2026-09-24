import { create } from 'zustand';
import {
  getVacationResponse,
  setVacationResponse,
  isVacationSupported,
  type VacationResponse,
} from '../api/vacation';
import { isSieveSupported } from '../api/sieve';
import { isVacationIncludedInFilters, syncVacationWithFilters } from './filter-store';

export interface VacationState {
  isEnabled: boolean;
  fromDate: string | null;
  toDate: string | null;
  subject: string;
  textBody: string;
  htmlBody: string | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  isSupported: boolean;
  hasLoaded: boolean;
  /** Account the responder belongs to: null for the user's own, else a shared/group account. */
  accountId: string | null;

  fetch: (accountId?: string) => Promise<void>;
  save: (updates: Partial<Omit<VacationResponse, 'id'>>) => Promise<void>;
  reset: () => void;
}

const INITIAL = {
  accountId: null,
  isEnabled: false,
  fromDate: null,
  toDate: null,
  subject: '',
  textBody: '',
  htmlBody: null,
  isLoading: false,
  isSaving: false,
  error: null,
  isSupported: false,
  hasLoaded: false,
};

export const useVacationStore = create<VacationState>((set, get) => ({
  ...INITIAL,

  fetch: async (accountId) => {
    const target = accountId ?? null;
    // Switching accounts starts from a blank form rather than showing (and
    // letting the user save) the previous account's responder.
    if (get().accountId !== target) set({ ...INITIAL, accountId: target });
    set({ isLoading: true, error: null, isSupported: isVacationSupported(accountId) });
    // A reply for an account the user already switched away from is dropped.
    const stale = () => get().accountId !== target;
    try {
      const vacation = await getVacationResponse(accountId);
      if (stale()) return;
      let isEnabled = vacation.isEnabled;
      if (!isEnabled && isSieveSupported(accountId)) {
        // Running from the filters script leaves the vacation script itself
        // inactive, so VacationResponse reports it as off.
        isEnabled = await isVacationIncludedInFilters(accountId).catch(() => false);
        if (stale()) return;
      }
      set({
        isEnabled,
        fromDate: vacation.fromDate,
        toDate: vacation.toDate,
        subject: vacation.subject ?? '',
        textBody: vacation.textBody ?? '',
        htmlBody: vacation.htmlBody,
        isLoading: false,
        hasLoaded: true,
      });
    } catch (err) {
      if (stale()) return;
      set({
        isLoading: false,
        hasLoaded: true,
        error: err instanceof Error ? err.message : 'Failed to load vacation responder',
      });
    }
  },

  save: async (updates) => {
    set({ isSaving: true, error: null });
    try {
      const accountId = get().accountId ?? undefined;
      await setVacationResponse(updates, accountId);
      if (updates.isEnabled !== undefined && isSieveSupported(accountId)) {
        try {
          await syncVacationWithFilters(updates.isEnabled, accountId);
        } catch (err) {
          console.warn('[vacation] Failed to keep filters active next to the vacation response:', err);
        }
      }
      set((s) => ({
        ...s,
        ...updates,
        isSaving: false,
      }));
    } catch (err) {
      set({
        isSaving: false,
        error: err instanceof Error ? err.message : 'Failed to save vacation responder',
      });
      throw err;
    }
  },

  reset: () => set({ ...INITIAL }),
}));
