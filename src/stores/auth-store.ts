import { create } from 'zustand';
import { jmapClient, AuthenticationError } from '../api/jmap-client';
import type { JMAPSession } from '../api/types';
import { useAccountStore } from './account-store';
import { useEmailStore } from './email-store';
import { useContactsStore } from './contacts-store';
import { useCalendarStore } from './calendar-store';
import { generateAccountId } from '../lib/account-utils';

export interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  hasRestoredSession: boolean;
  error: string | null;
  serverUrl: string | null;
  username: string | null;
  session: JMAPSession | null;
  accountId: string | null;
  activeAccountId: string | null;
  client: typeof jmapClient | null;

  login: (serverUrl: string, username: string, password: string, opts?: { addAccount?: boolean }) => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  switchAccount: (accountId: string) => Promise<void>;
  restoreSession: () => Promise<boolean>;
  clearError: () => void;
}

function resetFeatureStores(): void {
  useEmailStore.getState().reset();
  useContactsStore.getState().reset();
  useCalendarStore.getState().reset();
}

function refetchFeatureStores(): void {
  // Fire-and-forget: each store handles its own errors.
  void useEmailStore.getState().fetchMailboxes();
  void useContactsStore.getState().fetchContacts();
  void useCalendarStore.getState().fetchCalendars();
}

function applyConnectedState(
  set: (partial: Partial<AuthState>) => void,
  session: JMAPSession,
  serverUrl: string,
  username: string,
  accountId: string,
): void {
  set({
    isAuthenticated: true,
    isLoading: false,
    hasRestoredSession: true,
    error: null,
    serverUrl,
    username,
    session,
    accountId: jmapClient.accountId,
    activeAccountId: accountId,
    client: jmapClient,
  });
}

export const useAuthStore = create<AuthState>((set, get) => ({
  isAuthenticated: false,
  isLoading: false,
  hasRestoredSession: false,
  error: null,
  serverUrl: null,
  username: null,
  session: null,
  accountId: null,
  activeAccountId: null,
  client: null,

  login: async (serverUrl, username, password, opts) => {
    set({ isLoading: true, error: null });
    try {
      // Adding an additional account — snapshot/reset feature stores so the
      // new account starts with a clean slate.
      if (opts?.addAccount && get().isAuthenticated) {
        jmapClient.reset();
        resetFeatureStores();
      }

      const session = await jmapClient.connect(serverUrl, username, password);
      const accountId = generateAccountId(username, serverUrl.replace(/\/+$/, ''));

      const accountStore = useAccountStore.getState();
      accountStore.addAccount({
        serverUrl: serverUrl.replace(/\/+$/, ''),
        username,
        displayName: username,
        email: username,
        lastLoginAt: Date.now(),
        isConnected: true,
        hasError: false,
      });
      accountStore.setActiveAccount(accountId);

      applyConnectedState(set, session, serverUrl.replace(/\/+$/, ''), username, accountId);
    } catch (err) {
      const message = err instanceof AuthenticationError
        ? 'Invalid username or password'
        : err instanceof Error
          ? err.message
          : 'Connection failed';
      set({ isLoading: false, error: message });
      throw err;
    }
  },

  logout: async () => {
    const accountStore = useAccountStore.getState();
    const currentId = get().activeAccountId;

    // Clear credentials for this account first
    if (currentId) {
      await jmapClient.clearAccountCredentials(currentId);
      accountStore.removeAccount(currentId);
    } else {
      await jmapClient.logout();
    }

    jmapClient.reset();
    resetFeatureStores();

    // Switch to next remaining account, if any
    const remaining = accountStore.accounts;
    if (remaining.length > 0) {
      const next = accountStore.getDefaultAccount() ?? remaining[0];
      try {
        await get().switchAccount(next.id);
        return;
      } catch {
        // fall through to full logout below
      }
    }

    set({
      isAuthenticated: false,
      isLoading: false,
      hasRestoredSession: true,
      error: null,
      serverUrl: null,
      username: null,
      session: null,
      accountId: null,
      activeAccountId: null,
      client: null,
    });
  },

  logoutAll: async () => {
    const accountStore = useAccountStore.getState();
    const ids = accountStore.accounts.map((a) => a.id);
    await jmapClient.clearAllCredentials(ids);
    jmapClient.reset();
    resetFeatureStores();

    for (const id of ids) accountStore.removeAccount(id);

    set({
      isAuthenticated: false,
      isLoading: false,
      hasRestoredSession: true,
      error: null,
      serverUrl: null,
      username: null,
      session: null,
      accountId: null,
      activeAccountId: null,
      client: null,
    });
  },

  switchAccount: async (accountId) => {
    if (get().activeAccountId === accountId) return;

    const accountStore = useAccountStore.getState();
    const target = accountStore.getAccountById(accountId);
    if (!target) return;

    set({ isLoading: true, error: null });

    jmapClient.reset();
    resetFeatureStores();

    const ok = await jmapClient.loadAccount(accountId);
    if (!ok) {
      // Credentials missing — evict stale entry and surface error
      accountStore.removeAccount(accountId);
      set({ isLoading: false, error: 'Session expired for this account' });
      return;
    }

    accountStore.setActiveAccount(accountId);
    accountStore.updateAccount(accountId, {
      isConnected: true,
      hasError: false,
      errorMessage: undefined,
      lastLoginAt: Date.now(),
    });

    const session = jmapClient.currentSession;
    if (!session) {
      set({ isLoading: false, error: 'Failed to load session' });
      return;
    }

    applyConnectedState(set, session, target.serverUrl, target.username, accountId);
    refetchFeatureStores();
  },

  restoreSession: async () => {
    set({ isLoading: true });
    try {
      const accountStore = useAccountStore.getState();

      // Legacy migration: if there are no registered accounts but the old
      // single-slot credentials exist, register them before restoring.
      if (accountStore.accounts.length === 0) {
        const legacy = await jmapClient.consumeLegacyCredentials();
        if (legacy) {
          accountStore.addAccount({
            serverUrl: legacy.serverUrl,
            username: legacy.username,
            displayName: legacy.username,
            email: legacy.username,
            lastLoginAt: Date.now(),
            isConnected: false,
            hasError: false,
          });
          const id = generateAccountId(legacy.username, legacy.serverUrl);
          accountStore.setActiveAccount(id);
        }
      }

      const target = accountStore.getActiveAccount() ?? accountStore.getDefaultAccount();
      if (!target) {
        set({ isLoading: false, hasRestoredSession: true });
        return false;
      }

      const ok = await jmapClient.loadAccount(target.id);
      if (!ok) {
        accountStore.removeAccount(target.id);
        set({ isLoading: false, hasRestoredSession: true });
        return false;
      }

      accountStore.setActiveAccount(target.id);
      accountStore.updateAccount(target.id, { isConnected: true, hasError: false });

      const session = jmapClient.currentSession!;
      applyConnectedState(set, session, target.serverUrl, target.username, target.id);
      return true;
    } catch {
      set({ isLoading: false, hasRestoredSession: true });
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));
