import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    connect: vi.fn(),
    logout: vi.fn(),
    restoreSession: vi.fn(),
    loadAccount: vi.fn(),
    consumeLegacyCredentials: vi.fn(async () => null),
    clearAccountCredentials: vi.fn(async () => undefined),
    clearAllCredentials: vi.fn(async () => undefined),
    reset: vi.fn(),
    snapshot: vi.fn(() => ({ session: null, credentials: null, accountId: null })),
    restoreSnapshot: vi.fn(),
    onAuthFailure: vi.fn(() => () => undefined),
    onTokenRefresh: vi.fn(() => () => undefined),
    hasAccountCapability: vi.fn(() => false),
    request: vi.fn(async () => { throw new Error('not mocked'); }),
    getStoredOAuthTokens: vi.fn(async () => null),
    accountId: 'acc-1',
    currentSession: { apiUrl: 'https://mail.example.com/jmap/' },
    username: 'user',
    serverUrl: 'https://mail.example.com',
  },
  AuthenticationError: class AuthenticationError extends Error {
    constructor(msg: string) { super(msg); this.name = 'AuthenticationError'; }
  },
  NetworkError: class NetworkError extends Error {
    constructor(msg: string) { super(msg); this.name = 'NetworkError'; }
  },
}));

vi.mock('../../lib/push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
}));

vi.mock('../account-data-cleanup', () => ({
  forgetAccountData: vi.fn(async (_account: unknown, _opts?: unknown) => undefined),
  forgetSharedData: vi.fn(async () => undefined),
}));

import { jmapClient } from '../../api/jmap-client';
import { forgetAccountData, forgetSharedData } from '../account-data-cleanup';
import { useAuthStore, HYDRATION_TIMEOUT_MS } from '../auth-store';
import { useAccountStore } from '../account-store';
import { useCalendarStore } from '../calendar-store';
import { useContactsStore } from '../contacts-store';
import { useEmailStore } from '../email-store';
import { useFilterStore } from '../filter-store';
import { useVacationStore } from '../vacation-store';
import type { Email } from '../../api/types';
import { peekRow, rememberRows } from '../../lib/email-detail-cache';
import { bodyDocument } from '../../lib/email-body-document';
import { lastBodyHeight, rememberBodyHeight } from '../../lib/body-heights';

const mockConnect = jmapClient.connect as ReturnType<typeof vi.fn>;
const mockLogout = jmapClient.logout as ReturnType<typeof vi.fn>;
const mockLoadAccount = jmapClient.loadAccount as ReturnType<typeof vi.fn>;

function resetAccountStore(): void {
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    defaultAccountId: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountStore();
  useAuthStore.setState({
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

  describe('forgetting an account\'s data', () => {
    const entry = (id: string, serverUrl: string, username: string) => ({
      id, serverUrl, username, displayName: username, email: username, avatarColor: '#000',
      lastLoginAt: 0, isConnected: true, hasError: false, isDefault: false,
    });

    it('logout forgets the account\'s data', async () => {
      useAccountStore.setState({ accounts: [entry('me@mail.example.com', 'https://mail.example.com', 'me')] });
      useAuthStore.setState({
        isAuthenticated: true, activeAccountId: 'me@mail.example.com',
        serverUrl: 'https://mail.example.com', username: 'me',
      });

      await useAuthStore.getState().logout();

      expect(forgetAccountData).toHaveBeenCalledWith({
        appAccountId: 'me@mail.example.com', serverUrl: 'https://mail.example.com', username: 'me',
      }, { lastAccount: true });
    });

    it('logout is not the last account while another stays signed in', async () => {
      useAccountStore.setState({ accounts: [
        entry('me@mail.example.com', 'https://mail.example.com', 'me'),
        entry('o@mail.example.com', 'https://mail.example.com', 'o'),
      ] });
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'me@mail.example.com' });
      await useAuthStore.getState().logout().catch(() => undefined);
      expect((forgetAccountData as any).mock.calls[0][1]).toEqual({ lastAccount: false });
    });

    it('logout without a registry id still forgets shared data when nothing remains', async () => {
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: null });
      mockLogout.mockResolvedValue(undefined);
      await useAuthStore.getState().logout();
      expect(forgetSharedData).toHaveBeenCalled();
    });

    it('logout finishes even when the cleanup fails', async () => {
      (forgetAccountData as any).mockRejectedValueOnce(new Error('disk'));
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'me@mail.example.com' });
      await useAuthStore.getState().logout();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });

    it('removeAccount forgets a non-active account\'s data, using its registry serverUrl and username', async () => {
      useAccountStore.setState({ accounts: [
        entry('other@x.example.com', 'https://x.example.com', 'other'),
        entry('me@mail.example.com', 'https://mail.example.com', 'me'),
      ] });
      useAuthStore.setState({ activeAccountId: 'me@mail.example.com' });

      await useAuthStore.getState().removeAccount('other@x.example.com');

      expect(forgetAccountData).toHaveBeenCalledTimes(1);
      expect(forgetAccountData).toHaveBeenCalledWith({
        appAccountId: 'other@x.example.com', serverUrl: 'https://x.example.com', username: 'other',
      }, { lastAccount: false });
    });

    it('logoutAll forgets every account\'s data', async () => {
      useAccountStore.setState({
        accounts: [entry('a@x.example.com', 'https://x.example.com', 'a'), entry('b@y.example.com', 'https://y.example.com', 'b')],
      });

      await useAuthStore.getState().logoutAll();

      expect(forgetAccountData).toHaveBeenCalledWith({ appAccountId: 'a@x.example.com', serverUrl: 'https://x.example.com', username: 'a' }, { lastAccount: false });
      expect(forgetAccountData).toHaveBeenCalledWith({ appAccountId: 'b@y.example.com', serverUrl: 'https://y.example.com', username: 'b' }, { lastAccount: false });
      expect(forgetAccountData).toHaveBeenCalledTimes(2);
      expect(forgetSharedData).toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('should reset all state when no other accounts remain', async () => {
      useAuthStore.setState({ isAuthenticated: true, serverUrl: 'x', username: 'y' });
      mockLogout.mockResolvedValue(undefined);

      await useAuthStore.getState().logout();

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state.serverUrl).toBeNull();
      expect(state.username).toBeNull();
    });
  });

  describe('switchAccount', () => {
    it('switchAccount clears the filter and vacation stores', async () => {
      // Seeded the way logout is: registered accounts plus store state, with
      // the mocked client "loading" the target account.
      const entry = { serverUrl: 'https://mail.example.com', displayName: '', email: '', lastLoginAt: 0, isConnected: true, hasError: false };
      const idA = useAccountStore.getState().addAccount({ ...entry, username: 'a' });
      const idB = useAccountStore.getState().addAccount({ ...entry, username: 'b' });
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: idA });
      mockLoadAccount.mockResolvedValue(true);

      const initialFilters = useFilterStore.getState();
      const initialVacation = useVacationStore.getState();
      useFilterStore.setState({
        rules: [{ id: 'r1', name: 'Old rule', enabled: true, matchType: 'all', conditions: [], actions: [], stopProcessing: false }],
        isSupported: true,
      });
      useVacationStore.setState({ isEnabled: true, subject: 'Away', hasLoaded: true, isSupported: true });

      await useAuthStore.getState().switchAccount(idB);

      expect(useAuthStore.getState().activeAccountId).toBe(idB);
      expect(useFilterStore.getState().rules).toEqual(initialFilters.rules);
      expect(useFilterStore.getState().isSupported).toBe(initialFilters.isSupported);
      expect(useVacationStore.getState().isEnabled).toBe(initialVacation.isEnabled);
      expect(useVacationStore.getState().subject).toBe('');
      expect(useVacationStore.getState().hasLoaded).toBe(false);
    });
  });

  describe('switchAccount failure', () => {
    it('keeps the current account\'s filters and auto-reply when the switch fails', async () => {
      const entry = { serverUrl: 'https://mail.example.com', displayName: '', email: '', lastLoginAt: 0, isConnected: true, hasError: false };
      const idA = useAccountStore.getState().addAccount({ ...entry, username: 'a' });
      const idB = useAccountStore.getState().addAccount({ ...entry, username: 'b' });
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: idA });
      mockLoadAccount.mockResolvedValue(false);
      useFilterStore.setState({
        rules: [{ id: 'r1', name: 'Rule', enabled: true, matchType: 'all', conditions: [], actions: [], stopProcessing: false }],
      });
      useVacationStore.setState({ isEnabled: true, subject: 'Away', hasLoaded: true });

      await useAuthStore.getState().switchAccount(idB);

      expect(useAuthStore.getState().activeAccountId).toBe(idA);
      expect(useFilterStore.getState().rules).toHaveLength(1);
      expect(useVacationStore.getState().isEnabled).toBe(true);
      expect(useVacationStore.getState().subject).toBe('Away');
    });
  });

  describe('mail the viewer held in memory', () => {
    const docInput = {
      key: '|e1', rawHtml: '<p>Hi</p>', text: null, emptyLabel: '-', blockRemoteImages: false,
      cidMap: {}, isDark: false, messageSpacing: 'auto' as const, plainTextFont: 'sans' as const,
      quoteLabels: { show: 's', hide: 'h' },
    };

    function holdMail() {
      rememberRows([{ id: 'e1', threadId: 't1', receivedAt: '2026-09-01T00:00:00Z' } as Email]);
      rememberBodyHeight('|e1', 400, 900);
      return bodyDocument(docInput);
    }

    it('is dropped on sign-out', async () => {
      const doc = holdMail();
      mockLogout.mockResolvedValue(undefined);

      await useAuthStore.getState().logout();

      expect(peekRow('e1')).toBeUndefined();
      expect(lastBodyHeight('|e1', 400)).toBeUndefined();
      expect(bodyDocument(docInput)).not.toBe(doc);
    });

    it('is dropped when another account is removed', async () => {
      const doc = holdMail();
      useAccountStore.setState({
        accounts: [{
          id: 'other@mail.example.com', serverUrl: 'https://mail.example.com', username: 'other',
          displayName: 'other', email: 'other', avatarColor: '#000', lastLoginAt: 0,
          isConnected: true, hasError: false, isDefault: false,
        }],
      });
      useAuthStore.setState({ activeAccountId: 'me@mail.example.com' });

      await useAuthStore.getState().removeAccount('other@mail.example.com');

      expect(useAccountStore.getState().accounts).toEqual([]);
      expect(peekRow('e1')).toBeUndefined();
      expect(lastBodyHeight('|e1', 400)).toBeUndefined();
      expect(bodyDocument(docInput)).not.toBe(doc);
    });
  });

  describe('restoreSession', () => {
    it('should return false when there is no registered account', async () => {
      const restored = await useAuthStore.getState().restoreSession();

      expect(restored).toBe(false);
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(useAuthStore.getState().hasRestoredSession).toBe(true);
    });

    it('should restore when loadAccount succeeds for the active account', async () => {
      useAccountStore.setState({
        accounts: [
          {
            id: 'acc-1',
            serverUrl: 'https://mail.example.com',
            username: 'user',
            displayName: 'user',
            email: 'user',
            avatarColor: '#000',
            lastLoginAt: 0,
            isConnected: false,
            hasError: false,
            isDefault: true,
          },
        ],
        activeAccountId: 'acc-1',
        defaultAccountId: 'acc-1',
      });
      mockLoadAccount.mockResolvedValue(true);

      const restored = await useAuthStore.getState().restoreSession();

      expect(restored).toBe(true);
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
    });

    it('stops waiting for a persisted store that never finishes hydrating', async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const hasHydrated = vi.spyOn(useCalendarStore.persist, 'hasHydrated').mockReturnValue(false);
      try {
        let settled = false;
        const restoring = useAuthStore.getState().restoreSession().finally(() => { settled = true; });

        await vi.advanceTimersByTimeAsync(HYDRATION_TIMEOUT_MS - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        expect(await restoring).toBe(false);
        expect(useAuthStore.getState().hasRestoredSession).toBe(true);
      } finally {
        hasHydrated.mockRestore();
        warn.mockRestore();
        vi.useRealTimers();
      }
    });

    it('waits for the four persisted stores at the same time', async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const spies = [useAccountStore, useEmailStore, useCalendarStore, useContactsStore]
        .map((store) => vi.spyOn(store.persist, 'hasHydrated').mockReturnValue(false));
      try {
        let settled = false;
        const restoring = useAuthStore.getState().restoreSession().finally(() => { settled = true; });

        // One after another, four stuck stores would hold the session for
        // four timeouts; waited on together, they cost one.
        await vi.advanceTimersByTimeAsync(HYDRATION_TIMEOUT_MS - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        expect(settled).toBe(true);
        expect(await restoring).toBe(false);
        expect(warn.mock.calls.filter(([m]) => String(m).includes('did not hydrate in time'))).toHaveLength(4);
      } finally {
        for (const spy of spies) spy.mockRestore();
        warn.mockRestore();
        vi.useRealTimers();
      }
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
