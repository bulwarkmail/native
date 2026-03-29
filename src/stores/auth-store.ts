import { create } from 'zustand';
import { jmapClient, AuthenticationError } from '../api/jmap-client';
import type { JMAPSession } from '../api/types';

export interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  hasRestoredSession: boolean;
  error: string | null;
  serverUrl: string | null;
  username: string | null;
  session: JMAPSession | null;
  accountId: string | null;
  client: typeof jmapClient | null;

  login: (serverUrl: string, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  restoreSession: () => Promise<boolean>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  isLoading: false,
  hasRestoredSession: false,
  error: null,
  serverUrl: null,
  username: null,
  session: null,
  accountId: null,
  client: null,

  login: async (serverUrl, username, password) => {
    set({ isLoading: true, error: null });
    try {
      const session = await jmapClient.connect(serverUrl, username, password);
      set({
        isAuthenticated: true,
        isLoading: false,
        hasRestoredSession: true,
        serverUrl,
        username,
        session,
        accountId: jmapClient.accountId,
        client: jmapClient,
      });
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
    await jmapClient.logout();
    set({
      isAuthenticated: false,
      isLoading: false,
      hasRestoredSession: true,
      error: null,
      serverUrl: null,
      username: null,
      session: null,
      accountId: null,
      client: null,
    });
  },

  restoreSession: async () => {
    set({ isLoading: true });
    try {
      const restored = await jmapClient.restoreSession();
      if (restored) {
        set({
          isAuthenticated: true,
          isLoading: false,
          hasRestoredSession: true,
          session: jmapClient.currentSession,
          accountId: jmapClient.accountId,
          client: jmapClient,
        });
      } else {
        set({ isLoading: false, hasRestoredSession: true });
      }
      return restored;
    } catch {
      set({ isLoading: false, hasRestoredSession: true });
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));
