import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  clearStoredRelayBaseUrl: vi.fn(async () => undefined),
}));

vi.mock('../account-data-cleanup', () => ({
  forgetAccountData: vi.fn(async (_account: unknown, _opts?: unknown) => undefined),
  forgetSharedData: vi.fn(async () => undefined),
}));

vi.mock('../offline-cache-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../offline-cache-store')>()),
  sweepOrphanedOfflineCache: vi.fn(async () => undefined),
}));

import { jmapClient } from '../../api/jmap-client';
import { sweepOrphanedOfflineCache } from '../offline-cache-store';
import { forgetAccountData, forgetSharedData } from '../account-data-cleanup';
import { clearStoredRelayBaseUrl, teardownPushNotifications } from '../../lib/push-notifications';
import { setPendingMailFolder, usePendingMailFolder } from '../../navigation/pending-mail-folder';
import { useAuthStore, HYDRATION_TIMEOUT_MS, EVICTION_CLEANUP_TIMEOUT_MS } from '../auth-store';
import { useAccountStore } from '../account-store';
import { useCalendarStore } from '../calendar-store';
import { useContactsStore } from '../contacts-store';
import { useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';
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

    it('single-account logout ends signed out', async () => {
      useAccountStore.setState({
        accounts: [entry('me@mail.example.com', 'https://mail.example.com', 'me')],
        activeAccountId: 'me@mail.example.com', defaultAccountId: 'me@mail.example.com',
      });
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'me@mail.example.com' });
      await useAuthStore.getState().logout();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(useAuthStore.getState().activeAccountId).toBeNull();
    });

    it('two-account logout switches to the survivor', async () => {
      useAccountStore.setState({ accounts: [
        entry('me@mail.example.com', 'https://mail.example.com', 'me'),
        entry('o@mail.example.com', 'https://mail.example.com', 'o'),
      ] });
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'me@mail.example.com' });
      mockLoadAccount.mockResolvedValue(true);
      await useAuthStore.getState().logout();
      expect(mockLoadAccount).toHaveBeenCalledWith('o@mail.example.com');
      expect(useAuthStore.getState().activeAccountId).toBe('o@mail.example.com');
    });

    it('logout falls through to signed out when the switch does not take', async () => {
      useAccountStore.setState({ accounts: [
        entry('me@mail.example.com', 'https://mail.example.com', 'me'),
        entry('o@mail.example.com', 'https://mail.example.com', 'o'),
      ] });
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'me@mail.example.com' });
      mockLoadAccount.mockResolvedValue(false);
      await useAuthStore.getState().logout();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(useAuthStore.getState().activeAccountId).toBeNull();
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

    it('removeAccount clears the push relay of that account only', async () => {
      useAccountStore.setState({ accounts: [
        entry('other@x.example.com', 'https://x.example.com', 'other'),
        entry('me@mail.example.com', 'https://mail.example.com', 'me'),
      ] });
      useAuthStore.setState({ activeAccountId: 'me@mail.example.com' });

      await useAuthStore.getState().removeAccount('other@x.example.com');

      expect(clearStoredRelayBaseUrl).toHaveBeenCalledTimes(1);
      expect(clearStoredRelayBaseUrl).toHaveBeenCalledWith('other@x.example.com');
    });

    describe('an account dropped because its session expired', () => {
      const A = () => entry('a@x.example.com', 'https://x.example.com', 'a');
      const B = () => entry('b@y.example.com', 'https://y.example.com', 'b');
      const forgotB = [{ appAccountId: 'b@y.example.com', serverUrl: 'https://y.example.com', username: 'b' }, { lastAccount: false }];
      const parked = (appAccountId: string) => ({ ref: 'Archive', appAccountId, fromMailboxId: null });
      const signedInToA = () => {
        useAccountStore.setState({ accounts: [A(), B()], activeAccountId: 'a@x.example.com' });
        useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'a@x.example.com' });
      };

      it('forgets a switched-to account\'s device data when its session has expired', async () => {
        signedInToA();
        const { AuthenticationError } = await import('../../api/jmap-client');
        mockLoadAccount.mockRejectedValueOnce(new AuthenticationError('expired'));
        setPendingMailFolder(parked('b@y.example.com'));

        await useAuthStore.getState().switchAccount('b@y.example.com');

        expect(forgetAccountData).toHaveBeenCalledWith(...forgotB);
        expect(forgetAccountData).toHaveBeenCalledTimes(1);
        expect(jmapClient.clearAccountCredentials).toHaveBeenCalledWith('b@y.example.com');
        expect(useAccountStore.getState().getAccountById('b@y.example.com')).toBeUndefined();
        expect(usePendingMailFolder.getState().target).toBeNull();
        expect(useAuthStore.getState()).toMatchObject({ activeAccountId: 'a@x.example.com', error: 'Session expired for this account' });
      });

      it('forgets a switched-to account that has no stored credentials, and clears none', async () => {
        signedInToA();
        mockLoadAccount.mockResolvedValueOnce(false);

        await useAuthStore.getState().switchAccount('b@y.example.com');

        expect(forgetAccountData).toHaveBeenCalledWith(...forgotB);
        expect(jmapClient.clearAccountCredentials).not.toHaveBeenCalled();
        expect(clearStoredRelayBaseUrl).toHaveBeenCalledWith('b@y.example.com');
        expect(useAuthStore.getState().activeAccountId).toBe('a@x.example.com');
      });

      it('keeps a parked folder link of the account it stays on', async () => {
        signedInToA();
        mockLoadAccount.mockResolvedValueOnce(false);
        setPendingMailFolder(parked('a@x.example.com'));
        await useAuthStore.getState().switchAccount('b@y.example.com');
        expect(usePendingMailFolder.getState().target).toEqual(parked('a@x.example.com'));
      });

      it('forgets the account restoreSession finds with no stored credentials', async () => {
        useAccountStore.setState({ accounts: [B()], activeAccountId: 'b@y.example.com', defaultAccountId: 'b@y.example.com' });
        mockLoadAccount.mockResolvedValueOnce(false);

        expect(await useAuthStore.getState().restoreSession()).toBe(false);

        expect(forgetAccountData).toHaveBeenCalledWith(forgotB[0], { lastAccount: true });
        expect(jmapClient.clearAccountCredentials).not.toHaveBeenCalled();
        expect(useAccountStore.getState().accounts).toEqual([]);
      });

      it('forgets the account restoreSession finds with rejected credentials', async () => {
        useAccountStore.setState({ accounts: [A(), B()], activeAccountId: 'b@y.example.com', defaultAccountId: 'a@x.example.com' });
        const { AuthenticationError } = await import('../../api/jmap-client');
        mockLoadAccount.mockRejectedValueOnce(new AuthenticationError('expired'));

        expect(await useAuthStore.getState().restoreSession()).toBe(false);

        expect(forgetAccountData).toHaveBeenCalledWith(...forgotB);
        expect(jmapClient.clearAccountCredentials).toHaveBeenCalledWith('b@y.example.com');
        expect(useAuthStore.getState().error).toBe('Session expired');
      });

      it('forgets the account a session retry finds with rejected credentials', async () => {
        useAccountStore.setState({ accounts: [B()], activeAccountId: 'b@y.example.com' });
        useAuthStore.setState({ isAuthenticated: true, session: null, activeAccountId: 'b@y.example.com', client: jmapClient });
        const { AuthenticationError } = await import('../../api/jmap-client');
        mockLoadAccount.mockRejectedValueOnce(new AuthenticationError('expired'));
        setPendingMailFolder(parked('b@y.example.com'));

        expect(await useAuthStore.getState().retrySession()).toBe(false);

        expect(forgetAccountData).toHaveBeenCalledWith(forgotB[0], { lastAccount: true });
        expect(jmapClient.clearAccountCredentials).toHaveBeenCalledWith('b@y.example.com');
        expect(usePendingMailFolder.getState().target).toBeNull();
        expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, error: 'Session expired' });
      });

      it('finishes the eviction even when the cleanup fails', async () => {
        signedInToA();
        (forgetAccountData as any).mockRejectedValueOnce(new Error('disk'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { AuthenticationError } = await import('../../api/jmap-client');
        mockLoadAccount.mockRejectedValueOnce(new AuthenticationError('expired'));

        await useAuthStore.getState().switchAccount('b@y.example.com');

        expect(useAuthStore.getState()).toMatchObject({ activeAccountId: 'a@x.example.com', isLoading: false, error: 'Session expired for this account' });
        expect(warn).toHaveBeenCalled();
        expect(jmapClient.clearAccountCredentials).toHaveBeenCalledWith('b@y.example.com');
        expect(useAccountStore.getState().getAccountById('b@y.example.com')).toBeUndefined();
        warn.mockRestore();
      });

      it('deletes the credentials before the cleanup starts', async () => {
        signedInToA();
        const { AuthenticationError } = await import('../../api/jmap-client');
        mockLoadAccount.mockRejectedValueOnce(new AuthenticationError('expired'));

        await useAuthStore.getState().switchAccount('b@y.example.com');

        const cleared = (jmapClient.clearAccountCredentials as any).mock.invocationCallOrder[0];
        const forgot = (forgetAccountData as any).mock.invocationCallOrder[0];
        expect(cleared).toBeLessThan(forgot);
      });

      it('restoreSession and a session retry still drop the account when the cleanup fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { AuthenticationError } = await import('../../api/jmap-client');

        useAccountStore.setState({ accounts: [B()], activeAccountId: 'b@y.example.com', defaultAccountId: 'b@y.example.com' });
        (forgetAccountData as any).mockRejectedValueOnce(new Error('disk'));
        mockLoadAccount.mockRejectedValueOnce(new AuthenticationError('expired'));
        expect(await useAuthStore.getState().restoreSession()).toBe(false);
        expect(jmapClient.clearAccountCredentials).toHaveBeenCalledWith('b@y.example.com');
        expect(useAccountStore.getState().accounts).toEqual([]);
        expect(useAuthStore.getState().error).toBe('Session expired');

        vi.clearAllMocks();
        useAccountStore.setState({ accounts: [B()], activeAccountId: 'b@y.example.com' });
        useAuthStore.setState({ isAuthenticated: true, session: null, activeAccountId: 'b@y.example.com', client: jmapClient, error: null });
        (forgetAccountData as any).mockRejectedValueOnce(new Error('disk'));
        mockLoadAccount.mockRejectedValueOnce(new AuthenticationError('expired'));
        expect(await useAuthStore.getState().retrySession()).toBe(false);
        expect(jmapClient.clearAccountCredentials).toHaveBeenCalledWith('b@y.example.com');
        expect(useAccountStore.getState().accounts).toEqual([]);
        expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, error: 'Session expired' });
        warn.mockRestore();
      });

      it('does not wait for ever on a cleanup that never settles', async () => {
        vi.useFakeTimers();
        try {
          const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
          useAccountStore.setState({ accounts: [B()], activeAccountId: 'b@y.example.com', defaultAccountId: 'b@y.example.com' });
          (forgetAccountData as any).mockImplementationOnce(() => new Promise(() => undefined));
          mockLoadAccount.mockResolvedValueOnce(false);

          const restored = useAuthStore.getState().restoreSession();
          await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);

          expect(await restored).toBe(false);
          expect(useAuthStore.getState()).toMatchObject({ isLoading: false, hasRestoredSession: true });
          expect(useAccountStore.getState().accounts).toEqual([]);
          warn.mockRestore();
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe('a device cleanup that never settles', () => {
      const hang = () => (forgetAccountData as any).mockImplementationOnce(() => new Promise(() => undefined));
      const run = async (p: Promise<unknown>) => {
        await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS);
        await p;
      };
      let warn: ReturnType<typeof vi.spyOn>;
      beforeEach(() => {
        vi.useFakeTimers();
        warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      });
      afterEach(() => {
        warn.mockRestore();
        vi.useRealTimers();
      });

      it('does not stall logout, and the credentials are gone', async () => {
        useAccountStore.setState({ accounts: [entry('me@mail.example.com', 'https://mail.example.com', 'me')] });
        useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'me@mail.example.com' });
        hang();
        await run(useAuthStore.getState().logout());
        expect(jmapClient.clearAccountCredentials).toHaveBeenCalledWith('me@mail.example.com');
        expect(useAccountStore.getState().accounts).toEqual([]);
        expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, activeAccountId: null });
      });

      it('does not stall removeAccount, and the credentials are gone', async () => {
        useAccountStore.setState({ accounts: [
          entry('other@x.example.com', 'https://x.example.com', 'other'),
          entry('me@mail.example.com', 'https://mail.example.com', 'me'),
        ] });
        useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'me@mail.example.com' });
        hang();
        await run(useAuthStore.getState().removeAccount('other@x.example.com'));
        expect(jmapClient.clearAccountCredentials).toHaveBeenCalledWith('other@x.example.com');
        expect(useAccountStore.getState().getAccountById('other@x.example.com')).toBeUndefined();
        expect(useAuthStore.getState().activeAccountId).toBe('me@mail.example.com');
      });

      it('does not stall logoutAll, and every account and its credentials are gone', async () => {
        useAccountStore.setState({
          accounts: [entry('a@x.example.com', 'https://x.example.com', 'a'), entry('b@y.example.com', 'https://y.example.com', 'b')],
        });
        useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'a@x.example.com' });
        hang();
        await run(useAuthStore.getState().logoutAll());
        expect(jmapClient.clearAllCredentials).toHaveBeenCalledWith(['a@x.example.com', 'b@y.example.com']);
        expect(useAccountStore.getState().accounts).toEqual([]);
        expect(useAuthStore.getState().isAuthenticated).toBe(false);
      });

      it('logout finishes when a local step after the credential delete throws', async () => {
        vi.useRealTimers();
        useAccountStore.setState({ accounts: [entry('me@mail.example.com', 'https://mail.example.com', 'me')] });
        useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'me@mail.example.com' });
        (jmapClient.reset as any).mockImplementationOnce(() => { throw new Error('boom'); });
        await useAuthStore.getState().logout();
        expect(jmapClient.clearAccountCredentials).toHaveBeenCalledWith('me@mail.example.com');
        expect(forgetAccountData).toHaveBeenCalled();
        expect(useAuthStore.getState().isAuthenticated).toBe(false);
      });
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

  describe('what sign-out leaves behind', () => {
    const entry = (id: string) => ({
      id, serverUrl: 'https://mail.example.com', username: id, displayName: id, email: id, avatarColor: '#000',
      lastLoginAt: 0, isConnected: true, hasError: false, isDefault: false,
    });
    const target = (appAccountId: string) => ({ ref: 'Archive', appAccountId, fromMailboxId: null });

    it('logoutAll clears every account\'s relay even when the push teardown fails', async () => {
      useAccountStore.setState({ accounts: [entry('a@mail.example.com'), entry('b@mail.example.com')] });
      (teardownPushNotifications as any).mockRejectedValueOnce(new Error('storage'));

      await useAuthStore.getState().logoutAll();

      expect(clearStoredRelayBaseUrl).toHaveBeenCalledWith('a@mail.example.com');
      expect(clearStoredRelayBaseUrl).toHaveBeenCalledWith('b@mail.example.com');
    });

    it('an account dropped by switchAccount for missing credentials loses its relay', async () => {
      useAccountStore.setState({ accounts: [entry('a@mail.example.com'), entry('b@mail.example.com')] });
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'a@mail.example.com' });
      mockLoadAccount.mockResolvedValue(false);

      await useAuthStore.getState().switchAccount('b@mail.example.com');

      expect(useAccountStore.getState().getAccountById('b@mail.example.com')).toBeUndefined();
      expect(clearStoredRelayBaseUrl).toHaveBeenCalledTimes(1);
      expect(clearStoredRelayBaseUrl).toHaveBeenCalledWith('b@mail.example.com');
    });

    it('an account dropped by restoreSession for missing credentials loses its relay', async () => {
      useAccountStore.setState({ accounts: [entry('acc-1')], activeAccountId: 'acc-1', defaultAccountId: 'acc-1' });
      mockLoadAccount.mockResolvedValue(false);

      expect(await useAuthStore.getState().restoreSession()).toBe(false);

      expect(clearStoredRelayBaseUrl).toHaveBeenCalledWith('acc-1');
    });

    it('logout drops a folder link parked for the account', async () => {
      useAccountStore.setState({ accounts: [entry('a@mail.example.com')] });
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'a@mail.example.com' });
      setPendingMailFolder(target('a@mail.example.com'));

      await useAuthStore.getState().logout();

      expect(usePendingMailFolder.getState().target).toBeNull();
    });

    it('removeAccount drops a folder link parked for that account, and keeps one for another', async () => {
      useAccountStore.setState({ accounts: [entry('a@mail.example.com'), entry('b@mail.example.com')] });
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'a@mail.example.com' });

      setPendingMailFolder(target('a@mail.example.com'));
      await useAuthStore.getState().removeAccount('b@mail.example.com');
      expect(usePendingMailFolder.getState().target).toEqual(target('a@mail.example.com'));

      useAccountStore.setState({ accounts: [entry('a@mail.example.com'), entry('b@mail.example.com')] });
      setPendingMailFolder(target('b@mail.example.com'));
      await useAuthStore.getState().removeAccount('b@mail.example.com');
      expect(usePendingMailFolder.getState().target).toBeNull();
    });

    it('logoutAll drops a parked folder link', async () => {
      useAccountStore.setState({ accounts: [entry('a@mail.example.com')] });
      setPendingMailFolder(target('a@mail.example.com'));

      await useAuthStore.getState().logoutAll();

      expect(usePendingMailFolder.getState().target).toBeNull();
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

    describe('start folder', () => {
      const mbx = (id: string, role: string) => ({
        id, name: role, role, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
        myRights: {}, isShared: false,
      });
      const restoreWithCachedFolder = async (restoreLastFolder: boolean) => {
        useAccountStore.setState({
          accounts: [{
            id: 'acc-1', serverUrl: 'https://mail.example.com', username: 'user', displayName: 'user',
            email: 'user', avatarColor: '#000', lastLoginAt: 0, isConnected: false, hasError: false, isDefault: true,
          }],
          activeAccountId: 'acc-1',
          defaultAccountId: 'acc-1',
        });
        useSettingsStore.setState({ restoreLastFolder, hydrated: true });
        useEmailStore.getState().reset();
        // As hydrated from the cache: acc-1 shown, last in Sent.
        useEmailStore.setState({
          activeAccountId: 'acc-1', mailboxes: [mbx('m1', 'inbox'), mbx('m2', 'sent')] as never, currentMailboxId: 'm2',
        });
        mockLoadAccount.mockResolvedValue(true);
        await useAuthStore.getState().restoreSession();
        return useEmailStore.getState().currentMailboxId;
      };

      it('opens the Inbox on a cold start', async () => {
        expect(await restoreWithCachedFolder(false)).toBe('m1');
      });

      it('reopens the last folder when restoreLastFolder is on', async () => {
        expect(await restoreWithCachedFolder(true)).toBe('m2');
      });
    });

    it('sweeps offline mail of accounts no longer registered', async () => {
      useAccountStore.setState({
        accounts: [{
          id: 'acc-1', serverUrl: 'https://mail.example.com', username: 'user', displayName: 'user',
          email: 'user', avatarColor: '#000', lastLoginAt: 0, isConnected: false, hasError: false, isDefault: true,
        }],
        activeAccountId: 'acc-1',
        defaultAccountId: 'acc-1',
      });
      mockLoadAccount.mockResolvedValue(true);

      await useAuthStore.getState().restoreSession();

      expect(sweepOrphanedOfflineCache).toHaveBeenCalledWith(['acc-1']);
    });

    it('leaves offline mail alone when the account list never loaded', async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const hasHydrated = vi.spyOn(useAccountStore.persist, 'hasHydrated').mockReturnValue(false);
      try {
        const restoring = useAuthStore.getState().restoreSession();
        await vi.advanceTimersByTimeAsync(HYDRATION_TIMEOUT_MS);
        await restoring;

        // An empty registry here only means it isn't loaded: every account's
        // mail would look orphaned.
        expect(sweepOrphanedOfflineCache).not.toHaveBeenCalled();
      } finally {
        hasHydrated.mockRestore();
        warn.mockRestore();
        vi.useRealTimers();
      }
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

  describe('retrySession', () => {
    function offlineSignedIn(): void {
      useAccountStore.setState({
        accounts: [{
          id: 'acc-1', serverUrl: 'https://mail.example.com', username: 'user', displayName: 'user',
          email: 'user', avatarColor: '#000', lastLoginAt: 0, isConnected: false, hasError: true, isDefault: true,
        }],
        activeAccountId: 'acc-1',
        defaultAccountId: 'acc-1',
      });
      useAuthStore.setState({ isAuthenticated: true, session: null, activeAccountId: 'acc-1', client: jmapClient });
    }

    it('shares one in-flight attempt between concurrent callers', async () => {
      offlineSignedIn();
      let finish!: (ok: boolean) => void;
      mockLoadAccount.mockImplementationOnce(() => new Promise<boolean>((r) => { finish = r; }));
      const a = useAuthStore.getState().retrySession();
      const b = useAuthStore.getState().retrySession();
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);
      finish(true);
      expect(await a).toBe(true);
      expect(await b).toBe(true);
      expect(useAuthStore.getState().session).not.toBeNull();
    });

    it('starts a new attempt once the previous one settled', async () => {
      offlineSignedIn();
      const { NetworkError } = await import('../../api/jmap-client');
      mockLoadAccount.mockRejectedValueOnce(new NetworkError('down')).mockResolvedValueOnce(true);
      expect(await useAuthStore.getState().retrySession()).toBe(false);
      expect(await useAuthStore.getState().retrySession()).toBe(true);
      expect(mockLoadAccount).toHaveBeenCalledTimes(2);
    });

    it('a late auth failure for A leaves the user signed in to B (I-1)', async () => {
      offlineSignedIn();
      useAccountStore.setState({
        accounts: [
          ...useAccountStore.getState().accounts,
          {
            id: 'acc-2', serverUrl: 'https://b.example.com', username: 'bob', displayName: 'bob',
            email: 'bob', avatarColor: '#000', lastLoginAt: 0, isConnected: true, hasError: false, isDefault: false,
          },
        ],
      });
      const { AuthenticationError } = await import('../../api/jmap-client');
      let fail!: (e: Error) => void;
      mockLoadAccount.mockImplementationOnce(() => new Promise<boolean>((_r, rej) => { fail = rej; }));
      const p = useAuthStore.getState().retrySession();
      const liveB = { apiUrl: 'https://b.example.com/jmap/' };
      useAuthStore.setState({ activeAccountId: 'acc-2', session: liveB as never });
      fail(new AuthenticationError('Invalid credentials'));
      expect(await p).toBe(false);
      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(true);
      expect(state.activeAccountId).toBe('acc-2');
      expect(state.session).toBe(liveB);
      expect(state.error).toBeNull();
      // A's credentials are bad: A alone is dropped.
      expect(jmapClient.clearAccountCredentials).toHaveBeenCalledWith('acc-1');
      expect(useAccountStore.getState().getAccountById('acc-1')).toBeUndefined();
      expect(useAccountStore.getState().getAccountById('acc-2')).toBeDefined();
    });

    it('a superseded load is not an error and evicts nothing', async () => {
      offlineSignedIn();
      const stale = new Error('Superseded by a newer account load');
      stale.name = 'StaleLoadError';
      mockLoadAccount.mockRejectedValueOnce(stale);
      expect(await useAuthStore.getState().retrySession()).toBe(false);
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(useAccountStore.getState().getAccountById('acc-1')).toBeDefined();
      expect(jmapClient.clearAccountCredentials).not.toHaveBeenCalled();
    });

    it('does not apply a session for an account that is no longer active', async () => {
      offlineSignedIn();
      let finish!: (ok: boolean) => void;
      mockLoadAccount.mockImplementationOnce(() => new Promise<boolean>((r) => { finish = r; }));
      const p = useAuthStore.getState().retrySession();
      useAuthStore.setState({ activeAccountId: 'acc-2' });
      finish(true);
      expect(await p).toBe(false);
      expect(useAuthStore.getState().session).toBeNull();
    });
  });

  describe('switchAccount superseded by a newer load', () => {
    it('neither evicts, restores the previous client, nor sets an error', async () => {
      useAccountStore.setState({
        accounts: [
          { id: 'acc-1', serverUrl: 'https://mail.example.com', username: 'user', displayName: 'user', email: 'user',
            avatarColor: '#000', lastLoginAt: 0, isConnected: true, hasError: false, isDefault: true },
          { id: 'acc-2', serverUrl: 'https://b.example.com', username: 'bob', displayName: 'bob', email: 'bob',
            avatarColor: '#000', lastLoginAt: 0, isConnected: false, hasError: false, isDefault: false },
        ],
        activeAccountId: 'acc-1',
        defaultAccountId: 'acc-1',
      });
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'acc-1', session: { apiUrl: 'x' } as never });
      const stale = new Error('Superseded by a newer account load');
      stale.name = 'StaleLoadError';
      mockLoadAccount.mockRejectedValueOnce(stale);
      await useAuthStore.getState().switchAccount('acc-2');
      expect(jmapClient.restoreSnapshot).not.toHaveBeenCalled();
      expect(useAccountStore.getState().getAccountById('acc-2')?.hasError).toBe(false);
      expect(useAuthStore.getState().error).toBeNull();
      expect(useAuthStore.getState().isLoading).toBe(false);
    });
  });
});

