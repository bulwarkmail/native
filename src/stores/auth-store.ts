import { create } from 'zustand';
import {
  jmapClient,
  AuthenticationError,
  InvalidTokenError,
  NetworkError,
  SessionSupersededError,
  type ClientSnapshot,
} from '../api/jmap-client';
import type { JMAPSession } from '../api/types';
import { fetchAccountDisplayName, isStalwartSupported } from '../api/account-security';
import { useAccountStore } from './account-store';
import { useEmailStore } from './email-store';
import { useContactsStore } from './contacts-store';
import { useCalendarStore } from './calendar-store';
import { useSettingsStore } from './settings-store';
import { useFilterStore } from './filter-store';
import { useOutboxStore } from './outbox-store';
import { flushPersistedWrites } from './persist-storage';
import { clearEmailDetailCache } from '../lib/email-detail-cache';
import { clearBodyDocuments } from '../lib/email-body-document';
import { clearBodyHeights } from '../lib/body-heights';
import { AccountLimitError, generateAccountId, MAX_ACCOUNTS } from '../lib/account-utils';
import {
  runWebmailHandoff,
  redeemPairingCode,
  HandoffCancelledError,
  HandoffError,
  PairingError,
  forgetRefreshRotations,
  type HandoffResult,
} from '../lib/oauth';
import { discoverOAuthMetadata, loginWithPkce, probeWebmail, revokeRefreshToken } from '../lib/oauth-native';
import {
  teardownPushNotifications,
  teardownPushNotificationsForAccount,
} from '../lib/push-notifications';
import { reconcileServerFingerprint } from '../lib/server-change';
import { deviceSyncSignedIn, releaseDeviceSyncBeforeSignOut } from '../device-sync/app/lifecycle';
import { perfMark } from '../lib/perf-marks';

// Persist middleware hydrates asynchronously on cold start. Without this
// guard, restoreSession() can read the account-store before AsyncStorage has
// loaded the previous active account, then short-circuit to LoginScreen even
// though the user is actually signed in.
//
// The wait is bounded. A failed read already resolves as an empty store (see
// persist-storage), but zustand never reports a hydration that throws later,
// in migrate or merge, or a storage call that never settles. Waiting on one
// of those left the app on the splash screen for good.
export const HYDRATION_TIMEOUT_MS = 5000;

async function waitForHydration(store: {
  persist: {
    hasHydrated: () => boolean;
    onFinishHydration: (cb: () => void) => () => void;
    getOptions: () => { name?: string };
  };
}): Promise<void> {
  if (store.persist.hasHydrated()) return;
  await new Promise<void>((resolve) => {
    const unsubscribe = store.persist.onFinishHydration(() => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
    const timer = setTimeout(() => {
      unsubscribe();
      console.warn(`[auth-store] '${store.persist.getOptions().name}' did not hydrate in time, continuing without it`);
      resolve();
    }, HYDRATION_TIMEOUT_MS);
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
  /** Access-token (Bearer) sign-in with a token the user pasted, e.g. a Fastmail API token. */
  loginWithToken: (serverUrl: string, token: string, opts?: { addAccount?: boolean }) => Promise<void>;
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

// The messages the viewer read, their rendered documents and their heights,
// held in memory only. Their keys name the server and login, but a signed-out
// user's mail has no business staying in memory at all.
function clearViewerCaches(): void {
  clearEmailDetailCache();
  clearBodyDocuments();
  clearBodyHeights();
}

// Wipe ALL cached feature data for ALL accounts. Used for logoutAll where
// the user is signing out of everything — we don't want stale snapshots
// lingering on disk for accounts that no longer exist.
function clearAllFeatureStores(): void {
  useEmailStore.getState().clearAllAccounts();
  clearViewerCaches();
  useContactsStore.getState().reset();
  useCalendarStore.getState().reset();
  useFilterStore.getState().clearState();
  // Cache writes are held back briefly; get the signed-out data off disk now.
  void flushPersistedWrites();
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
  clearViewerCaches();
  // Contacts and calendar stores aren't yet keyed by account — the safe
  // thing on logout is still to wipe them so the next account doesn't see
  // the previous user's data. Per-account caching for those stores is a
  // follow-up.
  useContactsStore.getState().reset();
  useCalendarStore.getState().reset();
  useFilterStore.getState().clearState();
  void flushPersistedWrites();
}

// Once a session is up and before anything reads the account's caches: when
// the server behind it is not the one that filled them, they go (see
// lib/server-change). A failed check never blocks signing in; it runs again
// with the next session.
async function checkServerChange(accountId: string, session: JMAPSession): Promise<void> {
  try {
    await reconcileServerFingerprint(accountId, session);
  } catch (err) {
    console.warn('[auth-store] server change check failed:', err);
  }
}

// The outbox replays against whatever account the JMAP client serves, and a
// replaced server may have given the queued ids to other messages. So it
// runs only once the account's session is up and its server was checked.
function resumeOutbox(accountId: string): void {
  void useOutboxStore.getState().resume(accountId);
}

// Account changes overlap: the account rows have no busy state and a
// notification tap switches too, so B can be tapped and then C before B's
// session is up. Each change (a switch, a sign-in, a sign-out) takes a
// generation, and once its awaits return, one that a newer change superseded
// touches neither the client nor the stores; the client already refused its
// session (SessionSupersededError). An older switch that finished last used
// to put its account in the client under the newer one's mail list, and one
// that failed last put back the account it had left.
let accountChange = 0;

function beginAccountChange(): () => boolean {
  const generation = ++accountChange;
  return () => generation === accountChange;
}

interface SwitchOrigin {
  accountId: string | null;
  /** Its session was up, and with it its outbox. */
  live: boolean;
  client: ClientSnapshot;
}

// Set while switches are under way. They share the account the first one
// left, which a failed later one puts back: the client serves no account
// while a switch loads, so there is nothing else to snapshot. `settled`
// resolves when the switch that set it ends.
let pendingSwitch: { origin: SwitchOrigin; settled: Promise<void> } | null = null;

// Sign-ins under way. A session retry, which runs by itself, never takes the
// client from one, nor from a switch.
let signInsUnderWay = 0;

// The connection an add-account sign-in under way saved: the account in use,
// which it puts back should it fail. From the moment the sign-in begins, the
// client serves the account being added, or none, so a switch that overtakes
// the sign-in falls back on this connection too. It took a snapshot of the
// client instead, and when it failed as well, the sign-in it overtook had
// given up: the app stayed on the account in use while the client served no
// account, or the one being added, under its name.
let signInSaved: { client: ClientSnapshot; isCurrent: () => boolean } | null = null;

// Set while a cold start brings the last account up. The main screens show
// its cached mail meanwhile, so a switch can begin; it waits for the restore.
// A restore that a switch overtook gave up, and with the switch failing too,
// the app went to the sign-in screen with every account still registered.
let restoreUnderWay: Promise<void> | null = null;

async function switchesSettled(): Promise<void> {
  while (pendingSwitch) await pendingSwitch.settled;
}

interface SignedIn {
  session: JMAPSession;
  serverUrl: string;
  username: string;
  /** The local account id (username@host). */
  accountId: string;
}

// Shared by the password and OAuth sign-ins: `connect` puts the new
// account's session in the client. Adding an account must not destroy the
// live one: a snapshot of its connection is kept, and a failed sign-in puts
// it straight back. Its outbox is held meanwhile: the queue replays through
// whatever account the client serves, which is the new one as soon as its
// session is up, before the stores move to it once its server was checked.
async function signIn(
  set: (partial: Partial<AuthState>) => void,
  get: () => AuthState,
  opts: { addAccount?: boolean } | undefined,
  connect: () => Promise<SignedIn>,
): Promise<SignedIn> {
  signInsUnderWay += 1;
  let saved: typeof signInSaved = null;
  try {
    // A switch under way lands first, so there is one account to put back.
    await switchesSettled();
    const isCurrent = beginAccountChange();
    const previous = opts?.addAccount && get().isAuthenticated ? jmapClient.snapshot() : null;
    const resumable = previous ? useOutboxStore.getState().suspend() : null;
    if (previous) signInSaved = saved = { client: previous, isCurrent };
    const putBack = (connected: boolean) => {
      // Not over a newer account change, which has the client now.
      if (!isCurrent()) return;
      if (previous) {
        jmapClient.restoreSnapshot(previous);
        if (resumable) resumeOutbox(resumable);
      } else if (connected) {
        // The client must not serve an account the registry never took.
        jmapClient.reset();
      }
    };

    let signedIn: SignedIn | null = null;
    let wasRegistered = true;
    const accountStore = useAccountStore.getState();
    try {
      signedIn = await connect();
      if (!isCurrent()) throw new SessionSupersededError();
      wasRegistered = !!accountStore.getAccountById(signedIn.accountId);
      // Contacts/calendar are still single-bucket, so wipe those now that
      // the new account is the one the client serves.
      if (previous) {
        useContactsStore.getState().reset();
        useCalendarStore.getState().reset();
      }
      await checkServerChange(signedIn.accountId, signedIn.session);
      if (!isCurrent()) throw new SessionSupersededError();
      accountStore.addAccount({
        serverUrl: signedIn.serverUrl,
        username: signedIn.username,
        displayName: signedIn.username,
        email: signedIn.username,
        lastLoginAt: Date.now(),
        isConnected: true,
        hasError: false,
      });
    } catch (err) {
      putBack(!!signedIn);
      // connect() stored credentials for an account the registry never took
      // (the account limit, or a newer account change): none stay behind.
      if (signedIn && !wasRegistered && !useAccountStore.getState().getAccountById(signedIn.accountId)) {
        await jmapClient.clearAccountCredentials(signedIn.accountId).catch(() => undefined);
      }
      throw err;
    }
    const { session, serverUrl, username, accountId } = signedIn;
    accountStore.setActiveAccount(accountId);
    // Swap the email store's active view to the new account so the rest of
    // this function (and refetchFeatureStores) writes to the right bucket.
    useEmailStore.getState().setActiveAccount(accountId);

    applyConnectedState(set, session, serverUrl, username, accountId);
    resumeOutbox(accountId);
    // Start on the folder list now rather than once the mail screen has
    // mounted; the screen joins this load.
    void useEmailStore.getState().fetchMailboxes();
    void syncAccountDisplayName(accountId);
    // Device sync (#34): drop a "sign in again" notice, resume a suspended account.
    void deviceSyncSignedIn(accountId);
    return signedIn;
  } finally {
    signInsUnderWay -= 1;
    if (signInSaved === saved) signInSaved = null;
  }
}

function refetchFeatureStores(accountId: string): void {
  resumeOutbox(accountId);
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

// Pairing codes this app process has redeemed or is redeeming. Codes are
// single-use, so a second attempt with the same one can only fail.
const pairingCodesSeen = new Set<string>();

function hostOfUrl(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
}

// Room in the registry for the account a sign-in is about to add. One it
// already holds is an update and always fits; without an id (a code not yet
// redeemed, a browser sign-in not yet back) a full registry means no.
function assertRoomForAccount(accountId?: string): void {
  const { accounts } = useAccountStore.getState();
  if (accountId && accounts.some((a) => a.id === accountId)) return;
  if (accounts.length >= MAX_ACCOUNTS) throw new AccountLimitError();
}

// Adding an account to a full registry: refuse before a sign-in code is
// spent or a browser sign-in started, since what they buy can't be kept.
function refuseAddWhenFull(set: (partial: Partial<AuthState>) => void, opts?: { addAccount?: boolean }): void {
  if (!opts?.addAccount) return;
  try {
    assertRoomForAccount();
  } catch (err) {
    set({ isLoading: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

// Best-effort RFC 7009 revocation of an account's refresh token on sign-out.
// QR-paired bundles are left alone: webmail up to 1.11 handed the phone the
// desktop's own refresh token, and newer ones hand out a separate grant whose
// refresh token only the webmail's token proxy understands. The account's
// chain also leaves the in-process rotation memory either way, so a stale copy
// refreshed after the sign-out can't pick up its tokens from there.
async function revokeStoredRefreshToken(accountId: string): Promise<void> {
  try {
    const entry = useAccountStore.getState().getAccountById(accountId);
    const tokens = await jmapClient.getStoredOAuthTokens(accountId);
    forgetRefreshRotations(tokens?.refreshToken);
    if (!entry || !tokens || tokens.source === 'pairing') return;
    await revokeRefreshToken(entry.serverUrl, tokens);
  } catch {
    // never block sign-out
  }
}

// Refresh the registry's display name / address from the server (#900): the
// primary identity first, then the Stalwart account's "Full name" when the
// account advertises the extension. Read from x:AccountSettings, which every
// user can read; x:Account/get is refused to everyone but admins. Fire-and-
// forget; a failure keeps whatever the registry already had.
async function syncAccountDisplayName(accountId: string): Promise<void> {
  try {
    const accountStore = useAccountStore.getState();
    const entry = accountStore.getAccountById(accountId);
    if (!entry) return;
    const updates: { displayName?: string; email?: string } = {};
    // Through the settings store's cache: the first message open (quick
    // reply, read receipts) then reuses this read instead of its own.
    await useSettingsStore.getState().ensureIdentities();
    const identities = useSettingsStore.getState().identities;
    const primary = identities.find((i) => i.email?.toLowerCase() === entry.email?.toLowerCase())
      ?? identities.find((i) => i.email?.toLowerCase() === entry.username?.toLowerCase())
      ?? identities[0];
    if (primary?.name?.trim()) updates.displayName = primary.name.trim();
    if (primary?.email && !entry.email.includes('@')) updates.email = primary.email;
    if (isStalwartSupported()) {
      const fullName = await fetchAccountDisplayName().catch(() => null);
      if (fullName) updates.displayName = fullName;
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
  await signIn(set, get, opts, async () => {
    const { session, username, accountId } = await jmapClient.connectWithOAuth(result.serverUrl, result.tokens);
    return { session, serverUrl: result.serverUrl.replace(/\/+$/, ''), username, accountId };
  });
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
    try {
      // A new account with no room left fails here, before connect swaps
      // the live client over or stores credentials for it.
      assertRoomForAccount(generateAccountId(username, serverUrl.replace(/\/+$/, '')));
      // Adding an additional account keeps the live connection until the
      // new sign-in succeeded, so a typo doesn't kill the current session.
      await signIn(set, get, opts, async () => {
        const session = await jmapClient.connect(serverUrl, username, password, opts?.totp);
        const base = serverUrl.replace(/\/+$/, '');
        return { session, serverUrl: base, username, accountId: generateAccountId(username, base) };
      });
      set({ pendingTotpLogin: null });
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

  loginWithToken: async (serverUrl, typedToken, opts) => {
    set({ isLoading: true, error: null });
    // Pasted tokens often come with the scheme or surrounding whitespace.
    const token = typedToken.trim().replace(/^Bearer\s+/i, '');
    const base = serverUrl.replace(/\/+$/, '');
    try {
      if (!token || /\s/.test(token)) throw new InvalidTokenError();
      await signIn(set, get, opts, async () => {
        const { session, username, accountId } = await jmapClient.connectWithToken(base, token);
        return { session, serverUrl: base, username, accountId };
      });
      set({ pendingTotpLogin: null });
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : 'Connection failed' });
      throw err;
    }
  },

  loginViaWebmail: async (webmailUrl, opts) => {
    set({ isLoading: true, error: null });
    refuseAddWhenFull(set, opts);
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
    refuseAddWhenFull(set, opts);
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
    // A code is good for one redemption. The same link can reach us twice
    // (a deep link re-read on launch, a double tap, a scan racing a paste);
    // the second attempt must not spend a request only to be told "used".
    if (pairingCodesSeen.has(code)) {
      throw new PairingError('used', 'This pairing code was already used on this device', {
        host: hostOfUrl(webmailUrl),
      });
    }
    // With no room for another account the code stays unspent: redeeming it
    // would only buy a sign-in the registry can't keep.
    refuseAddWhenFull(set, opts);
    pairingCodesSeen.add(code);

    set({ isLoading: true, error: null });
    let result: HandoffResult;
    try {
      result = await redeemPairingCode(webmailUrl, code);
    } catch (err) {
      // Not redeemed here: the server is the judge of a retry (it answers
      // "used" if the request did get through).
      pairingCodesSeen.delete(code);
      const message = err instanceof Error ? err.message : 'Pairing failed';
      set({ isLoading: false, error: message });
      throw err;
    }

    // The code is spent from here on. A failure to sign in with what it
    // bought needs a new code, which the error says. Two failures keep their
    // own error: a second factor the login screen can still ask for (servers
    // without app passwords hand over the account password, which `login`
    // keeps for that step), and the account limit, which a new code won't fix.
    const serverHost = hostOfUrl(result.serverUrl);
    const connectFailed = (err: unknown): unknown => {
      if (err instanceof Error && (err.name === 'TotpRequiredError' || err instanceof AccountLimitError)) {
        // `login` has settled the store already; the OAuth path has not.
        if (get().isLoading) set({ isLoading: false, error: err.message });
        return err;
      }
      const message = err instanceof AuthenticationError
        ? 'Authentication rejected by server'
        : err instanceof Error
          ? err.message
          : 'Pairing sign-in failed';
      const wrapped = new PairingError('connect_failed', `Signed in, but connecting failed: ${message}`, {
        host: serverHost,
        cause: err,
      });
      set({ isLoading: false, error: wrapped.message });
      return wrapped;
    };

    if (result.flow === 'password') {
      // An app password (or, for servers without them, the account
      // password): the normal password sign-in, which also keeps the live
      // account when adding another one fails.
      try {
        await get().login(result.serverUrl, result.username, result.password, { addAccount: opts?.addAccount });
      } catch (err) {
        throw connectFailed(err);
      }
      return;
    }

    try {
      await completeOAuthHandoff(set, get, result, opts);
    } catch (err) {
      throw connectFailed(err);
    }
  },

  logout: async () => {
    // A switch under way must not land after the sign-out, nor put back the
    // account being signed out when it fails.
    beginAccountChange();
    pendingSwitch = null;
    const accountStore = useAccountStore.getState();
    const currentId = get().activeAccountId;

    // Device sync (#34): upload what this device changed and remove the
    // Android account while the credentials are still here. When changes
    // could not be uploaded the user is asked, and may stay signed in.
    if (currentId && !(await releaseDeviceSyncBeforeSignOut([currentId]))) return;

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
    // Neither the switch below nor a failed one, which puts back the account
    // it left, may bring the signed-out account back.
    set({ serverUrl: null, username: null, session: null, accountId: null, activeAccountId: null });

    // Switch to the next remaining account, if any. The registry is read
    // afresh each time: the state taken above still lists the account just
    // removed, and signing out of the last one "switched" to it, which did
    // nothing, and left the app on an empty mail view.
    for (let tries = useAccountStore.getState().accounts.length; tries > 0; tries--) {
      const registry = useAccountStore.getState();
      const next = registry.getDefaultAccount() ?? registry.accounts[0];
      if (!next) break;
      await get().switchAccount(next.id);
      // Landed, or another switch has begun and decides.
      if (get().activeAccountId === next.id || pendingSwitch) return;
      if (!useAccountStore.getState().getAccountById(next.id)) continue; // its sign-in was refused
      // Its server did not answer: show what is cached for it, as a cold
      // start does, and let the session retry bring it up.
      useAccountStore.getState().setActiveAccount(next.id);
      useEmailStore.getState().setActiveAccount(next.id);
      set({
        isAuthenticated: true,
        isLoading: false,
        hasRestoredSession: true,
        serverUrl: next.serverUrl,
        username: next.username,
        session: null,
        accountId: null,
        activeAccountId: next.id,
        client: jmapClient,
      });
      return;
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
    beginAccountChange();
    pendingSwitch = null;
    const accountStore = useAccountStore.getState();
    const ids = accountStore.accounts.map((a) => a.id);
    // Device sync (#34): as in logout, for every account.
    if (!(await releaseDeviceSyncBeforeSignOut(ids))) return;
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
    // A cold start's restore lands first, so there is an account to put back
    // (see restoreUnderWay). It waits for nothing a switch holds.
    while (restoreUnderWay) await restoreUnderWay;
    const underWay = pendingSwitch;
    if (get().activeAccountId === accountId && !underWay) return;

    const accountStore = useAccountStore.getState();
    const target = accountStore.getAccountById(accountId);
    if (!target) return;

    // Read before this switch overtakes it (see signInSaved).
    const signingIn = signInSaved?.isCurrent() ? signInSaved : null;
    // Once this one's awaits return, a newer account change may own the
    // client and the stores (see beginAccountChange).
    const isCurrent = beginAccountChange();
    // loadAccount overwrites the client's credentials/session; keep the live
    // connection around so a failed switch can put it back instead of
    // leaving the previous account dead until relaunch. With switches under
    // way, that is the account the first of them left; with an add-account
    // sign-in under way, the connection it saved.
    const origin: SwitchOrigin = underWay?.origin ?? {
      accountId: get().activeAccountId,
      live: get().session !== null,
      client: signingIn?.client ?? jmapClient.snapshot(),
    };
    let settle!: () => void;
    const mine = { origin, settled: new Promise<void>((resolve) => { settle = resolve; }) };
    pendingSwitch = mine;

    try {
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

      if (accountId === origin.accountId) {
        // Back to the account the switches under way left: its session is
        // still in the snapshot taken then, and its server was checked.
        jmapClient.restoreSnapshot(origin.client);
        if (origin.live) refetchFeatureStores(accountId);
        set({ isLoading: false });
        return;
      }

      // If the load fails, restore the previous active account so we don't
      // leave the user stranded on a half-switched state.
      const restorePrevious = () => {
        jmapClient.restoreSnapshot(origin.client);
        if (origin.accountId) useEmailStore.getState().setActiveAccount(origin.accountId);
        // Its session and server check still hold; without one, the next
        // session resumes the outbox.
        if (origin.accountId && origin.live) resumeOutbox(origin.accountId);
      };
      try {
        const ok = await jmapClient.loadAccount(accountId);
        if (!isCurrent()) return;
        if (!ok) {
          // Credentials missing - evict stale entry and surface error
          accountStore.removeAccount(accountId);
          useEmailStore.getState().removeAccount(accountId);
          restorePrevious();
          set({ isLoading: false, error: 'Session expired for this account' });
          return;
        }
      } catch (err) {
        if (!isCurrent() || err instanceof SessionSupersededError) return;
        if (err instanceof AuthenticationError) {
          await jmapClient.clearAccountCredentials(accountId).catch(() => undefined);
          if (!isCurrent()) return;
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

      const session = jmapClient.currentSession;
      if (!session) {
        set({ isLoading: false, error: 'Failed to load session' });
        return;
      }
      await checkServerChange(accountId, session);
      if (!isCurrent()) return;

      accountStore.setActiveAccount(accountId);
      accountStore.updateAccount(accountId, {
        isConnected: true,
        hasError: false,
        errorMessage: undefined,
        lastLoginAt: Date.now(),
      });
      applyConnectedState(set, session, target.serverUrl, target.username, accountId);
      refetchFeatureStores(accountId);
      void syncAccountDisplayName(accountId);
    } finally {
      if (pendingSwitch === mine) pendingSwitch = null;
      settle();
    }
  },

  removeAccount: async (accountId) => {
    if (get().activeAccountId === accountId) {
      await get().logout();
      return;
    }
    const accountStore = useAccountStore.getState();
    if (!accountStore.getAccountById(accountId)) return;
    // Device sync (#34): as in logout.
    if (!(await releaseDeviceSyncBeforeSignOut([accountId]))) return;
    await teardownPushNotificationsForAccount(accountId).catch(() => undefined);
    await revokeStoredRefreshToken(accountId);
    await jmapClient.clearAccountCredentials(accountId).catch(() => undefined);
    useEmailStore.getState().removeAccount(accountId);
    clearViewerCaches();
    accountStore.removeAccount(accountId);
  },

  restoreSession: async () => {
    set({ isLoading: true });
    perfMark('restore-start');
    let restored!: () => void;
    const restoring = new Promise<void>((resolve) => { restored = resolve; });
    restoreUnderWay = restoring;
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
      perfMark('restore-hydrated');
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
        perfMark('restore-session');
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
      await checkServerChange(target.id, session);
      applyConnectedState(set, session, target.serverUrl, target.username, target.id);
      perfMark('restore-done');
      // Refresh the cached mailbox list + current folder now that the session
      // is live. Feature stores show persisted data immediately; this swaps
      // in fresh data once the network round-trip completes.
      refetchFeatureStores(target.id);
      void syncAccountDisplayName(target.id);
      return true;
    } catch {
      set({ isLoading: false, hasRestoredSession: true });
      return false;
    } finally {
      if (restoreUnderWay === restoring) restoreUnderWay = null;
      restored();
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
    // A switch or sign-in under way decides which account comes up; loading
    // this one would take the client from it.
    if (pendingSwitch || signInsUnderWay > 0) return false;
    // And one that begins meanwhile has the client once this load returns.
    const generation = accountChange;
    const isCurrent = () => generation === accountChange;
    const accountStore = useAccountStore.getState();
    const target = accountStore.getAccountById(activeAccountId);
    if (!target) return false;
    try {
      const ok = await jmapClient.loadAccount(activeAccountId);
      if (!ok || !isCurrent()) return false;
      accountStore.updateAccount(activeAccountId, {
        isConnected: true,
        hasError: false,
        errorMessage: undefined,
      });
      const fresh = jmapClient.currentSession!;
      await checkServerChange(activeAccountId, fresh);
      if (!isCurrent()) return false;
      applyConnectedState(set, fresh, target.serverUrl, target.username, activeAccountId);
      refetchFeatureStores(activeAccountId);
      return true;
    } catch (err) {
      if (!isCurrent() || err instanceof SessionSupersededError) return false;
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
