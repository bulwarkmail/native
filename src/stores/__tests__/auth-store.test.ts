import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    connect: vi.fn(),
    logout: vi.fn(),
    restoreSession: vi.fn(),
    loadAccount: vi.fn(),
    loadAccountFromCache: vi.fn(async () => false),
    revalidateSession: vi.fn(async () => null),
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
    getStoredCredentials: vi.fn(async () => null),
    accountId: 'acc-1',
    connectedAccountId: 'acc-1',
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
  SessionSupersededError: class SessionSupersededError extends Error {},
}));

vi.mock('../../lib/push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
}));

import { jmapClient, AuthenticationError, NetworkError } from '../../api/jmap-client';
import { useAuthStore, HYDRATION_TIMEOUT_MS } from '../auth-store';
import { useAccountStore } from '../account-store';
import { useCalendarStore } from '../calendar-store';
import { useContactsStore } from '../contacts-store';
import { useEmailStore } from '../email-store';
import { useOutboxStore } from '../outbox-store';
import type { Email } from '../../api/types';
import { peekRow, rememberRows } from '../../lib/email-detail-cache';
import { bodyDocument } from '../../lib/email-body-document';
import { lastBodyHeight, rememberBodyHeight } from '../../lib/body-heights';

const mockConnect = jmapClient.connect as ReturnType<typeof vi.fn>;
const mockLogout = jmapClient.logout as ReturnType<typeof vi.fn>;
const mockLoadAccount = jmapClient.loadAccount as ReturnType<typeof vi.fn>;
const mockLoadFromCache = jmapClient.loadAccountFromCache as ReturnType<typeof vi.fn>;
const mockRevalidate = jmapClient.revalidateSession as ReturnType<typeof vi.fn>;

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

    // logout used to read the account list from a snapshot taken before it
    // removed the account: the removed account still looked like one to
    // switch to, the "switch" to the active account returned at once, and
    // signing out of the only account left the app signed in.
    it('signs out of the only account', async () => {
      const id = 'me@mail.example.com';
      useAccountStore.setState({
        accounts: [{
          id, serverUrl: 'https://mail.example.com', username: 'me',
          displayName: 'me', email: 'me', avatarColor: '#000', lastLoginAt: 0,
          isConnected: true, hasError: false, isDefault: true,
        }],
        activeAccountId: id,
        defaultAccountId: id,
      });
      useAuthStore.setState({ isAuthenticated: true, activeAccountId: id, serverUrl: 'x', username: 'y' });

      await useAuthStore.getState().logout();

      expect(useAccountStore.getState().accounts).toEqual([]);
      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state.activeAccountId).toBeNull();
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

    describe('from the session saved at the last connect', () => {
      const account = (id: string, isDefault: boolean) => ({
        id, serverUrl: 'https://mail.example.com', username: id,
        displayName: id, email: id, avatarColor: '#000', lastLoginAt: 0,
        isConnected: true, hasError: false, isDefault,
      });

      function registerAccount() {
        useAccountStore.setState({
          accounts: [account('acc-1', true)],
          activeAccountId: 'acc-1',
          defaultAccountId: 'acc-1',
        });
      }

      function registerTwoAccounts() {
        useAccountStore.setState({
          accounts: [account('acc-1', true), account('acc-2', false)],
          activeAccountId: 'acc-1',
          defaultAccountId: 'acc-1',
        });
      }

      function deferred<T>() {
        let resolve!: (value: T) => void;
        let reject!: (err: unknown) => void;
        const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
        return { promise, resolve, reject };
      }

      const resume = vi.fn(async () => undefined);
      const realResume = useOutboxStore.getState().resume;
      beforeEach(() => {
        // clearAllMocks keeps queued once-values; a test that fails early
        // must not hand its leftovers to the next one.
        mockLoadAccount.mockReset();
        mockLoadFromCache.mockReset().mockResolvedValue(false);
        mockRevalidate.mockReset().mockResolvedValue(null);
        resume.mockClear();
        useOutboxStore.setState({ resume });
        return () => useOutboxStore.setState({ resume: realResume });
      });

      // Start-up used to wait for the server's session document before the
      // cached inbox could show.
      it('shows the account without waiting for the server', async () => {
        registerAccount();
        mockLoadFromCache.mockResolvedValueOnce(true);
        mockRevalidate.mockReturnValueOnce(new Promise(() => undefined));

        const restored = await useAuthStore.getState().restoreSession();

        expect(restored).toBe(true);
        expect(useAuthStore.getState().isAuthenticated).toBe(true);
        expect(useAuthStore.getState().activeAccountId).toBe('acc-1');
        expect(mockLoadAccount).not.toHaveBeenCalled();
        expect(mockRevalidate).toHaveBeenCalledTimes(1);
      });

      // What waits for a live session (push setup, the offline sync, the
      // outbox) must not run on the saved one before the server confirmed it
      // and its server check ran.
      it('counts the session as live, and resumes the outbox, only once the server confirmed it', async () => {
        registerAccount();
        mockLoadFromCache.mockResolvedValueOnce(true);
        const check = deferred<unknown>();
        mockRevalidate.mockReturnValueOnce(check.promise);

        await useAuthStore.getState().restoreSession();
        await new Promise((r) => setTimeout(r, 10));

        expect(useAuthStore.getState().session).toBeNull();
        expect(resume).not.toHaveBeenCalledWith('acc-1');

        check.resolve({ apiUrl: 'https://mail.example.com/jmap/' });
        await vi.waitFor(() => expect(useAuthStore.getState().session).not.toBeNull());
        expect(resume).toHaveBeenCalledWith('acc-1');
        expect(useAccountStore.getState().accounts[0]).toMatchObject({ isConnected: true, hasError: false });
      });

      // A 401 used to evict the account (and everything kept for it) with
      // "Session expired".
      it('keeps the account for a new sign-in when the server refuses the stored credentials', async () => {
        registerAccount();
        mockLoadFromCache.mockResolvedValueOnce(true);
        mockRevalidate.mockRejectedValueOnce(new AuthenticationError('Invalid credentials'));

        await useAuthStore.getState().restoreSession();
        await vi.waitFor(() => expect(useAuthStore.getState().reauth).not.toBeNull());

        expect(useAuthStore.getState().reauth).toMatchObject({ accountId: 'acc-1' });
        expect(useAuthStore.getState().isAuthenticated).toBe(true);
        expect(useAuthStore.getState().session).toBeNull();
        expect(useAccountStore.getState().accounts).toHaveLength(1);
        expect(useAccountStore.getState().accounts[0]).toMatchObject({ needsSignIn: true, isConnected: false });
        // The refusal is the answer: no second round trip to hear it again.
        expect(mockLoadAccount).not.toHaveBeenCalled();
        expect(resume).not.toHaveBeenCalledWith('acc-1');
      });

      it('stays signed in and marks the account offline without network', async () => {
        registerAccount();
        mockLoadFromCache.mockResolvedValueOnce(true);
        mockRevalidate.mockRejectedValueOnce(new Error('Network request failed'));

        await useAuthStore.getState().restoreSession();
        await vi.waitFor(() => expect(useAccountStore.getState().accounts[0].hasError).toBe(true));

        expect(useAuthStore.getState().isAuthenticated).toBe(true);
        expect(useAccountStore.getState().accounts[0].isConnected).toBe(false);
      });

      it('does not start from the saved session for an account that must sign in again', async () => {
        registerAccount();
        useAccountStore.getState().updateAccount('acc-1', { needsSignIn: true });
        mockLoadAccount.mockRejectedValueOnce(new AuthenticationError('Invalid credentials'));

        await useAuthStore.getState().restoreSession();

        expect(mockLoadFromCache).not.toHaveBeenCalled();
        expect(useAuthStore.getState().reauth).toMatchObject({ accountId: 'acc-1' });
      });

      // The check of the saved session is the older account change once a
      // switch began: what it learns must not land on the account in use,
      // even when that is the same account again.
      it('drops a refusal of the saved session that arrives after switching away and back', async () => {
        registerTwoAccounts();
        mockLoadFromCache.mockResolvedValueOnce(true);
        const check = deferred<unknown>();
        mockRevalidate.mockReturnValueOnce(check.promise);
        await useAuthStore.getState().restoreSession();

        mockLoadAccount.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
        await useAuthStore.getState().switchAccount('acc-2');
        await useAuthStore.getState().switchAccount('acc-1');
        expect(useAuthStore.getState().session).not.toBeNull();

        check.reject(new AuthenticationError('Invalid credentials'));
        await new Promise((r) => setTimeout(r, 10));

        expect(useAuthStore.getState().activeAccountId).toBe('acc-1');
        expect(useAuthStore.getState().session).not.toBeNull();
        expect(useAuthStore.getState().reauth).toBeNull();
        expect(useAccountStore.getState().getAccountById('acc-1')?.needsSignIn).toBeFalsy();
      });

      // The network coming back (App.tsx) retries the session while the
      // start from the saved session is still checking it: the retry used to
      // load the account beside the check, and check the server while the
      // start's reads were still landing.
      it('waits for the check of the saved session when the network comes back during it', async () => {
        registerAccount();
        mockLoadFromCache.mockResolvedValueOnce(true);
        const check = deferred<unknown>();
        mockRevalidate.mockReturnValueOnce(check.promise);
        await useAuthStore.getState().restoreSession();

        let retried: boolean | undefined;
        const retry = useAuthStore.getState().retrySession().then((ok) => { retried = ok; });
        await new Promise((r) => setTimeout(r, 10));
        expect(mockLoadAccount).not.toHaveBeenCalled();
        expect(retried).toBeUndefined();

        check.resolve({ apiUrl: 'https://mail.example.com/jmap/' });
        await retry;
        expect(retried).toBe(true);
        expect(useAuthStore.getState().session).not.toBeNull();
        expect(mockLoadAccount).not.toHaveBeenCalled();
        expect(mockRevalidate).toHaveBeenCalledTimes(1);
        expect((resume.mock.calls as unknown[][]).filter(([id]) => id === 'acc-1')).toHaveLength(1);
      });

      it('loads the account once the check of the saved session failed without network', async () => {
        registerAccount();
        mockLoadFromCache.mockResolvedValueOnce(true);
        const check = deferred<unknown>();
        mockRevalidate.mockReturnValueOnce(check.promise);
        await useAuthStore.getState().restoreSession();

        mockLoadAccount.mockResolvedValueOnce(true);
        const retry = useAuthStore.getState().retrySession();
        await new Promise((r) => setTimeout(r, 10));
        expect(mockLoadAccount).not.toHaveBeenCalled();
        check.reject(new NetworkError('offline'));

        expect(await retry).toBe(true);
        expect(mockLoadAccount).toHaveBeenCalledTimes(1);
        expect(useAuthStore.getState().session).not.toBeNull();
        // The start is confirmed: a failed switch away does not check it again.
        mockLoadAccount.mockRejectedValueOnce(new NetworkError('offline'));
        useAccountStore.setState({ accounts: [...useAccountStore.getState().accounts, account('acc-2', false)] });
        await useAuthStore.getState().switchAccount('acc-2');
        expect(mockRevalidate).toHaveBeenCalledTimes(1);
      });

      // A switch that fails puts the account back. Its saved session was
      // never confirmed (the switch overtook the check), so the check runs
      // again, and the outbox waits for it.
      it('checks the saved session again when a switch that overtook the check fails', async () => {
        registerTwoAccounts();
        mockLoadFromCache.mockResolvedValueOnce(true);
        mockRevalidate.mockReturnValueOnce(new Promise(() => undefined));
        await useAuthStore.getState().restoreSession();

        mockLoadAccount.mockRejectedValueOnce(new NetworkError('offline'));
        mockRevalidate.mockResolvedValueOnce({ apiUrl: 'https://mail.example.com/jmap/' });
        await useAuthStore.getState().switchAccount('acc-2');

        expect(useAuthStore.getState().activeAccountId).toBe('acc-1');
        expect(mockRevalidate).toHaveBeenCalledTimes(2);
        await vi.waitFor(() => expect(useAuthStore.getState().session).not.toBeNull());
        expect(resume).toHaveBeenCalledWith('acc-1');
      });
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
