import { create } from 'zustand';
import type { FilterRule, SieveCapabilities, VacationSieveConfig } from '../lib/sieve/types';
import { parseScript } from '../lib/sieve/parser';
import { generateScript } from '../lib/sieve/generator';
import {
  createSieveScript,
  getSieveCapabilities,
  getSieveScriptContent,
  getSieveScripts,
  isSieveSupported,
  updateSieveScript,
  validateSieveScript,
} from '../api/sieve';

// Ported from the webmail's stores/filter-store.ts. The mobile client is a
// singleton (api/sieve drives `jmapClient` directly), so the actions drop the
// `client` argument the web store threads through.

interface FilterStore {
  rules: FilterRule[];
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  isSupported: boolean;
  sieveCapabilities: SieveCapabilities | null;
  activeScriptId: string | null;
  isOpaque: boolean;
  rawScript: string;
  vacationSettings: VacationSieveConfig | null;
  externalRequires: string[];

  fetchFilters: () => Promise<void>;
  saveFilters: () => Promise<void>;
  validateScript: (content: string) => Promise<{ isValid: boolean; errors?: string[] }>;
  addRule: (rule: FilterRule) => void;
  updateRule: (ruleId: string, updates: Partial<FilterRule>) => void;
  deleteRule: (ruleId: string) => void;
  reorderRules: (ruleIds: string[]) => void;
  toggleRule: (ruleId: string) => void;
  setRawScript: (content: string) => void;
  setOpaqueScript: (content: string) => void;
  resetToVisualBuilder: () => void;
  clearState: () => void;
}

export const useFilterStore = create<FilterStore>()((set, get) => ({
  rules: [],
  isLoading: false,
  isSaving: false,
  error: null,
  isSupported: false,
  sieveCapabilities: null,
  activeScriptId: null,
  isOpaque: false,
  rawScript: '',
  vacationSettings: null,
  externalRequires: [],

  fetchFilters: async () => {
    if (!isSieveSupported()) {
      set({ isSupported: false, isLoading: false });
      return;
    }
    set({ isLoading: true, error: null, isSupported: true });
    try {
      set({ sieveCapabilities: getSieveCapabilities() });

      const allScripts = await getSieveScripts();

      // Skip the server-managed 'vacation' script (RFC 9661 §4) - it can only
      // be modified via VacationResponse/set, not SieveScript/set.
      const scripts = allScripts.filter((s) => s.name !== 'vacation');

      const activeScript = scripts.find((s) => s.isActive) || scripts[0];
      if (!activeScript) {
        set({ isLoading: false, rules: [], activeScriptId: null, rawScript: '', isOpaque: false });
        return;
      }

      set({ activeScriptId: activeScript.id });

      const content = await getSieveScriptContent(activeScript.blobId);
      set({ rawScript: content });

      const result = parseScript(content);

      set({
        isLoading: false,
        isOpaque: result.isOpaque,
        rules: result.isOpaque ? [] : result.rules,
        vacationSettings: result.vacation || null,
        externalRequires: result.externalRequires,
      });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch filters',
      });
    }
  },

  saveFilters: async () => {
    set({ isSaving: true, error: null });
    try {
      const { isOpaque, rawScript, rules, activeScriptId, vacationSettings, externalRequires } = get();

      const content = isOpaque
        ? rawScript
        : generateScript(rules, vacationSettings || undefined, { externalRequires });

      if (activeScriptId) {
        await updateSieveScript(activeScriptId, content, true);
      } else {
        const script = await createSieveScript('filters', content, true);
        set({ activeScriptId: script.id });
      }

      set({ isSaving: false, rawScript: content });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to save filters',
      });
      throw error;
    }
  },

  validateScript: async (content) => validateSieveScript(content),

  addRule: (rule) => {
    // Insert new bulwark rules before external/opaque rules so Bulwark's
    // managed section stays contiguous.
    set((state) => {
      const bulwark = state.rules.filter((r) => !r.origin || r.origin === 'bulwark');
      const external = state.rules.filter((r) => r.origin === 'external' || r.origin === 'opaque');
      return { rules: [...bulwark, rule, ...external] };
    });
  },

  updateRule: (ruleId, updates) => {
    set((state) => ({
      rules: state.rules.map((r) => {
        if (r.id !== ruleId) return r;
        if (r.origin === 'external' || r.origin === 'opaque') return r; // read-only
        return { ...r, ...updates };
      }),
    }));
  },

  deleteRule: (ruleId) => {
    set((state) => ({
      rules: state.rules.filter((r) => {
        if (r.id !== ruleId) return true;
        return r.origin === 'external' || r.origin === 'opaque';
      }),
    }));
  },

  reorderRules: (ruleIds) => {
    // Only reorder bulwark rules; external rules always stay at the end in
    // their original order.
    set((state) => {
      const bulwarkMap = new Map(
        state.rules.filter((r) => !r.origin || r.origin === 'bulwark').map((r) => [r.id, r]),
      );
      const external = state.rules.filter((r) => r.origin === 'external' || r.origin === 'opaque');
      const reordered = ruleIds.map((id) => bulwarkMap.get(id)).filter(Boolean) as FilterRule[];
      return { rules: [...reordered, ...external] };
    });
  },

  toggleRule: (ruleId) => {
    set((state) => ({
      rules: state.rules.map((r) => {
        if (r.id !== ruleId) return r;
        if (r.origin === 'external' || r.origin === 'opaque') return r; // read-only
        return { ...r, enabled: !r.enabled };
      }),
    }));
  },

  setRawScript: (content) => set({ rawScript: content }),

  // Switch to raw-script mode in one update so the visual rules are dropped
  // atomically with the new content (mirrors the webmail save-sieve flow).
  setOpaqueScript: (content) => set({ isOpaque: true, rawScript: content, rules: [] }),

  resetToVisualBuilder: () => set({ isOpaque: false, rawScript: '', rules: [], externalRequires: [] }),

  clearState: () => set({
    rules: [],
    isLoading: false,
    isSaving: false,
    error: null,
    isSupported: false,
    sieveCapabilities: null,
    activeScriptId: null,
    isOpaque: false,
    rawScript: '',
    vacationSettings: null,
    externalRequires: [],
  }),
}));
