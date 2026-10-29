import { create } from 'zustand';
import type {
  FilterRule, SieveCapabilities, VacationAudience, VacationForward, VacationSieveConfig,
} from '../lib/sieve/types';
import { parseScript } from '../lib/sieve/parser';
import { generateScript, supportsSpamGuard, VACATION_SCRIPT_NAME } from '../lib/sieve/generator';
import { supportsPeriods } from '../lib/sieve/period';
import { isValidVacationForward, withVacationPeriod } from '../lib/sieve/vacation-forward';
import { isValidVacationAudience, normalizeVacationAudience } from '../lib/sieve/vacation-audience';
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
import { FiltersLoginChangedError, OpaqueFiltersError } from '../api/sieve-rules';
import { jmapClient } from '../api/jmap-client';
import { servedLoginOf } from '../lib/draft-login';

export { OpaqueFiltersError };

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
  /** Forwarding from the vacation card; carried through every save. */
  vacationForward: VacationForward | null;
  /** Who gets the auto-reply, when not everyone; carried through every save. */
  vacationAudience: VacationAudience | null;
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
  vacationForward: null,
  vacationAudience: null,
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
          vacationForward: null,
          vacationAudience: null,
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
        vacationForward: result.isOpaque ? null : result.vacationForward ?? null,
        vacationAudience: result.isOpaque ? null : result.vacationAudience ?? null,
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
      vacationForward: null,
      vacationAudience: null,
    });
    await get().fetchFilters(accountId ?? undefined);
  },

  saveFilters: async () => {
    set({ isSaving: true, error: null });
    try {
      const {
        isOpaque, rawScript, rules, activeScriptId, vacationSettings, externalRequires, includeVacation,
        vacationForward, vacationAudience, selectedAccountId, sieveCapabilities,
      } = get();
      const accountId = selectedAccountId ?? undefined;

      const content = isOpaque
        ? rawScript
        : generateScript(rules, vacationSettings || undefined, {
          externalRequires,
          includeVacation,
          vacationForward,
          vacationAudience,
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
    vacationForward: null,
    vacationAudience: null,
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

/** What the vacation card needs from the account's filters script (webmail readVacationFilters). */
export interface VacationFilters {
  /**
   * The filters script runs the server's vacation script. VacationResponse
   * .isEnabled reads false in that case, because the vacation script itself
   * is not the active one.
   */
  includesVacation: boolean;
  /** The forwarding as stored, on or off; null when none is set up. */
  forward: VacationForward | null;
  /**
   * Forwarding can be set up: it runs from the filters script next to the
   * included vacation script, so it needs `include`, a script Bulwark can
   * read, a server that allows a redirect and what the block uses besides
   * (its period, its spam check, the copy). Forwarding that is on is offered
   * all the same, so that it can be switched off.
   */
  forwardAvailable: boolean;
  /** Who gets the auto-reply as stored; null when everyone does. */
  audience: VacationAudience | null;
  /**
   * The auto-reply can be narrowed to some senders: it then runs from the
   * filters script, so this needs `include`, `envelope` and a script Bulwark
   * can read.
   */
  audienceAvailable: boolean;
  /**
   * Forwarding that is on, or an auto-reply for some senders only, is stored
   * but does not run: both run only from the active filters script, and
   * Stalwart's own vacation script took over (a save cut short, another
   * client), or no script runs at all. Saving the card sets it right.
   */
  notRunning: boolean;
}

/** See VacationFilters.notRunning. */
function storedButIdle(
  filtersActive: boolean,
  vacationActive: boolean,
  forward: VacationForward | null,
  audience: VacationAudience | null,
): boolean {
  if (filtersActive) return false;
  return !!forward?.enabled || (!!audience && vacationActive);
}

/** The server runs the forwarding block: a redirect, its period, its spam check and the copy. */
function canForward(capabilities: SieveCapabilities | null | undefined): boolean {
  const extensions = capabilities?.sieveExtensions;
  return capabilities?.maxNumberRedirects !== 0 &&
    supportsPeriods(extensions) &&
    supportsSpamGuard(extensions) &&
    !!extensions?.includes('copy');
}

export async function readVacationFilters(accountId?: string): Promise<VacationFilters> {
  const sieveAccountId = accountId ?? getSieveAccountId();
  const capabilities = getSieveCapabilities(sieveAccountId);
  const { vacationScript, target, parsed } = await loadManagedScript(sieveAccountId);
  const filtersUsable = supportsInclude(capabilities) && !(target && !parsed);
  const forward = parsed?.vacationForward ?? null;
  const audience = parsed?.vacationAudience ?? null;
  return {
    includesVacation: !!(vacationScript && target?.isActive && parsed?.includeVacation),
    forward,
    forwardAvailable: filtersUsable && (canForward(capabilities) || !!forward?.enabled),
    audience,
    // Told apart by the envelope sender, which the auto-reply goes to.
    audienceAvailable: filtersUsable && !!capabilities?.sieveExtensions?.includes('envelope'),
    notRunning: storedButIdle(!!target?.isActive, !!vacationScript?.isActive, forward, audience),
  };
}

function same<T>(a: T | null, b: T | null, normalize: (value: T) => T): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

// The same moment, however it is written: the server hands the vacation's
// dates back in its own form.
function sameMoment(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a === b || Date.parse(a) === Date.parse(b);
}

function sameForward(a: VacationForward | null, b: VacationForward | null): boolean {
  if (!a || !b) return a === b;
  return a.enabled === b.enabled && a.to === b.to && a.keepCopy === b.keepCopy &&
    sameMoment(a.activeFrom, b.activeFrom) && sameMoment(a.activeUntil, b.activeUntil);
}

/**
 * Keep the filters, the auto-reply and its forwarding running after
 * VacationResponse/set (webmail 198a3c0d, 1.13 forwarding).
 *
 * Stalwart allows one active Sieve script and turns the auto-reply on by
 * activating its own "vacation" script, which switches every filter off.
 * When that happened, re-activate the filters script with an `include` of
 * the vacation script. When the auto-reply is turned off, drop the include.
 *
 * `forward` replaces the stored forwarding (null removes it, undefined keeps
 * it). Forwarding runs with or without the auto-reply, but only from an
 * active filters script, so for it the script is activated even without
 * rules, and created when there is none. `audience` likewise replaces who
 * gets the auto-reply (null: everyone). `period` is the vacation's, which
 * whatever forwarding there is keeps to. `login` is the login the vacation
 * was saved in: once the client serves another, nothing is written.
 */
export async function syncVacationWithFilters(
  enabled: boolean,
  accountId?: string,
  forward?: VacationForward | null,
  audience?: VacationAudience | null,
  period?: { from: string | null; until: string | null },
  login?: string | null,
): Promise<void> {
  const sieveAccountId = accountId ?? getSieveAccountId();
  const capabilities = getSieveCapabilities(sieveAccountId);
  const canInclude = supportsInclude(capabilities);
  if (enabled && !canInclude && forward === undefined && audience === undefined) return;

  const { vacationScript, target, parsed } = await loadManagedScript(sieveAccountId);
  const opaque = !!target && !parsed;
  const storedForward = parsed?.vacationForward ?? null;
  const storedAudience = parsed?.vacationAudience ?? null;
  const requestedForward = forward === undefined ? storedForward : forward;
  const nextForward = requestedForward && period ? withVacationPeriod(requestedForward, period) : requestedForward;
  const nextAudience = audience === undefined ? storedAudience : audience;
  const changed =
    !sameForward(storedForward, nextForward) ||
    !same(storedAudience, nextAudience, normalizeVacationAudience);

  if (changed) {
    // The card only offers these where they can be stored and run.
    if (opaque) throw new OpaqueFiltersError();
    if (!canInclude) throw new Error('Forwarding and reply recipients need the Sieve "include" extension');
    // The generator leaves out what it could not read back, and the save
    // would look done while nothing forwards, or everyone gets the reply.
    if (nextForward && !isValidVacationForward(nextForward)) throw new Error('Unusable vacation forwarding');
    if (nextAudience && !isValidVacationAudience(nextAudience)) throw new Error('Unusable vacation reply recipients');
  }
  if ((enabled && !canInclude) || opaque) return;

  const rules = parsed?.rules ?? [];
  const forwarding = !!nextForward?.enabled;
  if (enabled) {
    // Act when the vacation script took over from filters that must keep
    // running, or when something changed. An auto-reply for some senders
    // only must run from the filters script: on its own it answers everyone.
    const tookOver = !!vacationScript?.isActive && !target?.isActive;
    const needsFilters = rules.length > 0 || forwarding || !!nextAudience;
    if (!changed && !(tookOver && needsFilters)) return;
  } else {
    // Forwarding also runs without the auto-reply, from an active filters
    // script; turning the auto-reply off can leave no script active.
    const forwardingIdle = forwarding && !target?.isActive;
    if (!changed && !parsed?.includeVacation && !forwardingIdle) return;
  }

  const content = generateScript(rules, parsed?.vacation, {
    externalRequires: parsed?.externalRequires,
    includeVacation: enabled,
    vacationForward: nextForward,
    vacationAudience: nextAudience,
    extensions: capabilities?.sieveExtensions,
  });
  const activate = enabled || forwarding || !!target?.isActive;
  if (login !== undefined && servedLoginOf(jmapClient) !== login) throw new FiltersLoginChangedError();
  if (target) {
    await updateSieveScript(target.id, content, activate, sieveAccountId);
  } else {
    await createSieveScript('filters', content, activate, sieveAccountId);
  }

  const store = useFilterStore.getState();
  if (store.selectedAccountId === sieveAccountId) {
    await store.fetchFilters(sieveAccountId);
  }
}
