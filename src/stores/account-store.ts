import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        accounts: state.accounts,
        activeAccountId: state.activeAccountId,
        defaultAccountId: state.defaultAccountId,
      }),
    },
  ),
);
