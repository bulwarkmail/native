import { create } from 'zustand';
import { classifyArchiveError, type ArchiveQueryPage } from './archived-items';

/**
 * Whether "Recover deleted items" works for an account (webmail
 * stores/recovery-store.ts), asked once per app run and account with a
 * one-item x:ArchivedItem/query. The answer can change while the app runs
 * (an admin installs the license, or it runs out), so a "no" is asked again
 * after a while. Separately, whether the archive holds a recent message,
 * which decides the Trash link.
 */

/** A server that said no (no license, not Stalwart) is asked again after this. */
export const UNSUPPORTED_RETRY_MS = 30 * 60_000;
/** An error that says nothing about the server (offline, a server error) is asked again sooner. */
export const ERROR_RETRY_MS = 2 * 60_000;
/** How long the Trash link trusts its look at the archive. */
export const RECENT_TTL_MS = 5 * 60_000;

export interface RecoveryCheck {
  supported: boolean;
  /** When to ask again; null while supported, Infinity when it never changes. */
  retryAt: number | null;
}

export interface RecentCheck {
  has: boolean;
  days: number;
  checkedAt: number;
}

/** The parts of src/api/archived-items the store asks, for one account. */
export interface RecoveryClient {
  advertisesArchivedItems: () => boolean;
  queryArchivedItemIds: (options: { limit?: number }) => Promise<ArchiveQueryPage>;
  hasArchivedEmail: (options: { days?: number }) => Promise<boolean>;
}

interface RecoveryState {
  checks: Record<string, RecoveryCheck>;
  recent: Record<string, RecentCheck>;
  /** Asks the server unless a fresh answer is cached; resolves to whether it works. */
  detect: (client: RecoveryClient, key: string, options?: { force?: boolean }) => Promise<boolean>;
  /** Records what a list or restore call learned, so the page and the Trash link agree. */
  record: (key: string, outcome: 'supported' | 'unsupported' | 'error') => void;
  /** Whether the archive holds a message inside the days window, for the Trash link. */
  checkRecent: (client: RecoveryClient, key: string, days: number) => Promise<boolean>;
  /** The archive changed (a restore): look again next time. */
  forgetRecent: (key: string) => void;
  reset: () => void;
}

const inFlight = new Map<string, Promise<boolean>>();
const recentInFlight = new Map<string, Promise<boolean>>();

function checkFor(outcome: 'supported' | 'unsupported' | 'error', now: number): RecoveryCheck {
  if (outcome === 'supported') return { supported: true, retryAt: null };
  return { supported: false, retryAt: now + (outcome === 'unsupported' ? UNSUPPORTED_RETRY_MS : ERROR_RETRY_MS) };
}

/** The cache key: the signed-in login and the JMAP account in it. */
export function recoveryKey(localAccountId: string | null | undefined, jmapAccountId: string): string {
  return `${localAccountId ?? ''}|${jmapAccountId}`;
}

export const useRecoveryStore = create<RecoveryState>()((set, get) => ({
  checks: {},
  recent: {},

  detect: (client, key, options) => {
    const cached = get().checks[key];
    if (!options?.force && cached && (cached.supported || (cached.retryAt ?? 0) > Date.now())) {
      return Promise.resolve(cached.supported);
    }
    if (!client.advertisesArchivedItems()) {
      // Not Stalwart: nothing will change while the session lasts.
      set((state) => ({ checks: { ...state.checks, [key]: { supported: false, retryAt: Infinity } } }));
      return Promise.resolve(false);
    }
    const running = inFlight.get(key);
    if (running) return running;
    const probe = client.queryArchivedItemIds({ limit: 1 })
      .then(() => 'supported' as const)
      .catch((error: unknown) => classifyArchiveError(error))
      .then((outcome) => {
        get().record(key, outcome);
        return outcome === 'supported';
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, probe);
    return probe;
  },

  record: (key, outcome) => {
    set((state) => ({ checks: { ...state.checks, [key]: checkFor(outcome, Date.now()) } }));
  },

  checkRecent: (client, key, days) => {
    const cached = get().recent[key];
    if (cached && cached.days === days && Date.now() - cached.checkedAt < RECENT_TTL_MS) return Promise.resolve(cached.has);
    const flightKey = `${key}|${days}`;
    const running = recentInFlight.get(flightKey);
    if (running) return running;
    const look = client.hasArchivedEmail({ days })
      .catch((error: unknown) => {
        if (classifyArchiveError(error) === 'unsupported') get().record(key, 'unsupported');
        return false;
      })
      .then((has) => {
        set((state) => ({ recent: { ...state.recent, [key]: { has, days, checkedAt: Date.now() } } }));
        return has;
      })
      .finally(() => recentInFlight.delete(flightKey));
    recentInFlight.set(flightKey, look);
    return look;
  },

  forgetRecent: (key) => {
    set((state) => {
      const recent = { ...state.recent };
      delete recent[key];
      return { recent };
    });
  },

  reset: () => {
    inFlight.clear();
    recentInFlight.clear();
    set({ checks: {}, recent: {} });
  },
}));
