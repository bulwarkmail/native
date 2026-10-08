import { create } from 'zustand';
import type {
  FilterRule,
  SieveCapabilities,
  VacationAudience,
  VacationForward,
  VacationSieveConfig,
} from '../lib/sieve/types';
import { parseScript } from '../lib/sieve/parser';
import { generateScript, supportsSpamGuard, VACATION_SCRIPT_NAME } from '../lib/sieve/generator';
import { supportsPeriods } from '../lib/sieve/period';
import { isValidVacationForward, withVacationPeriod } from '../lib/sieve/vacation-forward';
import { isValidVacationAudience, normalizeVacationAudience } from '../lib/sieve/vacation-audience';
import {
  dependsOnCapabilities,
  OpaqueFiltersError,
  SieveCapabilitiesUnknownError,
  supportsInclude,
  writeFiltersScript,
} from '../lib/filters/account-filters';
import { worstCaseForwards } from '../lib/filters/forward-limit';
import { isCurrentScope, type OpScope } from '../api/op-scope';
import { isStaleLoad } from '../lib/network-error';
import {
  createSieveScript,
  getSieveCapabilities,
  getSieveScriptContent,
  getSieveScripts,
  isSieveSupported,
  sieveScope,
  sieveScopeIn,
  updateSieveScript,
  validateSieveScript,
} from '../api/sieve';

// Ported from the webmail's stores/filter-store.ts. The mobile client is a
// singleton (api/sieve drives `jmapClient` directly), so the actions drop the
// `client` argument the web store threads through; each load, save and sync
// instead takes one connection scope (`OpScope`) and runs every request on
// it, so none of them finishes on an account the app switched to.
// `selectedAccountId` is the Sieve account being edited: the user's own, or
// a shared/group account.

export { dependsOnCapabilities, SieveCapabilitiesUnknownError };

/** The filters on screen are not the ones loaded for this account (cleared, or never loaded). */
export class FiltersNotLoadedError extends Error {
  constructor() {
    super('The filters are not loaded');
    this.name = 'FiltersNotLoadedError';
  }
}

/**
 * A save met a connection that was replaced, while the same account is still
 * shown (a reconnect of the same login). Nothing was written; the filters
 * were loaded again on the live connection, so the change has to be made
 * again on what the server has now.
 */
export class FiltersReloadedError extends Error {
  constructor() {
    super('The filters were reloaded');
    this.name = 'FiltersReloadedError';
  }
}

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
  /** The vacation card's forwarding and reply audience, kept through every save. */
  vacationForward: VacationForward | null;
  vacationAudience: VacationAudience | null;
  selectedAccountId: string | null;

  fetchFilters: (accountId?: string) => Promise<void>;
  /**
   * Load another account's filters; null is the user's own Sieve account.
   * `stillShown` says whether the screen still shows the app account and
   * the managed account it was selected for: a save that meets a replaced
   * connection then reloads them (see FiltersReloadedError).
   */
  selectAccount: (accountId: string | null, stillShown?: () => boolean) => Promise<void>;
  /** Throws FiltersReloadedError when it met a reconnect and loaded the filters again. */
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

// Latest fetchFilters call per account: an older reply must not land after a
// newer one (a refetch after an Undo would bring the undone rule back).
const fetchGeneration = new Map<string, number>();

// Bumped whenever the store drops its account (clearState, selectAccount):
// a load or save from before belongs to an account no longer shown. Account
// ids repeat across logins, so the id alone does not tell them apart.
let storeEpoch = 0;
// The load the rules on screen came from: its epoch and its connection. A
// save goes out on that connection, in that epoch, or not at all: it would
// write an empty rule list, or one account's rules into another's script.
let loaded: { epoch: number; at: OpScope } | null = null;
// Whether what selectAccount was called for is still shown (see selectAccount).
let stillShown: (() => boolean) | null = null;

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
    // Every request of the load on the connection it started on.
    const at = sieveScope(requestedId);
    const resolvedId = at.accountId;
    set({ isLoading: true, error: null, isSupported: true, selectedAccountId: resolvedId });
    // A reply for an account the user already switched away from must not
    // land in the store: the next save would write it into the other account.
    const generation = (fetchGeneration.get(resolvedId) ?? 0) + 1;
    fetchGeneration.set(resolvedId, generation);
    const epoch = storeEpoch;
    const stale = () =>
      epoch !== storeEpoch || !isCurrentScope(at) ||
      get().selectedAccountId !== resolvedId || fetchGeneration.get(resolvedId) !== generation;
    try {
      const capabilities = getSieveCapabilities(at);
      set({ sieveCapabilities: capabilities });

      const allScripts = await getSieveScripts(at);
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
        loaded = { epoch, at };
        return;
      }

      set({ activeScriptId: activeScript.id });

      const content = await getSieveScriptContent(activeScript.blobId, at);
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
        vacationForward: result.vacationForward ?? null,
        vacationAudience: result.vacationAudience ?? null,
      });
      loaded = { epoch, at };
    } catch (error) {
      if (stale()) return;
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch filters',
      });
    }
  },

  selectAccount: async (accountId, shown) => {
    // Drop the previous account's script first so its rules never show (or
    // get saved) under the newly selected account while the fetch runs.
    storeEpoch++;
    stillShown = shown ?? null;
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
    const epoch = storeEpoch;
    try {
      const {
        isOpaque, rawScript, rules, activeScriptId, vacationSettings, externalRequires, includeVacation,
        vacationForward, vacationAudience, selectedAccountId, sieveCapabilities,
      } = get();
      if (!loaded || loaded.epoch !== epoch || loaded.at.accountId !== selectedAccountId) {
        throw new FiltersNotLoadedError();
      }
      // Without them the forwarding block and folder moves would lose their
      // spam guard, and moves their folder ids: wait for them instead.
      if (!isOpaque && !sieveCapabilities && dependsOnCapabilities(rules, vacationForward, includeVacation)) {
        throw new SieveCapabilitiesUnknownError();
      }
      // Both writes (upload and set) on the connection the rules came from.
      const { at } = loaded;

      const content = isOpaque
        ? rawScript
        : generateScript(rules, vacationSettings || undefined, {
          externalRequires,
          includeVacation,
          vacationForward,
          vacationAudience,
          extensions: sieveCapabilities?.sieveExtensions,
        });

      const written = await writeFiltersScript(at, content, activeScriptId);
      if (epoch !== storeEpoch) {
        set({ isSaving: false });
        return;
      }
      if (!activeScriptId) set({ activeScriptId: written.scriptId });

      set({ isSaving: false, rawScript: content });
    } catch (error) {
      if (epoch !== storeEpoch) {
        set({ isSaving: false });
        throw error;
      }
      // The connection the rules came from was replaced before the write
      // went out, and the screen still shows the same login and account:
      // load them again on the live one. Nothing is written there; the user
      // makes the change again on what the server has now.
      if (isStaleLoad(error) && stillShown?.()) {
        const before = loaded;
        await get().fetchFilters(get().selectedAccountId ?? undefined);
        // Only a reload that landed for the same screen asks for the change
        // again; otherwise this is a plain failure (rolled back by the caller).
        if (epoch === storeEpoch && loaded !== before && stillShown()) {
          set({ isSaving: false });
          throw new FiltersReloadedError();
        }
      }
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

  resetToVisualBuilder: () => set({
    isOpaque: false, rawScript: '', rules: [], externalRequires: [], vacationForward: null, vacationAudience: null,
  }),

  clearState: () => {
    storeEpoch++;
    loaded = null;
    stillShown = null;
    set({
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
    });
  },
}));

async function loadManagedScript(at: OpScope) {
  const scripts = await getSieveScripts(at);
  const vacationScript = scripts.find((s) => s.name === VACATION_SCRIPT_NAME);
  const filters = scripts.filter((s) => s.name !== VACATION_SCRIPT_NAME);
  const target = filters.find((s) => s.isActive) || filters[0];
  if (!target) return { vacationScript, target: undefined, parsed: undefined };
  const parsed = parseScript(await getSieveScriptContent(target.blobId, at));
  return { vacationScript, target, parsed: parsed.isOpaque ? undefined : parsed };
}

/** What the vacation card needs from the account's filters script. */
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
  /**
   * The most forwards the filter rules let one message collect (see
   * worstCaseForwards). Forwarding that keeps a copy runs ahead of them, so
   * it shares the server's redirect limit with these.
   */
  otherForwards: number;
  /**
   * Stalwart's own vacation script runs in place of the filters script, which
   * has rules that are on: none of them runs (a save cut short, a switch
   * mid-save, or a server that cannot include the auto-reply). Unlike
   * notRunning, this covers plain rules too.
   */
  filtersStopped: boolean;
  /**
   * The filters script was edited by hand, so Bulwark cannot include the
   * auto-reply in it: stopped filters must be restarted from the webmail or
   * the Filters settings, not by a save here.
   */
  filtersOpaque: boolean;
  /**
   * A save can restart stopped filters: the server has `include` and the
   * script is one Bulwark can read and write back. Otherwise they stay
   * paused while the auto-reply is on.
   */
  includeAvailable: boolean;
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

/**
 * The vacation card's part of Sieve account `accountId`'s filters script
 * (undefined: the user's own), read on the connection of `at` (taken now
 * when left out).
 */
export async function readVacationFilters(accountId: string | undefined, at?: OpScope): Promise<VacationFilters> {
  const scope = at ? sieveScopeIn(at, accountId) : sieveScope(accountId);
  const capabilities = getSieveCapabilities(scope);
  const { vacationScript, target, parsed } = await loadManagedScript(scope);
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
    otherForwards: worstCaseForwards(parsed?.rules ?? []),
    // A script edited by hand counts as having rules that are on.
    filtersStopped: !!vacationScript?.isActive && !!target && !target.isActive &&
      (parsed ? parsed.rules.some((r) => r.enabled) : true),
    filtersOpaque: !!target && !parsed,
    includeAvailable: filtersUsable,
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

/** What the vacation card asks of the filters script (see syncVacationWithFilters). */
export interface VacationSync {
  /** The auto-reply is on. */
  enabled: boolean;
  /** Replaces the stored forwarding: null removes it, undefined keeps it. */
  forward?: VacationForward | null;
  /** Replaces who gets the auto-reply: null is everyone, undefined keeps it. */
  audience?: VacationAudience | null;
  /** The vacation's period, which whatever forwarding there is keeps to. */
  period?: { from: string | null; until: string | null };
}

/**
 * The account's scripts and what the sync would make of them. Throws, before
 * anything is written, what cannot be stored: a change to a script edited by
 * hand, or without `include`, or forwarding or recipients the generator
 * would leave out (the save would look done while nothing forwards, or
 * everyone gets the reply).
 */
async function planVacationSync(sync: VacationSync, at: OpScope) {
  const capabilities = getSieveCapabilities(at);
  const canInclude = supportsInclude(capabilities);
  const { vacationScript, target, parsed } = await loadManagedScript(at);
  const opaque = !!target && !parsed;
  const storedForward = parsed?.vacationForward ?? null;
  const storedAudience = parsed?.vacationAudience ?? null;
  const requestedForward = sync.forward === undefined ? storedForward : sync.forward;
  let nextForward = requestedForward && sync.period
    ? withVacationPeriod(requestedForward, sync.period)
    : requestedForward;
  // Turning the auto-reply off is never refused: a stored forwarding that
  // cannot take the new dates (no `include`, or a date the generator cannot
  // write) keeps the period it has.
  if (!sync.enabled && sync.forward === undefined && !sameForward(storedForward, nextForward) &&
    (opaque || !canInclude || (nextForward && !isValidVacationForward(nextForward)))) {
    nextForward = storedForward;
  }
  const nextAudience = sync.audience === undefined ? storedAudience : sync.audience;
  const changed =
    !sameForward(storedForward, nextForward) ||
    !same(storedAudience, nextAudience, normalizeVacationAudience);

  if (changed) {
    // The card only offers these where they can be stored and run.
    if (opaque) throw new OpaqueFiltersError();
    if (!canInclude) throw new Error('Forwarding and reply recipients need the Sieve "include" extension');
    if (nextForward && !isValidVacationForward(nextForward)) throw new Error('Unusable vacation forwarding');
    if (nextAudience && !isValidVacationAudience(nextAudience)) throw new Error('Unusable vacation reply recipients');
  }
  return { capabilities, canInclude, vacationScript, target, parsed, opaque, nextForward, nextAudience, changed };
}

type VacationSyncPlan = Awaited<ReturnType<typeof planVacationSync>>;

/** Whether the sync rewrites a readable script, `enabled` saying whether the auto-reply is on. */
function syncWrites(plan: VacationSyncPlan, enabled: boolean): boolean {
  const { canInclude, vacationScript, target, parsed, nextForward, nextAudience, changed } = plan;
  if (enabled && !canInclude) return false;
  const rules = parsed?.rules ?? [];
  const forwarding = !!nextForward?.enabled;
  if (enabled) {
    // Act when the vacation script took over from filters that must keep
    // running, or when something changed. An auto-reply for some senders
    // only must run from the filters script: on its own it answers everyone.
    const tookOver = !!vacationScript?.isActive && !target?.isActive;
    const needsFilters = rules.length > 0 || forwarding || !!nextAudience;
    return changed || (tookOver && needsFilters);
  }
  // Forwarding also runs without the auto-reply, from an active filters
  // script; turning the auto-reply off can leave no script active.
  const forwardingIdle = forwarding && !target?.isActive;
  return changed || !!parsed?.includeVacation || forwardingIdle;
}

/** The sync would have to write a script it cannot generate without the server's capabilities. */
function lacksCapabilities(plan: VacationSyncPlan, enabled: boolean): boolean {
  return !plan.capabilities && dependsOnCapabilities(plan.parsed?.rules ?? [], plan.nextForward, enabled);
}

/**
 * Run before VacationResponse/set, with nothing written yet: throws what
 * `syncVacationWithFilters` would refuse once the response is saved. Also
 * refuses (OpaqueFiltersError) to turn the auto-reply on while a filters
 * script edited by hand is the active one: Stalwart would switch it off for
 * its own vacation script, and the script cannot take an `include` of it, so
 * every filter would stop. And it refuses (SieveCapabilitiesUnknownError) to
 * turn it on while the server's capabilities are unknown and the active
 * filters depend on them. `opaque`: the filters script was edited by hand,
 * so the sync after the save has nothing it may do.
 */
export async function checkVacationSync(sync: VacationSync, at: OpScope): Promise<{ opaque: boolean }> {
  const plan = await planVacationSync(sync, at);
  if (plan.opaque && sync.enabled && plan.target?.isActive) throw new OpaqueFiltersError();
  // Turning the auto-reply on while the capabilities are unknown: the
  // vacation script would take over from filters that cannot be generated
  // again (moves, copies, redirects, forwarding), so they would stop until
  // the capabilities are known. Turning it off is never refused.
  if (sync.enabled && !plan.opaque && !plan.capabilities && plan.target?.isActive &&
    dependsOnCapabilities(plan.parsed?.rules ?? [], plan.nextForward, false)) {
    throw new SieveCapabilitiesUnknownError();
  }
  return { opaque: plan.opaque };
}

/**
 * Keep the filters, the auto-reply and its forwarding running after
 * VacationResponse/set (webmail stores/filter-store.ts).
 *
 * Stalwart allows one active Sieve script and turns the auto-reply on by
 * activating its own "vacation" script, which switches every filter off.
 * When that happened, re-activate the filters script with an `include` of
 * the vacation script. When the auto-reply is turned off, drop the include.
 *
 * Forwarding runs with or without the auto-reply, but only from an active
 * filters script, so for it the script is activated even without rules, and
 * created when there is none. A script edited by hand is never rewritten:
 * when the sync would have to, it throws OpaqueFiltersError instead.
 *
 * `at` is the Sieve account's scope (see sieveScopeIn): every read and write
 * runs on its connection, so a switch stops it before it writes.
 */
export async function syncVacationWithFilters(sync: VacationSync, at: OpScope = sieveScope()): Promise<void> {
  const { enabled, forward, audience } = sync;
  if (enabled && !supportsInclude(getSieveCapabilities(at)) && forward === undefined && audience === undefined) return;

  const plan = await planVacationSync(sync, at);
  const { capabilities, vacationScript, target, parsed, opaque, nextForward, nextAudience } = plan;
  if (opaque) {
    // The vacation script took over from it, and it cannot include that.
    if (enabled && vacationScript?.isActive && !target?.isActive) throw new OpaqueFiltersError();
    return;
  }
  if (!syncWrites(plan, enabled)) return;
  // Only turning the auto-reply off gets here without capabilities (on, it
  // needs `include`): the include stays. It is `:optional`, and with the
  // response off it runs nothing, so nothing is lost.
  if (lacksCapabilities(plan, enabled)) return;

  const rules = parsed?.rules ?? [];
  const forwarding = !!nextForward?.enabled;
  const content = generateScript(rules, parsed?.vacation, {
    externalRequires: parsed?.externalRequires,
    includeVacation: enabled,
    vacationForward: nextForward,
    vacationAudience: nextAudience,
    extensions: capabilities?.sieveExtensions,
  });
  const activate = enabled || forwarding || !!target?.isActive;
  if (target) {
    await updateSieveScript(target.id, content, activate, at);
  } else {
    await createSieveScript('filters', content, activate, at);
  }

  const store = useFilterStore.getState();
  if (store.selectedAccountId === at.accountId && isCurrentScope(at)) {
    await store.fetchFilters(at.accountId);
  }
}
