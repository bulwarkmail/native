import { create } from 'zustand';
import { jmapClient, AuthenticationError, NetworkError } from '../api/jmap-client';
import type { JMAPSession } from '../api/types';
import { getIdentities } from '../api/identity';
import { fetchPrincipal, isStalwartSupported } from '../api/account-security';
import { useAccountStore } from './account-store';
import { useEmailStore } from './email-store';
import { useContactsStore } from './contacts-store';
import { useCalendarStore } from './calendar-store';
import { useFilterStore } from './filter-store';
import { generateAccountId } from '../lib/account-utils';
import { runWebmailHandoff, redeemPairingCode, HandoffCancelledError, HandoffError, type HandoffResult } from '../lib/oauth';
import { discoverOAuthMetadata, loginWithPkce, probeWebmail, revokeRefreshToken } from '../lib/oauth-native';
import {
  teardownPushNotifications,
  teardownPushNotificationsForAccount,
} from '../lib/push-notifications';

// Persist middleware hydrates asynchronously on cold start. Without this
// guard, restoreSession() can read the account-store before AsyncStorage has
// loaded the previous active account, then short-circuit to LoginScreen even
// though the user is actually signed in.
async function waitForHydration(store: { persist: { hasHydrated: () => boolean; onFinishHydration: (cb: () => void) => () => void } }): Promise<void> {
  if (store.persist.hasHydrated()) return;
  await new Promise<void>((resolve) => {
    const unsubscribe = store.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });
}

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
  /**
   * Set when a password sign-in was refused with "MFA code required"; the
   * login screen re-runs it with a code via `login(..., { totp })`. Cleared
   * on the next successful sign-in.
   */
  pendingTotpLogin: { serverUrl: string; username: string; password: string } | null;

  login: (
    serverUrl: string,
    username: string,
    password: string,
    opts?: { addAccount?: boolean; totp?: string },
  ) => Promise<void>;
  loginViaWebmail: (webmailUrl: string, opts?: { addAccount?: boolean }) => Promise<void>;
  /** OAuth/OIDC (PKCE) straight against the mail server's authorization server. */
  loginViaOAuth: (serverUrl: string, opts?: { addAccount?: boolean }) => Promise<void>;
  loginViaPairing: (webmailUrl: string, code: string, opts?: { addAccount?: boolean }) => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  switchAccount: (accountId: string) => Promise<void>;
  /** Sign a non-active account out and drop its caches; the active one stays. */
  removeAccount: (accountId: string) => Promise<void>;
  restoreSession: () => Promise<boolean>;
  retrySession: () => Promise<boolean>;
  clearError: () => void;
}

// Wipe ALL cached feature data for ALL accounts. Used for logoutAll where
// the user is signing out of everything — we don't want stale snapshots
// lingering on disk for accounts that no longer exist.
function clearAllFeatureStores(): void {
  useEmailStore.getState().clearAllAccounts();
  useContactsStore.getState().reset();
  useCalendarStore.getState().reset();
  useFilterStore.getState().clearState();
}

// Drop the named account from the email cache, then reset the (per-session,
// not yet per-account) contacts and calendar stores. Used by logout when
// signing one account out while others remain.
function clearAccountFeatureStores(accountId: string | null): void {
  if (accountId) {
    useEmailStore.getState().removeAccount(accountId);
  } else {
    useEmailStore.getState().clearAllAccounts();
  }
  // Contacts and calendar stores aren't yet keyed by account — the safe
  // thing on logout is still to wipe them so the next account doesn't see
  // the previous user's data. Per-account caching for those stores is a
  // follow-up.
  useContactsStore.getState().reset();
  useCalendarStore.getState().reset();
  useFilterStore.getState().clearState();
}

function refetchFeatureStores(): void {
  // Fire-and-forget: each store handles its own errors.
  const emailStore = useEmailStore.getState();
  void emailStore.fetchMailboxes();
  // If a mailbox was selected before this restore (cached from last session),
  // refresh its contents so the user sees up-to-date mail without manually
  // pulling to refresh.
  if (emailStore.currentMailboxId) {
    void emailStore.refreshEmails();
  }
  void useContactsStore.getState().fetchContacts();
  const calendarStore = useCalendarStore.getState();
  void calendarStore.fetchCalendars();
  // Refresh the event range cached from last session (if any) so recurring
  // events reflect new invitations / cancellations without the user swiping.
  if (calendarStore.loadedRange) {
    void calendarStore.refresh();
  }
}

// Best-effort RFC 7009 revocation of an account's refresh token on sign-out.
// A QR-paired phone shares the desktop's token, so those are left alone.
async function revokeStoredRefreshToken(accountId: string): Promise<void> {
  try {
    const entry = useAccountStore.getState().getAccountById(accountId);
    const tokens = await jmapClient.getStoredOAuthTokens(accountId);
    if (!entry || !tokens || tokens.source === 'pairing') return;
    await revokeRefreshToken(entry.serverUrl, tokens);
  } catch {
    // never block sign-out
  }
}

// Refresh the registry's display name / address from the server (#900): the
// primary identity first, then the Stalwart principal's "Full name" when the
// account advertises the extension. Fire-and-forget; a failure keeps whatever
// the registry already had.
async function syncAccountDisplayName(accountId: string): Promise<void> {
  try {
    const accountStore = useAccountStore.getState();
    const entry = accountStore.getAccountById(accountId);
    if (!entry) return;
    const updates: { displayName?: string; email?: string } = {};
    const identities = await getIdentities().catch(() => []);
    const primary = identities.find((i) => i.email?.toLowerCase() === entry.email?.toLowerCase())
      ?? identities.find((i) => i.email?.toLowerCase() === entry.username?.toLowerCase())
      ?? identities[0];
    if (primary?.name?.trim()) updates.displayName = primary.name.trim();
    if (primary?.email && !entry.email.includes('@')) updates.email = primary.email;
    if (isStalwartSupported()) {
      const principal = await fetchPrincipal().catch(() => null);
      if (principal?.displayName?.trim()) updates.displayName = principal.displayName.trim();
      if (!updates.email && principal?.emails[0] && !entry.email.includes('@')) {
        updates.email = principal.emails[0];
      }
    }
    if (Object.keys(updates).length === 0) return;
    if (useAccountStore.getState().getAccountById(accountId)) {
      useAccountStore.getState().updateAccount(accountId, updates);
    }
  } catch {
    // cosmetic - never block sign-in on it
  }
}

// Shared tail of the OAuth sign-in flows (browser handoff and cross-device QR
// pairing both end here). Bootstraps a JMAP session from the token bundle,
// registers the account, and flips the store to connected. Throws on failure
// so the caller can surface a flow-specific error.
async function completeOAuthHandoff(
  set: (partial: Partial<AuthState>) => void,
  get: () => AuthState,
  result: Extract<HandoffResult, { flow: 'oauth' }>,
  opts?: { addAccount?: boolean },
): Promise<void> {
  // Adding an account must not destroy the live one: the singleton keeps the
  // previous connection until the new sign-in has actually succeeded, and a
  // failure puts it straight back.
  const previous = opts?.addAccount && get().isAuthenticated ? jmapClient.snapshot() : null;

  let connected: { session: JMAPSession; username: string; accountId: string };
  try {
    connected = await jmapClient.connectWithOAuth(result.serverUrl, result.tokens);
  } catch (err) {
    if (previous) jmapClient.restoreSnapshot(previous);
    throw err;
  }
  const { session, username, accountId } = connected;
  if (previous) {
    useContactsStore.getState().reset();
    useCalendarStore.getState().reset();
  }

  const accountStore = useAccountStore.getState();
  accountStore.addAccount({
    serverUrl: result.serverUrl.replace(/\/+$/, ''),
    username,
    displayName: username,
    email: username,
    lastLoginAt: Date.now(),
    isConnected: true,
    hasError: false,
  });
  accountStore.setActiveAccount(accountId);
  useEmailStore.getState().setActiveAccount(accountId);

  applyConnectedState(set, session, result.serverUrl.replace(/\/+$/, ''), username, accountId);
  void syncAccountDisplayName(accountId);
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
  pendingTotpLogin: null,

  login: async (serverUrl, username, password, opts) => {
    set({ isLoading: true, error: null });
    // Adding an additional account: keep the live connection until the new
    // sign-in succeeded so a typo doesn't kill the current session.
    const previous = opts?.addAccount && get().isAuthenticated ? jmapClient.snapshot() : null;
    try {
      let session: JMAPSession;
      try {
        session = await jmapClient.connect(serverUrl, username, password, opts?.totp);
      } catch (err) {
        if (previous) jmapClient.restoreSnapshot(previous);
        throw err;
      }
      // Contacts/calendar are still single-bucket, so wipe those now that
      // the new account is the one the client serves.
      if (previous) {
        useContactsStore.getState().reset();
        useCalendarStore.getState().reset();
      }
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
      // Swap the email store's active view to the new account so the rest of
      // this function (and refetchFeatureStores) writes to the right bucket.
      useEmailStore.getState().setActiveAccount(accountId);

      applyConnectedState(set, session, serverUrl.replace(/\/+$/, ''), username, accountId);
      set({ pendingTotpLogin: null });
      void syncAccountDisplayName(accountId);
    } catch (err) {
      if (err instanceof Error && err.name === 'TotpRequiredError') {
        // Keep what the user (or the webmail hand-off) supplied so the code
        // step doesn't make them retype the password.
        set({ pendingTotpLogin: { serverUrl: serverUrl.replace(/\/+$/, ''), username, password } });
      }
      const message = err instanceof Error && err.name === 'TotpRequiredError'
        ? 'Two-factor code required'
        : err instanceof AuthenticationError
          ? 'Invalid username or password'
          : err instanceof Error
            ? err.message
            : 'Connection failed';
      set({ isLoading: false, error: message });
      throw err;
    }
  },

  loginViaWebmail: async (webmailUrl, opts) => {
    set({ isLoading: true, error: null });
    // Discovery finds the *JMAP* host; a Bulwark webmail is not necessarily
    // served there. Opening `/login?mobile_redirect_uri=…` on a bare Stalwart
    // lands on a 404 or the admin page, so check first and fall back to the
    // server's own OAuth (PKCE) when the webmail is missing.
    if (!(await probeWebmail(webmailUrl))) {
      const metadata = await discoverOAuthMetadata(webmailUrl);
      if (metadata) {
        await get().loginViaOAuth(webmailUrl, opts);
        return;
      }
      const message = 'No Bulwark webmail or sign-in service found at this address. Use a password instead.';
      set({ isLoading: false, error: message });
      throw new HandoffError(message);
    }
    let result;
    try {
      result = await runWebmailHandoff(webmailUrl, { addAccount: opts?.addAccount });
    } catch (err) {
      if (err instanceof HandoffCancelledError) {
        // User closed the browser tab — quiet exit, no error banner.
        set({ isLoading: false, error: null });
        return;
      }
      const message = err instanceof Error ? err.message : 'Sign-in failed';
      set({ isLoading: false, error: message });
      throw err;
    }

    if (result.flow === 'password') {
      // Hand the credentials to the existing password login path so account
      // registration + feature-store wiring all behave identically to a
      // manual sign-in.
      await get().login(result.serverUrl, result.username, result.password, opts);
      return;
    }

    // OAuth — the webmail did the dance against Stalwart and handed us a
    // token bundle. Bootstrap the JMAP session with Bearer auth and let
    // ensure/forceRefreshToken keep it alive going forward.
    try {
      await completeOAuthHandoff(set, get, result, opts);
    } catch (err) {
      const message =
        err instanceof AuthenticationError
          ? 'Authentication rejected by server'
          : err instanceof Error
            ? err.message
            : 'OAuth sign-in failed';
      set({ isLoading: false, error: message });
      throw err;
    }
  },

  loginViaOAuth: async (serverUrl, opts) => {
    set({ isLoading: true, error: null });
    const base = serverUrl.replace(/\/+$/, '');
    let tokens;
    try {
      const metadata = await discoverOAuthMetadata(base);
      if (!metadata) throw new HandoffError('This server does not offer OAuth sign-in');
      tokens = await loginWithPkce(base, metadata, { addAccount: opts?.addAccount });
    } catch (err) {
      if (err instanceof HandoffCancelledError) {
        set({ isLoading: false, error: null });
        return;
      }
      const message = err instanceof Error ? err.message : 'Sign-in failed';
      set({ isLoading: false, error: message });
      throw err;
    }
    try {
      await completeOAuthHandoff(set, get, { flow: 'oauth', serverUrl: base, tokens }, opts);
    } catch (err) {
      const message =
        err instanceof AuthenticationError
          ? 'Authentication rejected by server'
          : err instanceof Error
            ? err.message
            : 'OAuth sign-in failed';
      set({ isLoading: false, error: message });
      throw err;
    }
  },

  loginViaPairing: async (webmailUrl, code, opts) => {
    set({ isLoading: true, error: null });
    let result;
    try {
      result = await redeemPairingCode(webmailUrl, code);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Pairing failed';
      set({ isLoading: false, error: message });
      throw err;
    }

    // redeemPairingCode only ever yields the OAuth flow, but guard anyway so a
    // future server change can't silently mis-route credentials here.
    if (result.flow !== 'oauth') {
      set({ isLoading: false, error: 'Unexpected pairing response' });
      throw new Error('Unexpected pairing response');
    }

    try {
      await completeOAuthHandoff(set, get, result, opts);
    } catch (err) {
      const message =
        err instanceof AuthenticationError
          ? 'Authentication rejected by server'
          : err instanceof Error
            ? err.message
            : 'Pairing sign-in failed';
      set({ isLoading: false, error: message });
      throw err;
    }
  },

  logout: async () => {
    const accountStore = useAccountStore.getState();
    const currentId = get().activeAccountId;

    // Best-effort: revoke this account's JMAP PushSubscription and drop its
    // relay mapping before we lose credentials. Other logged-in accounts'
    // push setups remain untouched. Do not abort logout on failure.
    if (currentId) {
      await teardownPushNotificationsForAccount(currentId).catch(() => undefined);
    } else {
      await teardownPushNotifications().catch(() => undefined);
    }

    // Clear credentials for this account first
    if (currentId) {
      await revokeStoredRefreshToken(currentId);
      await jmapClient.clearAccountCredentials(currentId);
      accountStore.removeAccount(currentId);
    } else {
      await jmapClient.logout();
    }

    jmapClient.reset();
    clearAccountFeatureStores(currentId);

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
    await teardownPushNotifications().catch(() => undefined);
    for (const id of ids) await revokeStoredRefreshToken(id);
    await jmapClient.clearAllCredentials(ids);
    jmapClient.reset();
    clearAllFeatureStores();

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

    // Swap the email-store view to the new account *before* the network
    // round-trip. The previous account's data is tucked into its snapshot;
    // the new account's data (if previously cached) is restored to the
    // top-level fields so the EmailListScreen immediately shows the new
    // account's last-known mail instead of flashing empty. The network
    // refresh below applies incremental updates on top.
    useEmailStore.getState().setActiveAccount(accountId);

    // Contacts and calendar stores aren't yet per-account, so they still
    // need a reset to avoid showing the previous account's data.
    useContactsStore.getState().reset();
    useCalendarStore.getState().reset();

    // Load the new account's session. loadAccount overwrites
    // credentials/session/_accountId itself, so we don't need to reset
    // jmapClient first. If it fails, restore the previous active account
    // so we don't leave the user stranded on a half-switched state.
    const previousActive = get().activeAccountId;
    // loadAccount overwrites the client's credentials/session; keep the live
    // connection around so a failed switch can put it back instead of
    // leaving the previous account dead until relaunch.
    const previousClient = jmapClient.snapshot();
    const restorePrevious = () => {
      jmapClient.restoreSnapshot(previousClient);
      if (previousActive) useEmailStore.getState().setActiveAccount(previousActive);
    };
    try {
      const ok = await jmapClient.loadAccount(accountId);
      if (!ok) {
        // Credentials missing - evict stale entry and surface error
        accountStore.removeAccount(accountId);
        useEmailStore.getState().removeAccount(accountId);
        restorePrevious();
        set({ isLoading: false, error: 'Session expired for this account' });
        return;
      }
    } catch (err) {
      if (err instanceof AuthenticationError) {
        await jmapClient.clearAccountCredentials(accountId).catch(() => undefined);
        accountStore.removeAccount(accountId);
        useEmailStore.getState().removeAccount(accountId);
        restorePrevious();
        set({ isLoading: false, error: 'Session expired for this account' });
        return;
      }
      // NetworkError or anything else - keep the previous active account
      // intact instead of stranding the user on a half-switched state.
      restorePrevious();
      accountStore.updateAccount(accountId, {
        hasError: true,
        errorMessage: err instanceof Error ? err.message : 'Failed to switch account',
      });
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to switch account',
      });
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
    void syncAccountDisplayName(accountId);
  },

  removeAccount: async (accountId) => {
    if (get().activeAccountId === accountId) {
      await get().logout();
      return;
    }
    const accountStore = useAccountStore.getState();
    if (!accountStore.getAccountById(accountId)) return;
    await teardownPushNotificationsForAccount(accountId).catch(() => undefined);
    await revokeStoredRefreshToken(accountId);
    await jmapClient.clearAccountCredentials(accountId).catch(() => undefined);
    useEmailStore.getState().removeAccount(accountId);
    accountStore.removeAccount(accountId);
  },

  restoreSession: async () => {
    set({ isLoading: true });
    try {
      // Wait for persisted caches to finish hydrating from AsyncStorage.
      // Otherwise we read empty defaults and bounce the user back to the
      // login screen - and the feature stores don't have their cached data
      // yet when refetchFeatureStores() checks currentMailboxId / loadedRange
      // at the end of this function.
      await Promise.all([
        waitForHydration(useAccountStore),
        waitForHydration(useEmailStore),
        waitForHydration(useCalendarStore),
        waitForHydration(useContactsStore),
      ]);
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

      // Point the email store at the target account before any await — so
      // the EmailListScreen, which re-renders the moment the persisted state
      // hydrates, sees the right account's cached emails instead of stale
      // data from a previous session.
      useEmailStore.getState().setActiveAccount(target.id);

      try {
        const ok = await jmapClient.loadAccount(target.id);
        if (!ok) {
          // No stored credentials (or corrupt) — genuine logout.
          accountStore.removeAccount(target.id);
          useEmailStore.getState().removeAccount(target.id);
          set({ isLoading: false, hasRestoredSession: true });
          return false;
        }
      } catch (err) {
        if (err instanceof NetworkError) {
          // Server unreachable. Keep credentials, mark account offline, and
          // surface the cached UI so the user can still browse persisted
          // mail / contacts / calendar. The login screen would lose their
          // settings without recourse, which is the bug we're fixing here.
          accountStore.setActiveAccount(target.id);
          accountStore.updateAccount(target.id, {
            isConnected: false,
            hasError: true,
            errorMessage: err.message,
          });
          set({
            isAuthenticated: true,
            isLoading: false,
            hasRestoredSession: true,
            error: null,
            serverUrl: target.serverUrl,
            username: target.username,
            session: null,
            accountId: null,
            activeAccountId: target.id,
            client: jmapClient,
          });
          return true;
        }
        if (err instanceof AuthenticationError) {
          // Server reachable but credentials rejected — drop them.
          await jmapClient.clearAccountCredentials(target.id).catch(() => undefined);
          accountStore.removeAccount(target.id);
          useEmailStore.getState().removeAccount(target.id);
          set({ isLoading: false, hasRestoredSession: true, error: 'Session expired' });
          return false;
        }
        throw err;
      }

      accountStore.setActiveAccount(target.id);
      accountStore.updateAccount(target.id, {
        isConnected: true,
        hasError: false,
        errorMessage: undefined,
      });

      const session = jmapClient.currentSession!;
      applyConnectedState(set, session, target.serverUrl, target.username, target.id);
      // Refresh the cached mailbox list + current folder now that the session
      // is live. Feature stores show persisted data immediately; this swaps
      // in fresh data once the network round-trip completes.
      refetchFeatureStores();
      void syncAccountDisplayName(target.id);
      return true;
    } catch {
      set({ isLoading: false, hasRestoredSession: true });
      return false;
    }
  },

  // Re-attempt session establishment for the currently active account
  // without disturbing UI state on failure. Used by the network-recovery
  // watcher and any explicit "retry" button. Idempotent: returns true if
  // a session is already live.
  retrySession: async () => {
    const { activeAccountId, session } = get();
    if (!activeAccountId) return false;
    if (session) return true;
    const accountStore = useAccountStore.getState();
    const target = accountStore.getAccountById(activeAccountId);
    if (!target) return false;
    try {
      const ok = await jmapClient.loadAccount(activeAccountId);
      if (!ok) return false;
      accountStore.updateAccount(activeAccountId, {
        isConnected: true,
        hasError: false,
        errorMessage: undefined,
      });
      const fresh = jmapClient.currentSession!;
      applyConnectedState(set, fresh, target.serverUrl, target.username, activeAccountId);
      refetchFeatureStores();
      return true;
    } catch (err) {
      if (err instanceof AuthenticationError) {
        // Now we know the credentials are bad — fall back to logout flow.
        await jmapClient.clearAccountCredentials(activeAccountId).catch(() => undefined);
        accountStore.removeAccount(activeAccountId);
        set({
          isAuthenticated: false,
          isLoading: false,
          hasRestoredSession: true,
          error: 'Session expired',
          serverUrl: null,
          username: null,
          session: null,
          accountId: null,
          activeAccountId: null,
          client: null,
        });
      }
      // NetworkError or anything else: stay where we are.
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));

// A 401 on a live session (revoked password/token, expired refresh token)
// used to leave the user on a dead session until relaunch: nothing outside
// the login flow handled `AuthenticationError`, and `retrySession` bailed
// because `session` was still the stale object. Drop the session and retry
// once; if the credentials really are dead, `retrySession` evicts the
// account and shows the login screen with "Session expired".
let authFailureInFlight = false;
jmapClient.onAuthFailure(() => {
  if (authFailureInFlight) return;
  const state = useAuthStore.getState();
  if (!state.isAuthenticated || !state.session) return;
  authFailureInFlight = true;
  useAuthStore.setState({ session: null });
  void state.retrySession().finally(() => {
    authFailureInFlight = false;
  });
});
