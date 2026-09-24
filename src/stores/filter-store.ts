import { create } from 'zustand';
import type { FilterRule, SieveCapabilities, VacationSieveConfig } from '../lib/sieve/types';
import { parseScript } from '../lib/sieve/parser';
import { generateScript, VACATION_SCRIPT_NAME } from '../lib/sieve/generator';
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
  /** The script runs the server's vacation script via `include`. */
  includeVacation: boolean;
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
  includeVacation: false,
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
      const capabilities = getSieveCapabilities(resolvedId);
      set({ sieveCapabilities: capabilities });

      const allScripts = await getSieveScripts(resolvedId);
      if (stale()) return;

      // Skip the server-managed 'vacation' script (RFC 9661 §4) - it can only
      // be modified via VacationResponse/set, not SieveScript/set.
      const scripts = allScripts.filter((s) => s.name !== VACATION_SCRIPT_NAME);

      // Saving activates the filters script, which switches off an active
      // server vacation script. Include it instead so both keep working.
      const vacationActive =
        allScripts.some((s) => s.name === VACATION_SCRIPT_NAME && s.isActive) &&
        supportsInclude(capabilities);

      const activeScript = scripts.find((s) => s.isActive) || scripts[0];
      if (!activeScript) {
        set({
          isLoading: false,
          rules: [],
          activeScriptId: null,
          rawScript: '',
          isOpaque: false,
          includeVacation: vacationActive,
        });
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
        includeVacation: !result.isOpaque && (!!result.includeVacation || vacationActive),
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
      includeVacation: false,
    });
    await get().fetchFilters(accountId ?? undefined);
  },

  saveFilters: async () => {
    set({ isSaving: true, error: null });
    try {
      const {
        isOpaque, rawScript, rules, activeScriptId, vacationSettings, externalRequires, includeVacation,
        selectedAccountId, sieveCapabilities,
      } = get();
      const accountId = selectedAccountId ?? undefined;

      const content = isOpaque
        ? rawScript
        : generateScript(rules, vacationSettings || undefined, {
          externalRequires,
          includeVacation,
          extensions: sieveCapabilities?.sieveExtensions,
        });

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
    includeVacation: false,
    selectedAccountId: null,
  }),
}));

function supportsInclude(capabilities: SieveCapabilities | null): boolean {
  return capabilities?.sieveExtensions?.includes('include') ?? false;
}

async function loadManagedScript(accountId: string) {
  const scripts = await getSieveScripts(accountId);
  const vacationScript = scripts.find((s) => s.name === VACATION_SCRIPT_NAME);
  const filters = scripts.filter((s) => s.name !== VACATION_SCRIPT_NAME);
  const target = filters.find((s) => s.isActive) || filters[0];
  if (!target) return { vacationScript, target: undefined, parsed: undefined };
  const parsed = parseScript(await getSieveScriptContent(target.blobId, accountId));
  return { vacationScript, target, parsed: parsed.isOpaque ? undefined : parsed };
}

/**
 * Whether the account's filters script runs the server's vacation script.
 * VacationResponse.isEnabled reads false in that case, because the vacation
 * script itself is not the active one.
 */
export async function isVacationIncludedInFilters(accountId?: string): Promise<boolean> {
  const { vacationScript, target, parsed } = await loadManagedScript(accountId ?? getSieveAccountId());
  return !!(vacationScript && target?.isActive && parsed?.includeVacation);
}

/**
 * Keep the filters and the auto-reply both running after VacationResponse/set
 * (webmail 198a3c0d).
 *
 * Stalwart allows one active Sieve script and turns the auto-reply on by
 * activating its own "vacation" script, which switches every filter off.
 * When that happened, re-activate the filters script with an `include` of
 * the vacation script. When the auto-reply is turned off, drop the include.
 */
export async function syncVacationWithFilters(enabled: boolean, accountId?: string): Promise<void> {
  const sieveAccountId = accountId ?? getSieveAccountId();
  const capabilities = getSieveCapabilities(sieveAccountId);
  if (enabled && !supportsInclude(capabilities)) return;

  const { vacationScript, target, parsed } = await loadManagedScript(sieveAccountId);
  if (!target || !parsed) return;

  if (enabled) {
    // Only act when the vacation script took over from existing filters.
    if (!vacationScript?.isActive || target.isActive || parsed.rules.length === 0) return;
  } else if (!parsed.includeVacation) {
    return;
  }

  const content = generateScript(parsed.rules, parsed.vacation, {
    externalRequires: parsed.externalRequires,
    includeVacation: enabled,
    extensions: capabilities?.sieveExtensions,
  });
  await updateSieveScript(target.id, content, enabled || target.isActive, sieveAccountId);

  const store = useFilterStore.getState();
  if (store.selectedAccountId === sieveAccountId) {
    await store.fetchFilters(sieveAccountId);
  }
}
