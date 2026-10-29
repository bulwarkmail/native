import { create } from 'zustand';
import {
  getVacationResponse,
  setVacationResponse,
  isVacationSupported,
  type VacationResponse,
} from '../api/vacation';
import { isSieveSupported } from '../api/sieve';
import { jmapClient } from '../api/jmap-client';
import { servedLoginOf } from '../lib/draft-login';
import type { VacationAudience, VacationForward } from '../lib/sieve/types';
import { withVacationPeriod } from '../lib/sieve/vacation-forward';
import { readVacationFilters, syncVacationWithFilters, type VacationFilters } from './filter-store';

/** What the vacation card sets for forwarding; the period comes from the vacation. */
export type VacationForwardSettings = Pick<VacationForward, 'enabled' | 'to' | 'keepCopy'>;

/**
 * The vacation response was saved, but what the filters script carries for
 * it (forwarding, who gets the auto-reply) was not: forwarding may not run
 * or still run, and the auto-reply may go to the wrong senders.
 */
export class VacationFiltersError extends Error {
  /**
   * The auto-reply was turned on and the filters script could not be made
   * to run next to it: Stalwart's vacation script took over, and no filter
   * runs until the card is saved again.
   */
  readonly filtersOff: boolean;

  constructor(cause: unknown, filtersOff = false) {
    super(cause instanceof Error ? cause.message : 'Failed to save the forwarding');
    this.name = 'VacationFiltersError';
    this.filtersOff = filtersOff;
  }
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
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  isSupported: boolean;
  hasLoaded: boolean;
  /** Account the responder belongs to: null for the user's own, else a shared/group account. */
  accountId: string | null;

  fetch: (accountId?: string) => Promise<void>;
  /**
   * Saves the out-of-office reply. Throws VacationFiltersError when only the
   * filters script part (forwarding, recipients) could not be saved.
   */
  save: (updates: Partial<Omit<VacationResponse, 'id'>> & {
    /** null removes the forwarding, leaving it out keeps it as it is. */
    forward?: VacationForwardSettings | null;
    /** null lets everyone have the auto-reply, leaving it out keeps it as it is. */
    audience?: VacationAudience | null;
  }) => Promise<void>;
  reset: () => void;
}

const NO_FILTERS = {
  forward: null,
  forwardAvailable: false,
  audience: null,
  audienceAvailable: false,
  notRunning: false,
};

const INITIAL = {
  accountId: null,
  isEnabled: false,
  fromDate: null,
  toDate: null,
  subject: '',
  textBody: '',
  htmlBody: null,
  ...NO_FILTERS,
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
  };
}

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
      let filters: VacationFilters | null = null;
      if (isSieveSupported(accountId)) {
        filters = await readVacationFilters(accountId).catch(() => null);
        if (stale()) return;
        // Running from the filters script leaves the vacation script itself
        // inactive, so VacationResponse reports it as off.
        if (filters) isEnabled = isEnabled || filters.includesVacation;
      }
      set({
        isEnabled,
        fromDate: vacation.fromDate,
        toDate: vacation.toDate,
        subject: vacation.subject ?? '',
        textBody: vacation.textBody ?? '',
        htmlBody: vacation.htmlBody,
        ...NO_FILTERS,
        ...(filters ? fromFilters(filters) : {}),
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
    const { forward: forwardSettings, audience, ...vacationUpdates } = updates;
    const accountId = get().accountId ?? undefined;
    // The client serves one login at a time, and account ids repeat across
    // logins: after a switch, the sync below would write this login's
    // forwarding, recipients and period into the other login's filters.
    const login = servedLoginOf(jmapClient);
    const loginChanged = () => servedLoginOf(jmapClient) !== login;
    // What the save leaves in the store is dropped once another account took over.
    const superseded = () => (get().accountId ?? undefined) !== accountId || loginChanged();
    set({ isSaving: true, error: null });
    try {
      await setVacationResponse(vacationUpdates, accountId);
    } catch (err) {
      set({
        isSaving: false,
        error: err instanceof Error ? err.message : 'Failed to save vacation responder',
      });
      throw err;
    }

    // Forwarding runs in the vacation's period, so it takes the dates along.
    const state = get();
    const fromDate = vacationUpdates.fromDate !== undefined ? vacationUpdates.fromDate : state.fromDate;
    const toDate = vacationUpdates.toDate !== undefined ? vacationUpdates.toDate : state.toDate;
    const period = { from: fromDate, until: toDate };

    let filtersError: VacationFiltersError | null = null;
    let filtersState: Partial<VacationState> = {};
    const needsSync = vacationUpdates.isEnabled !== undefined || forwardSettings !== undefined || audience !== undefined;
    const enabled = vacationUpdates.isEnabled ?? state.isEnabled;
    // Turning the auto-reply on activates Stalwart's vacation script, which
    // switches the filters off until the sync includes it in them again.
    const turnedOn = vacationUpdates.isEnabled === true;
    if (needsSync && loginChanged()) {
      set({ isSaving: false });
      throw new VacationFiltersError(new Error('Another account took over before the filters were updated'), turnedOn);
    }
    if (needsSync && isSieveSupported(accountId)) {
      let synced = false;
      try {
        await syncVacationWithFilters(enabled, accountId, forwardSettings, audience, period, login);
        synced = true;
      } catch (err) {
        console.warn('[vacation] Failed to keep filters active next to the vacation response:', err);
        // Forwarding that is or was on may now not run, or still run; an
        // auto-reply meant for some senders may go to everyone, or the other
        // way round; the filters may be off.
        if (turnedOn || forwardSettings?.enabled || state.forward?.enabled || audience || state.audience) {
          filtersError = new VacationFiltersError(err, turnedOn);
        }
      }
      // The filters read below would be the other login's.
      if (loginChanged()) {
        set({ isSaving: false });
        if (filtersError) throw filtersError;
        return;
      }
      // What the filters script holds now, and whether it runs. After a
      // failed save the card keeps what the user set, to save it again.
      const filters = await readVacationFilters(accountId).catch(() => null);
      if (filters) {
        filtersState = synced ? fromFilters(filters) : { notRunning: filters.notRunning };
      } else if (synced) {
        filtersState = {
          ...(forwardSettings !== undefined
            ? { forward: forwardSettings && withVacationPeriod(forwardSettings, period) }
            : {}),
          ...(audience !== undefined ? { audience } : {}),
          notRunning: false,
        };
      }
    }

    set((s) => (superseded()
      ? { ...s, isSaving: false }
      : { ...s, ...vacationUpdates, ...filtersState, isSaving: false }));
    // The reply itself is saved even when its filters part failed.
    if (filtersError) throw filtersError;
  },

  reset: () => set({ ...INITIAL }),
}));
