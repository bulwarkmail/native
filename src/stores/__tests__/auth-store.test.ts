import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-secure-store', () => ({
  setItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    connect: vi.fn(),
    logout: vi.fn(),
    restoreSession: vi.fn(),
    accountId: 'acc-1',
    currentSession: { apiUrl: 'https://mail.example.com/jmap/' },
  },
  AuthenticationError: class AuthenticationError extends Error {
    constructor(msg: string) { super(msg); this.name = 'AuthenticationError'; }
  },
}));

import { jmapClient } from '../../api/jmap-client';
import { useAuthStore } from '../auth-store';

const mockConnect = jmapClient.connect as ReturnType<typeof vi.fn>;
const mockLogout = jmapClient.logout as ReturnType<typeof vi.fn>;
const mockRestore = jmapClient.restoreSession as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Reset store state
  useAuthStore.setState({
    isAuthenticated: false,
    isLoading: false,
    error: null,
    serverUrl: null,
    username: null,
    session: null,
    accountId: null,
  });
});

describe('auth-store', () => {
  describe('login', () => {
    it('should set authenticated state on success', async () => {
      const session = { apiUrl: 'https://mail.example.com/jmap/' };
      mockConnect.mockResolvedValue(session);

      await useAuthStore.getState().login('https://mail.example.com', 'user', 'pass');

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(true);
      expect(state.isLoading).toBe(false);
      expect(state.serverUrl).toBe('https://mail.example.com');
      expect(state.username).toBe('user');
      expect(state.session).toEqual(session);
      expect(state.accountId).toBe('acc-1');
    });

    it('should set error on failure', async () => {
      mockConnect.mockRejectedValue(new Error('Connection refused'));

      await expect(
        useAuthStore.getState().login('https://fail.com', 'user', 'pass'),
      ).rejects.toThrow();

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBe('Connection refused');
    });

    it('should set friendly message for AuthenticationError', async () => {
      const { AuthenticationError } = await import('../../api/jmap-client');
      mockConnect.mockRejectedValue(new AuthenticationError('Invalid'));

      await expect(
        useAuthStore.getState().login('https://mail.example.com', 'user', 'bad'),
      ).rejects.toThrow();

      expect(useAuthStore.getState().error).toBe('Invalid username or password');
    });
  });

  describe('logout', () => {
    it('should reset all state', async () => {
      useAuthStore.setState({ isAuthenticated: true, serverUrl: 'x', username: 'y' });
      mockLogout.mockResolvedValue(undefined);

      await useAuthStore.getState().logout();

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state.serverUrl).toBeNull();
      expect(state.username).toBeNull();
    });
  });

  describe('restoreSession', () => {
    it('should restore on success', async () => {
      mockRestore.mockResolvedValue(true);

      const restored = await useAuthStore.getState().restoreSession();

      expect(restored).toBe(true);
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
    });

    it('should return false when no session to restore', async () => {
      mockRestore.mockResolvedValue(false);

      const restored = await useAuthStore.getState().restoreSession();

      expect(restored).toBe(false);
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });
  });

  describe('clearError', () => {
    it('should clear the error', () => {
      useAuthStore.setState({ error: 'Some error' });
      useAuthStore.getState().clearError();
      expect(useAuthStore.getState().error).toBeNull();
    });
  });
});
