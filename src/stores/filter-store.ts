import { create } from 'zustand';
import type { FilterRule, SieveCapabilities, VacationSieveConfig } from '../lib/sieve/types';
import { parseScript } from '../lib/sieve/parser';
import { generateScript } from '../lib/sieve/generator';
import {
  createSieveScript,
  getSieveAccountId,
  getSieveCapabilities,
  getSieveScriptContent,
  getSieveScripts,
  isSieveSupported,
  updateSieveScript,
  validateSieveScript,
} from '../api/sieve';

// Ported from the webmail's stores/filter-store.ts. The mobile client is a
// singleton (api/sieve drives `jmapClient` directly), so the actions drop the
// `client` argument the web store threads through. `selectedAccountId` is the
// Sieve account being edited: the user's own, or a shared/group account.

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
  selectedAccountId: string | null;

  fetchFilters: (accountId?: string) => Promise<void>;
  /** Load another account's filters; null is the user's own Sieve account. */
  selectAccount: (accountId: string | null) => Promise<void>;
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
  selectedAccountId: null,

  fetchFilters: async (accountId) => {
    const requestedId = accountId || get().selectedAccountId || undefined;
    if (!isSieveSupported(requestedId)) {
      set({ isSupported: false, isLoading: false });
      return;
    }
    const resolvedId = requestedId ?? getSieveAccountId();
    set({ isLoading: true, error: null, isSupported: true, selectedAccountId: resolvedId });
    // A reply for an account the user already switched away from must not
    // land in the store: the next save would write it into the other account.
    const stale = () => get().selectedAccountId !== resolvedId;
    try {
      set({ sieveCapabilities: getSieveCapabilities(resolvedId) });

      const allScripts = await getSieveScripts(resolvedId);
      if (stale()) return;

      // Skip the server-managed 'vacation' script (RFC 9661 §4) - it can only
      // be modified via VacationResponse/set, not SieveScript/set.
      const scripts = allScripts.filter((s) => s.name !== 'vacation');

      const activeScript = scripts.find((s) => s.isActive) || scripts[0];
      if (!activeScript) {
        set({ isLoading: false, rules: [], activeScriptId: null, rawScript: '', isOpaque: false });
        return;
      }

      set({ activeScriptId: activeScript.id });

      const content = await getSieveScriptContent(activeScript.blobId, resolvedId);
      if (stale()) return;
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
      if (stale()) return;
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch filters',
      });
    }
  },

  selectAccount: async (accountId) => {
    // Drop the previous account's script first so its rules never show (or
    // get saved) under the newly selected account while the fetch runs.
    set({
      selectedAccountId: accountId,
      rules: [],
      rawScript: '',
      activeScriptId: null,
      isOpaque: false,
      vacationSettings: null,
      externalRequires: [],
    });
    await get().fetchFilters(accountId ?? undefined);
  },

  saveFilters: async () => {
    set({ isSaving: true, error: null });
    try {
      const {
        isOpaque, rawScript, rules, activeScriptId, vacationSettings, externalRequires, selectedAccountId,
      } = get();
      const accountId = selectedAccountId ?? undefined;

      const content = isOpaque
        ? rawScript
        : generateScript(rules, vacationSettings || undefined, { externalRequires });

      if (activeScriptId) {
        await updateSieveScript(activeScriptId, content, true, accountId);
      } else {
        const script = await createSieveScript('filters', content, true, accountId);
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

  validateScript: async (content) =>
    validateSieveScript(content, get().selectedAccountId ?? undefined),

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
    selectedAccountId: null,
  }),
}));
