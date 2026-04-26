import { create } from 'zustand';
import {
  getVacationResponse,
  setVacationResponse,
  isVacationSupported,
  type VacationResponse,
} from '../api/vacation';

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

  fetch: () => Promise<void>;
  save: (updates: Partial<Omit<VacationResponse, 'id'>>) => Promise<void>;
  reset: () => void;
}

const INITIAL = {
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

export const useVacationStore = create<VacationState>((set) => ({
  ...INITIAL,

  fetch: async () => {
    set({ isLoading: true, error: null, isSupported: isVacationSupported() });
    try {
      const vacation = await getVacationResponse();
      set({
        isEnabled: vacation.isEnabled,
        fromDate: vacation.fromDate,
        toDate: vacation.toDate,
        subject: vacation.subject ?? '',
        textBody: vacation.textBody ?? '',
        htmlBody: vacation.htmlBody,
        isLoading: false,
        hasLoaded: true,
      });
    } catch (err) {
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
      await setVacationResponse(updates);
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
