import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createPersistStorage } from './persist-storage';
import { generateAccountId, MAX_ACCOUNTS } from '../lib/account-utils';
import { generateAvatarColor } from '../lib/avatar-utils';

export interface AccountEntry {
  id: string;
  serverUrl: string;
  username: string;
  displayName: string;
  email: string;
  avatarColor: string;
  lastLoginAt: number;
  isConnected: boolean;
  hasError: boolean;
  errorMessage?: string;
  isDefault: boolean;
  // JMAP primary account id (from the session's primaryAccounts). Recorded
  // when push is set up so a relay payload can be routed to this entry.
  jmapAccountId?: string;
}

interface AccountState {
  accounts: AccountEntry[];
  activeAccountId: string | null;
  defaultAccountId: string | null;

  addAccount: (entry: Omit<AccountEntry, 'id' | 'avatarColor' | 'isDefault'>) => string;
  removeAccount: (accountId: string) => void;
  setActiveAccount: (accountId: string) => void;
  setDefaultAccount: (accountId: string) => void;
  updateAccount: (accountId: string, updates: Partial<AccountEntry>) => void;
  // Persist a new display order (ids in the desired order; unknown ids are
  // ignored, missing ones keep their relative order at the end).
  reorderAccounts: (orderedIds: string[]) => void;
  getAccountById: (accountId: string) => AccountEntry | undefined;
  getActiveAccount: () => AccountEntry | null;
  getDefaultAccount: () => AccountEntry | null;
  hasAccount: (username: string, serverUrl: string) => boolean;
}

export const useAccountStore = create<AccountState>()(
  persist(
    (set, get) => ({
      accounts: [],
      activeAccountId: null,
      defaultAccountId: null,

      addAccount: (entry) => {
        const state = get();
        const id = generateAccountId(entry.username, entry.serverUrl);

        const existing = state.accounts.find((a) => a.id === id);
        if (existing) {
          set((s) => ({
            accounts: s.accounts.map((a) =>
              a.id === id
                ? {
                    ...a,
                    displayName: entry.displayName || a.displayName,
                    email: entry.email || a.email,
                    lastLoginAt: entry.lastLoginAt,
                    isConnected: entry.isConnected,
                    hasError: entry.hasError,
                    errorMessage: entry.errorMessage,
                  }
                : a,
            ),
          }));
          return id;
        }

        if (state.accounts.length >= MAX_ACCOUNTS) {
          throw new Error(`Maximum of ${MAX_ACCOUNTS} accounts reached`);
        }

        const isDefault = state.accounts.length === 0;
        const account: AccountEntry = {
          ...entry,
          id,
          avatarColor: generateAvatarColor(entry.email || entry.username),
          isDefault,
        };

        set((s) => ({
          accounts: [...s.accounts, account],
          activeAccountId: s.activeAccountId ?? id,
          defaultAccountId: isDefault ? id : s.defaultAccountId,
        }));

        return id;
      },

      removeAccount: (accountId) => {
        set((s) => {
          const remaining = s.accounts.filter((a) => a.id !== accountId);
          const wasDefault = s.defaultAccountId === accountId;
          const wasActive = s.activeAccountId === accountId;

          let newDefault = s.defaultAccountId;
          if (wasDefault) {
            newDefault = remaining[0]?.id ?? null;
            if (newDefault) {
              const idx = remaining.findIndex((a) => a.id === newDefault);
              if (idx >= 0) remaining[idx] = { ...remaining[idx], isDefault: true };
            }
          }

          return {
            accounts: remaining,
            activeAccountId: wasActive ? (remaining[0]?.id ?? null) : s.activeAccountId,
            defaultAccountId: newDefault,
          };
        });
      },

      setActiveAccount: (accountId) => {
        if (!get().accounts.find((a) => a.id === accountId)) return;
        set({ activeAccountId: accountId });
      },

      setDefaultAccount: (accountId) => {
        if (!get().accounts.find((a) => a.id === accountId)) return;
        set((s) => ({
          defaultAccountId: accountId,
          accounts: s.accounts.map((a) => ({ ...a, isDefault: a.id === accountId })),
        }));
      },

      updateAccount: (accountId, updates) => {
        set((s) => ({
          accounts: s.accounts.map((a) => (a.id === accountId ? { ...a, ...updates } : a)),
        }));
      },

      reorderAccounts: (orderedIds) => {
        set((s) => {
          const byId = new Map(s.accounts.map((a) => [a.id, a]));
          const next: AccountEntry[] = [];
          for (const id of orderedIds) {
            const entry = byId.get(id);
            if (entry && !next.includes(entry)) next.push(entry);
          }
          for (const a of s.accounts) {
            if (!next.includes(a)) next.push(a);
          }
          return { accounts: next };
        });
      },

      getAccountById: (accountId) => get().accounts.find((a) => a.id === accountId),
      getActiveAccount: () => {
        const s = get();
        return s.accounts.find((a) => a.id === s.activeAccountId) ?? null;
      },
      getDefaultAccount: () => {
        const s = get();
        if (s.defaultAccountId) {
          const found = s.accounts.find((a) => a.id === s.defaultAccountId);
          if (found) return found;
        }
        return s.accounts[0] ?? null;
      },
      hasAccount: (username, serverUrl) => {
        const id = generateAccountId(username, serverUrl);
        return get().accounts.some((a) => a.id === id);
      },
    }),
    {
      name: 'account-registry',
      // Tiny, rarely written, and read straight from AsyncStorage by the
      // headless push task, so it isn't held back like the caches.
      storage: createPersistStorage({ writeDelayMs: 0 }),
      partialize: (state) => ({
        accounts: state.accounts,
        activeAccountId: state.activeAccountId,
        defaultAccountId: state.defaultAccountId,
      }),
    },
  ),
);
