import { create } from 'zustand';
import {
  getVacationResponse,
  setVacationResponse,
  isVacationSupported,
  type VacationResponse,
} from '../api/vacation';
import { isSieveSupported, sieveScopeIn } from '../api/sieve';
import { isCurrentScope, type OpScope } from '../api/op-scope';
import type { VacationAudience, VacationForward } from '../lib/sieve/types';
import { isValidVacationForward, withVacationPeriod } from '../lib/sieve/vacation-forward';
import { isValidVacationAudience } from '../lib/sieve/vacation-audience';
import { isStaleLoad } from '../lib/network-error';
import {
  checkVacationSync,
  readVacationFilters,
  syncVacationWithFilters,
  type VacationFilters,
} from './filter-store';
import { isShownAccount, requireShownAccountScope, useEmailStore } from './email-store';
import { t } from './locale-store';
import { vacationErrorMessage } from '../lib/vacation-form';

/** What the vacation card sets for forwarding; the period comes from the vacation. */
export type VacationForwardSettings = Pick<VacationForward, 'enabled' | 'to' | 'keepCopy'>;

/**
 * The vacation response was saved, but what the filters script carries for
 * it was not: the filters may have stopped next to the auto-reply,
 * forwarding may not run or still run, and the auto-reply may go to the
 * wrong senders.
 */
export class VacationFiltersError extends Error {
  /** What the filters part failed with. */
  readonly reason: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'filters_save_error');
    this.name = 'VacationFiltersError';
    this.reason = cause;
  }
}

export interface VacationSaveUpdates extends Partial<Omit<VacationResponse, 'id'>> {
  /** null removes the forwarding, leaving it out keeps it as it is. */
  forward?: VacationForwardSettings | null;
  /** null lets everyone have the auto-reply, leaving it out keeps it as it is. */
  audience?: VacationAudience | null;
}

export interface VacationState {
  isEnabled: boolean;
  fromDate: string | null;
  toDate: string | null;
  subject: string;
  textBody: string;
  htmlBody: string | null;
  /** Forwarding as stored in the filters script; null when none is set up. */
  forward: VacationForward | null;
  /** The account's filters script can carry forwarding (see readVacationFilters). */
  forwardAvailable: boolean;
  /** Who gets the auto-reply as stored; null when everyone does. */
  audience: VacationAudience | null;
  /** The auto-reply can be narrowed to some senders (see readVacationFilters). */
  audienceAvailable: boolean;
  /** Stored forwarding or recipients do not run until the card is saved (see readVacationFilters). */
  notRunning: boolean;
  /** The most forwards the filter rules let one message collect (see readVacationFilters). */
  otherForwards: number;
  /** Stalwart's vacation script runs in place of filters that have rules on (see readVacationFilters). */
  filtersStopped: boolean;
  /** The filters script was edited by hand (see readVacationFilters). */
  filtersOpaque: boolean;
  /** A save can run the filters next to the auto-reply (see readVacationFilters). */
  includeAvailable: boolean;
  isLoading: boolean;
  isSaving: boolean;
  /** Why the last load or save failed, translated (see vacationErrorMessage). */
  error: string | null;
  isSupported: boolean;
  hasLoaded: boolean;
  /** App account (login) the responder was loaded for; null before a load. */
  appAccountId: string | null;
  /** Account the responder belongs to: null for the user's own, else a shared/group account. */
  accountId: string | null;

  fetch: (accountId?: string) => Promise<void>;
  /** Throws VacationFiltersError when only the filters script part could not be saved. */
  save: (updates: VacationSaveUpdates) => Promise<void>;
  reset: () => void;
}

const FILTERS_INITIAL = {
  forward: null,
  forwardAvailable: false,
  audience: null,
  audienceAvailable: false,
  notRunning: false,
  otherForwards: 0,
  filtersStopped: false,
  filtersOpaque: false,
  includeAvailable: false,
};

const INITIAL = {
  appAccountId: null,
  accountId: null,
  isEnabled: false,
  fromDate: null,
  toDate: null,
  subject: '',
  textBody: '',
  htmlBody: null,
  ...FILTERS_INITIAL,
  isLoading: false,
  isSaving: false,
  error: null,
  isSupported: false,
  hasLoaded: false,
};

/** The card's part of what the filters script holds. */
function fromFilters(filters: VacationFilters) {
  return {
    forward: filters.forward,
    forwardAvailable: filters.forwardAvailable,
    audience: filters.audience,
    audienceAvailable: filters.audienceAvailable,
    notRunning: filters.notRunning,
    otherForwards: filters.otherForwards,
    filtersStopped: filters.filtersStopped,
    filtersOpaque: filters.filtersOpaque,
    includeAvailable: filters.includeAvailable,
  };
}

/** Whether the filters run, which a failed save changes while the card keeps what the user set. */
function runState(filters: VacationFilters) {
  return {
    notRunning: filters.notRunning,
    filtersStopped: filters.filtersStopped,
    filtersOpaque: filters.filtersOpaque,
    includeAvailable: filters.includeAvailable,
  };
}

// The store holds one login's (app account's) responder, of its own account
// or a managed one. Each change of either, and reset() (an account switch),
// bumps the epoch; each load bumps the generation. Either outdates the loads
// and saves before it: their answers must not land in the card on screen,
// where saving would write them to this account. JMAP account ids repeat
// across logins, so they alone never tell two accounts apart.
let storeEpoch = 0;
let loadGeneration = 0;

export const useVacationStore = create<VacationState>((set, get) => ({
  ...INITIAL,

  fetch: async (accountId) => {
    const managed = accountId ?? null;
    const appAccountId = useEmailStore.getState().activeAccountId ?? null;
    // Switching accounts starts from a blank form rather than showing (and
    // letting the user save) the previous account's responder.
    if (get().appAccountId !== appAccountId || get().accountId !== managed) {
      storeEpoch++;
      set({ ...INITIAL, appAccountId, accountId: managed });
    }
    const generation = ++loadGeneration;
    const epoch = storeEpoch;
    set({ isLoading: true, error: null, isSupported: isVacationSupported(accountId) });

    let at: OpScope;
    try {
      // The connection serving the account shown, for every request of the load.
      at = requireShownAccountScope(appAccountId, accountId);
    } catch (err) {
      set({ isLoading: false, error: vacationErrorMessage(err, t) });
      return;
    }
    // A reply for an account the user already switched away from is dropped.
    const stale = () =>
      generation !== loadGeneration || epoch !== storeEpoch || !isCurrentScope(at) || !isShownAccount(appAccountId);
    try {
      const vacation = await getVacationResponse(at);
      let isEnabled = vacation.isEnabled;
      let filters: VacationFilters | null = null;
      if (isSieveSupported(accountId)) {
        filters = await readVacationFilters(accountId, at).catch(() => null);
        // Running from the filters script leaves the vacation script itself
        // inactive, so VacationResponse reports it as off.
        if (filters) isEnabled = isEnabled || filters.includesVacation;
      }
      if (stale()) return;
      set({
        isEnabled,
        fromDate: vacation.fromDate,
        toDate: vacation.toDate,
        subject: vacation.subject ?? '',
        textBody: vacation.textBody ?? '',
        htmlBody: vacation.htmlBody,
        ...FILTERS_INITIAL,
        ...(filters ? fromFilters(filters) : {}),
        isLoading: false,
        hasLoaded: true,
      });
    } catch (err) {
      if (stale()) return;
      set({
        isLoading: false,
        hasLoaded: true,
        error: vacationErrorMessage(err, t),
      });
    }
  },

  save: async (updates) => {
    const state = get();
    const managed = state.accountId ?? undefined;
    // The save goes to the account the form was loaded for, on the connection
    // serving it now; refused once the app shows another account.
    const at = requireShownAccountScope(state.appAccountId, managed);
    const generation = loadGeneration;
    const epoch = storeEpoch;
    const superseded = () =>
      generation !== loadGeneration || epoch !== storeEpoch || !isShownAccount(state.appAccountId);
    set({ isSaving: true, error: null });
    const { forward: forwardSettings, audience, ...vacationUpdates } = updates;

    // Forwarding runs in the vacation's period, so it takes the dates along.
    const fromDate = vacationUpdates.fromDate !== undefined ? vacationUpdates.fromDate : state.fromDate;
    const toDate = vacationUpdates.toDate !== undefined ? vacationUpdates.toDate : state.toDate;
    const period = { from: fromDate, until: toDate };
    const sync = {
      enabled: vacationUpdates.isEnabled ?? state.isEnabled,
      forward: forwardSettings === undefined ? undefined : forwardSettings && withVacationPeriod(forwardSettings, period),
      audience,
      period,
    };
    const needsSync = vacationUpdates.isEnabled !== undefined || forwardSettings !== undefined || audience !== undefined;
    const withSieve = needsSync && isSieveSupported(managed);
    const sieveAt = sieveScopeIn(at, managed);

    let skipSync = false;
    try {
      // Nothing is written until the filters part is known to go through: a
      // forward the generator would leave out, or a hand-edited filters
      // script the auto-reply would switch off, is refused here.
      if (sync.forward && !isValidVacationForward(sync.forward)) throw new Error('Unusable vacation forwarding');
      if (sync.audience && !isValidVacationAudience(sync.audience)) throw new Error('Unusable vacation reply recipients');
      if (withSieve) skipSync = (await checkVacationSync(sync, sieveAt)).opaque;
      await setVacationResponse(vacationUpdates, at);
    } catch (err) {
      set(superseded()
        ? { isSaving: false }
        : { isSaving: false, error: vacationErrorMessage(err, t) });
      throw err;
    }

    let filtersError: VacationFiltersError | null = null;
    let filtersState: Partial<VacationState> = {};
    if (withSieve && !skipSync) {
      let synced = false;
      let readAt = at;
      try {
        try {
          await syncVacationWithFilters(sync, sieveAt);
        } catch (err) {
          // The connection was replaced, but the account is still the one
          // shown (a reconnect of the same login): the response is saved and
          // the filters may be stopped, so try once more on the live
          // connection. The sync reads the scripts afresh before it writes.
          if (!isStaleLoad(err) || superseded()) throw err;
          readAt = requireShownAccountScope(state.appAccountId, managed);
          await syncVacationWithFilters(sync, sieveScopeIn(readAt, managed));
        }
        synced = true;
      } catch (err) {
        // A stale stop for an account no longer shown wrote nothing more, and
        // the card belongs to another account now; anything else is told.
        if (!isStaleLoad(err) || !superseded()) {
          console.warn('[vacation] Failed to keep filters active next to the vacation response:', err);
          filtersError = new VacationFiltersError(err);
        }
      }
      // What the filters script holds now, and whether it runs. After a
      // failed save the card keeps what the user set, to save it again.
      const filters = await readVacationFilters(managed, readAt).catch(() => null);
      if (filters) {
        filtersState = synced ? fromFilters(filters) : runState(filters);
      } else if (synced) {
        filtersState = {
          ...(forwardSettings !== undefined ? { forward: sync.forward ?? null } : {}),
          ...(audience !== undefined ? { audience } : {}),
          notRunning: false,
        };
      }
    }

    set((current) => (superseded()
      ? { ...current, isSaving: false }
      : { ...current, ...vacationUpdates, ...filtersState, isSaving: false }));
    if (filtersError && !superseded()) throw filtersError;
  },

  reset: () => {
    storeEpoch++;
    set({ ...INITIAL });
  },
}));
