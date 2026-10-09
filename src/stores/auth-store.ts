import { create } from 'zustand';
import { jmapClient, AuthenticationError, NetworkError, type ClientSnapshot } from '../api/jmap-client';
import type { JMAPSession } from '../api/types';
import { fetchAccountDisplayName, isStalwartSupported } from '../api/account-security';
import { useAccountStore, type AccountEntry } from './account-store';
import { useEmailStore, isShownAccount } from './email-store';
import { useContactsStore } from './contacts-store';
import { resetPendingNotificationStores } from './pending-notification-store';
import { useCalendarStore } from './calendar-store';
import { useSettingsStore } from './settings-store';
import { useFilterStore } from './filter-store';
import { useVacationStore } from './vacation-store';
import { sweepOrphanedOfflineCache } from './offline-cache-store';
import { forgetAccountData, forgetSharedData, type SignOutOptions } from './account-data-cleanup';
import { dropPendingMailFolder } from '../navigation/pending-mail-folder';
import { flushPersistedWrites } from './persist-storage';
import { clearEmailDetailCache } from '../lib/email-detail-cache';
import { clearBodyDocuments } from '../lib/email-body-document';
import { clearBodyHeights } from '../lib/body-heights';
import { cleanAccessToken } from '../lib/access-token';
import { AccountLimitError, generateAccountId, MAX_ACCOUNTS } from '../lib/account-utils';
import { toAsciiEmail } from '../lib/idn';
import {
  runWebmailHandoff,
  redeemPairingCode,
  HandoffCancelledError,
  HandoffError,
  PairingError,
  type HandoffResult,
} from '../lib/oauth';
import { discoverOAuthMetadata, loginWithPkce, probeWebmail, revokeRefreshToken } from '../lib/oauth-native';
import {
  captureProviderLogout,
  deleteIdToken,
  endProviderSession,
  providerOf,
  storeIdToken,
  usableEndSessionEndpoint,
  type ProviderLogout,
} from '../lib/provider-session';
import {
  teardownPushNotifications,
  teardownPushNotificationsForAccount,
  clearStoredRelayBaseUrl,
} from '../lib/push-notifications';
import { deviceSyncSignedIn, releaseDeviceSyncBeforeSignOut } from '../device-sync/app/lifecycle';
import { singleFlightByKey } from '../lib/session-retry';
// jmapClient's `StaleLoadError`, matched by name (suites that mock the client
// module need not export the class).
import { isStaleLoad } from '../lib/network-error';
import { clientServesAccount } from '../lib/active-client-account';

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
  loginViaWebmail: (webmailUrl: string, opts?: { addAccount?: boolean }) => Promise<void>;
  /** OAuth/OIDC (PKCE) straight against the mail server's authorization server. */
  loginViaOAuth: (serverUrl: string, opts?: { addAccount?: boolean }) => Promise<void>;
  loginViaPairing: (webmailUrl: string, code: string, opts?: { addAccount?: boolean }) => Promise<void>;
  /** Sign in with a pasted access token (e.g. a Fastmail API token). */
  loginWithToken: (serverUrl: string, typedToken: string, opts?: { addAccount?: boolean }) => Promise<void>;
  /** Queued sends are kept unless `discardQueuedSends` (the user chose to delete them). */
  logout: (opts?: SignOutOptions) => Promise<void>;
  logoutAll: (opts?: SignOutOptions) => Promise<void>;
  switchAccount: (accountId: string) => Promise<void>;
  /** Sign a non-active account out and drop its caches; the active one stays. */
  removeAccount: (accountId: string, opts?: SignOutOptions) => Promise<void>;
  restoreSession: () => Promise<boolean>;
  retrySession: () => Promise<boolean>;
  /**
   * Refetch the session document of `appAccountId` (for an account shared
   * with it since). Only while that account is active and the client serves
   * it, before and after the fetch; resolves whether the session was set.
   */
  refreshSessionFor: (appAccountId: string) => Promise<boolean>;
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
// Each step on its own, so one that throws does not leave the rest behind.
function clearAllFeatureStores(): void {
  afterCredentials(() => useEmailStore.getState().clearAllAccounts());
  afterCredentials(clearViewerCaches);
  afterCredentials(() => useContactsStore.getState().reset());
  afterCredentials(() => useCalendarStore.getState().reset());
  afterCredentials(resetPendingNotificationStores);
  afterCredentials(() => useFilterStore.getState().clearState());
  afterCredentials(() => dropPendingMailFolder(null));
  // Cache writes are held back briefly; get the signed-out data off disk now.
  afterCredentials(() => void flushPersistedWrites().catch(() => undefined));
}

// Drop the named account from the email cache, then reset the (per-session,
// not yet per-account) contacts and calendar stores. Used by logout when
// signing one account out while others remain.
// Each step on its own, so one that throws does not leave the rest behind.
function clearAccountFeatureStores(accountId: string | null): void {
  if (accountId) {
    afterCredentials(() => useEmailStore.getState().removeAccount(accountId));
  } else {
    afterCredentials(() => useEmailStore.getState().clearAllAccounts());
  }
  afterCredentials(clearViewerCaches);
  // Contacts and calendar stores aren't yet keyed by account — the safe
  // thing on logout is still to wipe them so the next account doesn't see
  // the previous user's data. Per-account caching for those stores is a
  // follow-up.
  afterCredentials(() => useContactsStore.getState().reset());
  afterCredentials(() => useCalendarStore.getState().reset());
  afterCredentials(resetPendingNotificationStores);
  afterCredentials(() => useFilterStore.getState().clearState());
  afterCredentials(() => dropPendingMailFolder(accountId));
  afterCredentials(() => void flushPersistedWrites().catch(() => undefined));
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

// connect() points the shared client at the new account and stores its
// credentials before the registry has taken it. When registering it fails
// (the account limit), undo both: the live account, when one is being added
// to, gets the client back, and an account the registry never took keeps no
// credentials behind. Otherwise every request would go out as the new
// account while the app still shows the old one.
// connectWithToken's error for a session that names no user (webmail's text).
const NO_ACCOUNT_NAME = 'The server did not name the account';

async function undoConnect(previous: ClientSnapshot | null, accountId: string, wasRegistered: boolean): Promise<void> {
  if (previous) jmapClient.restoreSnapshot(previous);
  else jmapClient.reset();
  if (!wasRegistered) await jmapClient.clearAccountCredentials(accountId).catch(() => undefined);
}

// How long a sign-out or an eviction waits for the device cleanup before
// carrying on. The cleanup is storage work, but a storage call that never
// settles must not leave the app on the splash screen, a switch spinning or
// the user stuck signed in; it goes on in the background.
export const EVICTION_CLEANUP_TIMEOUT_MS = 5000;

// Wait for `work` at most `ms`, logging a rejection or a timeout. Never throws.
async function waitAtMost(work: Promise<unknown>, ms = EVICTION_CLEANUP_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.warn('[sign-out] cleanup still running, carrying on without it');
        resolve();
      }, ms);
    });
    await Promise.race([work.catch((e) => console.warn('[sign-out] cleanup failed', e)), late]);
  } finally {
    clearTimeout(timer);
  }
}

// A local step after the credential delete (dropping cached state): a
// failure is logged so the sign-out still finishes.
function afterCredentials(run: () => void): void {
  try {
    run();
  } catch (e) {
    console.warn('[sign-out] cleanup failed', e);
  }
}

// Device cleanups of signed-out accounts that may still be running (a sign-
// out waits for one only so long), by app account id. The id is the same when
// the account signs in again, so a cleanup checks `stillGone` before every
// step and stops once the account is back: it must never forget the live
// account's queued sends, identities or subscriptions. The data shared by
// every account (the search history, ownerless subscriptions) is tracked
// under SHARED_CLEANUP and stops once any account signs in.
const SHARED_CLEANUP = '\u0000shared';

type CleanupRun = (stillGone: () => boolean) => Promise<unknown>;
interface PendingCleanup {
  /** Sign-ins of this id under way (settlePendingCleanup); the cleanup holds while any is. */
  returning: number;
  /** A step was skipped for a sign-in: run it all again if that sign-in fails. */
  skipped: boolean;
  /** The cleanup itself, with its options (discardQueuedSends), to run again. */
  run: CleanupRun;
  done: Promise<void>;
}
const pendingCleanups = new Map<string, PendingCleanup>();

function isRegistered(key: string): boolean {
  const { accounts } = useAccountStore.getState();
  return key === SHARED_CLEANUP ? accounts.length > 0 : accounts.some((a) => a.id === key);
}

// Start a tracked cleanup. Resolves when it ends; never rejects.
function startCleanup(key: string, run: CleanupRun): Promise<void> {
  const record: PendingCleanup = { returning: 0, skipped: false, run, done: Promise.resolve() };
  const stillGone = () => {
    const gone = record.returning === 0 && !isRegistered(key);
    if (!gone) record.skipped = true;
    return gone;
  };
  record.done = (async () => {
    try {
      await run(stillGone);
    } catch (e) {
      console.warn('[sign-out] cleanup failed', e);
    } finally {
      if (pendingCleanups.get(key) === record) pendingCleanups.delete(key);
    }
  })();
  pendingCleanups.set(key, record);
  return record.done;
}

// A sign-in of `accountId` is starting: hold its sign-out cleanup (and the
// shared one) before their next step, and give the step in flight a bounded
// time to end, so the cleanup and the new sign-in never overlap. The hold
// lasts until the returned release, which every sign-in calls when it ends,
// however it ends. A sign-in that failed (a wrong password, a network error,
// an abandoned hand-off, a full registry) leaves the account signed out, so
// a cleanup that skipped steps for it runs again from the start: its steps
// are idempotent clears, and leaving them undone would keep the account's
// data (and queued sends the user chose to discard) on the device.
async function settlePendingCleanup(accountId: string): Promise<() => void> {
  const held: Array<[string, PendingCleanup]> = [];
  for (const key of [accountId, SHARED_CLEANUP]) {
    const pending = pendingCleanups.get(key);
    if (!pending) continue;
    pending.returning++;
    held.push([key, pending]);
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const [key, record] of held) {
      record.returning--;
      if (record.returning > 0 || !record.skipped || isRegistered(key)) continue;
      record.skipped = false;
      void startCleanup(key, record.run);
    }
  };
  if (held.length) await waitAtMost(Promise.all(held.map(([, r]) => r.done)));
  return release;
}

// Forget a signed-out account's device data, tracked, waiting at most
// EVICTION_CLEANUP_TIMEOUT_MS. Whether it was the last account is read when
// that step is reached.
function forgetSignedOut(account: { appAccountId: string; serverUrl?: string | null; username?: string | null }, discardQueuedSends?: boolean): Promise<void> {
  return waitAtMost(startCleanup(account.appAccountId, (stillGone) => forgetAccountData(account, {
    lastAccount: () => useAccountStore.getState().accounts.length === 0,
    discardQueuedSends,
    stillGone,
  })));
}

// Forget the data every account shares, tracked as forgetSignedOut is.
function forgetSharedSignedOut(): Promise<void> {
  return waitAtMost(startCleanup(SHARED_CLEANUP, (stillGone) => forgetSharedData(stillGone)));
}

// An account dropped because its credentials are gone or were refused (a
// session that expired): what sign-out would have cleared beside them goes
// too, so signing the account in again later starts afresh instead of
// reusing an old relay, and none of its mail, identities, folder icons or
// calendar subscriptions stay behind on the device. Its queued sends stay on
// disk, as on sign-out. When it was the account shown (`wasActive`, and
// still shown once the credentials are gone), the same per-session stores
// sign-out resets go too (contacts, calendar, the viewer caches,
// notifications, filters) and the client lets go of it. The
// registry entry is read before it goes: it names whose calendar
// subscriptions to forget. The credentials go first, before anything that
// can fail or take long. Never throws and never hangs: a cleanup failure is
// logged, a slow one goes on in the background until the account returns.
async function evictAccount(accountId: string, opts: { clearCredentials: boolean; wasActive: boolean }): Promise<void> {
  const accountStore = useAccountStore.getState();
  const entry = accountStore.getAccountById(accountId);
  if (opts.clearCredentials) await jmapClient.clearAccountCredentials(accountId).catch(() => undefined);
  // Read again after that await: a switch that landed meanwhile shows
  // another account, whose stores and client must stay as they are.
  const shown = opts.wasActive && isShownAccount(accountId);
  afterCredentials(() => accountStore.removeAccount(accountId));
  if (shown) {
    afterCredentials(() => jmapClient.reset());
    clearAccountFeatureStores(accountId);
  } else {
    afterCredentials(() => useEmailStore.getState().removeAccount(accountId));
    afterCredentials(() => dropPendingMailFolder(accountId));
  }
  const account = { appAccountId: accountId, serverUrl: entry?.serverUrl, username: entry?.username };
  await waitAtMost(startCleanup(accountId, async (stillGone) => {
    // Each under the guard: one that ran after a new sign-in of the account
    // would delete its new id token or relay.
    if (stillGone()) await waitAtMost(deleteIdToken(accountId));
    if (stillGone()) await waitAtMost(clearStoredRelayBaseUrl(accountId));
    await forgetAccountData(account, {
      lastAccount: () => useAccountStore.getState().accounts.length === 0,
      stillGone,
    });
  }));
}

// Best-effort RFC 7009 revocation of an account's refresh token on sign-out.
// QR-paired bundles are left alone: webmail up to 1.11 handed the phone the
// desktop's own refresh token, and newer ones hand out a separate grant whose
// refresh token only the webmail's token proxy understands.
// Resolves what ending the account's provider session needs (#905), read
// here while its credentials and registry entry are still in place, with the
// server it signed in to and its stored token endpoint for providerStillInUse.
type AccountProviderLogout = ProviderLogout & { serverUrl: string; tokenEndpoint?: string };

async function revokeStoredRefreshToken(accountId: string): Promise<AccountProviderLogout | null> {
  try {
    const entry = useAccountStore.getState().getAccountById(accountId);
    if (!entry) return null;
    const credentials = await jmapClient.getStoredCredentials(accountId);
    const providerLogout = await captureProviderLogout(accountId, entry.endSessionEndpoint, credentials).catch(() => null);
    const tokens = await jmapClient.getStoredOAuthTokens(accountId);
    if (tokens && tokens.source !== 'pairing') await revokeRefreshToken(entry.serverUrl, tokens);
    if (!providerLogout) return null;
    return {
      ...providerLogout,
      serverUrl: entry.serverUrl,
      ...(credentials?.tokenEndpoint ? { tokenEndpoint: credentials.tokenEndpoint } : {}),
    };
  } catch {
    // never block sign-out
    return null;
  }
}

// Scheme and host, compared without case and without the scheme's default
// port, as providerOf compares them.
function originOfUrl(url: string): string {
  const origin = url.toLowerCase().match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/)?.[0] ?? url.toLowerCase();
  return origin.replace(/^(https:\/\/[^/]*):443$/, '$1').replace(/^(http:\/\/[^/]*):80$/, '$1');
}

// Ending the provider's session (Keycloak's SSO session) also ends the
// refresh tokens of every other account signed in through it. So it waits
// for the last of them: none of the accounts still registered may sign in
// at the same provider. A hand-off account records no endpoint (the
// webmail's client holds its provider session), but it signed in through
// the same browser, so one on the same server counts as well, and so does
// one on another server whose token endpoint is on the same origin as the
// departing account's (a webmail elsewhere handing off to the same
// provider). A password or pairing account never used this browser's
// provider session and does not.
async function providerStillInUse(providerLogout: AccountProviderLogout, remaining: AccountEntry[]): Promise<boolean> {
  const provider = providerOf(providerLogout.endpoint);
  if (remaining.some((a) => providerOf(a.endSessionEndpoint) === provider)) return true;
  const origin = originOfUrl(providerLogout.serverUrl);
  const tokenOrigin = providerLogout.tokenEndpoint ? originOfUrl(providerLogout.tokenEndpoint) : null;
  for (const a of remaining) {
    const sameServer = originOfUrl(a.serverUrl) === origin;
    if (!sameServer && !tokenOrigin) continue;
    // An account whose credentials cannot be read may be a hand-off one at
    // this provider, on this server or another: count it, as ending a
    // provider session another account needs is worse than leaving one open.
    const credentials = await jmapClient.getStoredCredentials(a.id).catch(() => 'unreadable' as const);
    if (credentials === 'unreadable') return true;
    if (credentials?.tokenSource !== 'handoff') continue;
    if (sameServer) return true;
    if (credentials.tokenEndpoint && originOfUrl(credentials.tokenEndpoint) === tokenOrigin) return true;
  }
  return false;
}

// Fire-and-forget, once the local sign-out is done: the browser may stay open
// as long as the user likes and must not hold anything up. One at a time, as
// the browser holds a single auth session. The accounts still signed in are
// read now, before anything else can change them.
function endProviderSessionsLater(providerLogouts: AccountProviderLogout[]): void {
  if (providerLogouts.length === 0) return;
  const remaining = useAccountStore.getState().accounts;
  void (async () => {
    for (const l of providerLogouts) {
      if (!(await providerStillInUse(l, remaining).catch(() => true))) await endProviderSession(l);
    }
  })();
}

// What a direct PKCE sign-in keeps for ending the provider session on
// sign-out: the id token under the account in SecureStore, the endpoint from
// its own discovery document on its registry entry. Any other sign-in of the
// account forgets both. Best-effort: without them sign-out only skips the
// provider step.
async function recordProviderSession(
  accountId: string,
  provider: { idToken?: string; endSessionEndpoint?: string } | undefined,
): Promise<void> {
  const endSessionEndpoint = usableEndSessionEndpoint(provider?.endSessionEndpoint);
  const accounts = useAccountStore.getState();
  if (accounts.getAccountById(accountId)?.endSessionEndpoint !== endSessionEndpoint) {
    accounts.updateAccount(accountId, { endSessionEndpoint });
  }
  await storeIdToken(accountId, endSessionEndpoint ? provider?.idToken : undefined).catch(() => undefined);
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
  provider?: { idToken?: string; endSessionEndpoint?: string },
): Promise<void> {
  // Adding an account must not destroy the live one: the singleton keeps the
  // previous connection until the new sign-in has actually succeeded, and a
  // failure puts it straight back.
  const previous = opts?.addAccount && get().isAuthenticated ? jmapClient.snapshot() : null;

  let connected: { session: JMAPSession; username: string; accountId: string };
  try {
    connected = await jmapClient.connectWithOAuth(result.serverUrl, result.tokens);
  } catch (err) {
    // Superseded by a newer load: that one owns the client; don't undo it.
    if (previous && !(isStaleLoad(err))) jmapClient.restoreSnapshot(previous);
    throw err;
  }
  const { session, username, accountId } = connected;

  const accountStore = useAccountStore.getState();
  const wasRegistered = !!accountStore.getAccountById(accountId);
  // The account may be one signed out moments ago whose cleanup still runs.
  // Released once registered (or undone), so a failure lets it run again.
  const releaseCleanup = await settlePendingCleanup(accountId);
  try {
    accountStore.addAccount({
      serverUrl: result.serverUrl.replace(/\/+$/, ''),
      username,
      displayName: username,
      email: username,
      lastLoginAt: Date.now(),
      isConnected: true,
      hasError: false,
    });
  } catch (err) {
    await undoConnect(previous, accountId, wasRegistered);
    throw err;
  } finally {
    releaseCleanup();
  }
  await recordProviderSession(accountId, result.tokens.source === 'native' ? provider : undefined);
  // Contacts/calendar are still single-bucket, so wipe those now that the
  // new account is registered and the one the client serves.
  if (previous) {
    useContactsStore.getState().reset();
    useCalendarStore.getState().reset();
    resetPendingNotificationStores();
  }
  accountStore.setActiveAccount(accountId);
  useEmailStore.getState().setActiveAccount(accountId);

  applyConnectedState(set, session, result.serverUrl.replace(/\/+$/, ''), username, accountId);
  // Start on the folder list now rather than once the mail screen has
  // mounted; the screen joins this load.
  void useEmailStore.getState().fetchMailboxes();
  void syncAccountDisplayName(accountId);
  // Device sync (#34): drop a "sign in again" notice, resume a suspended account.
  void deviceSyncSignedIn(accountId);
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
  recordJmapAccountId(accountId);
}

/**
 * Keeps the login's JMAP account id on its account entry, so a composer
 * opened after an offline cold start can still queue a send for it. Written
 * only while the client serves that very account: a connect that lands
 * mid-switch must never stamp one account's id onto another.
 */
function recordJmapAccountId(accountId: string): void {
  const jmapAccountId = jmapClient.connectedAccountId;
  if (!jmapAccountId || !clientServesAccount(accountId)) return;
  const accounts = useAccountStore.getState();
  if (accounts.getAccountById(accountId)?.jmapAccountId === jmapAccountId) return;
  accounts.updateAccount(accountId, { jmapAccountId });
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

  login: async (serverUrl, typedUsername, password, opts) => {
    set({ isLoading: true, error: null });
    // Sign in with the ASCII (punycode) form of an IDN domain, the form
    // Stalwart stores, so `user@bücher.de` and `user@xn--bcher-kva.de` are one
    // account (one id, one set of stored credentials).
    const username = toAsciiEmail(typedUsername);
    // Adding an additional account: keep the live connection until the new
    // sign-in succeeded so a typo doesn't kill the current session.
    const previous = opts?.addAccount && get().isAuthenticated ? jmapClient.snapshot() : null;
    const accountId = generateAccountId(username, serverUrl.replace(/\/+$/, ''));
    // Released when the sign-in ends, however it ends (see settlePendingCleanup).
    let releaseCleanup = () => undefined as void;
    try {
      // A new account with no room left fails here, before connect swaps
      // the live client over or stores credentials for it.
      assertRoomForAccount(accountId);
      const wasRegistered = !!useAccountStore.getState().getAccountById(accountId);
      // The account may be one signed out moments ago whose cleanup still runs.
      releaseCleanup = await settlePendingCleanup(accountId);
      let session: JMAPSession;
      try {
        session = await jmapClient.connect(serverUrl, username, password, opts?.totp);
      } catch (err) {
        // Superseded by a newer load: that one owns the client; don't undo it.
        if (previous && !(isStaleLoad(err))) jmapClient.restoreSnapshot(previous);
        throw err;
      }

      const accountStore = useAccountStore.getState();
      try {
        accountStore.addAccount({
          serverUrl: serverUrl.replace(/\/+$/, ''),
          username,
          displayName: username,
          email: username,
          lastLoginAt: Date.now(),
          isConnected: true,
          hasError: false,
        });
      } catch (err) {
        await undoConnect(previous, accountId, wasRegistered);
        throw err;
      }
      await recordProviderSession(accountId, undefined);
      // Contacts/calendar are still single-bucket, so wipe those now that
      // the new account is registered and the one the client serves.
      if (previous) {
        useContactsStore.getState().reset();
        useCalendarStore.getState().reset();
        resetPendingNotificationStores();
      }
      accountStore.setActiveAccount(accountId);
      // Swap the email store's active view to the new account so the rest of
      // this function (and refetchFeatureStores) writes to the right bucket.
      useEmailStore.getState().setActiveAccount(accountId);

      applyConnectedState(set, session, serverUrl.replace(/\/+$/, ''), username, accountId);
      set({ pendingTotpLogin: null });
      // Start on the folder list now rather than once the mail screen has
      // mounted; the screen joins this load.
      void useEmailStore.getState().fetchMailboxes();
      void syncAccountDisplayName(accountId);
      // Device sync (#34): drop a "sign in again" notice, resume a suspended account.
      void deviceSyncSignedIn(accountId);
    } catch (err) {
      if (isStaleLoad(err)) {
        // A newer load took the client over; it sets its own state.
        set({ isLoading: false });
        throw err;
      }
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
    } finally {
      releaseCleanup();
    }
  },

  loginWithToken: async (serverUrl, typedToken, opts) => {
    set({ isLoading: true, error: null });
    const fail = (err: unknown): never => {
      // The stored message is a code or a server message, never the token.
      set({ isLoading: false, error: err instanceof Error ? err.message : 'Connection failed' });
      throw err;
    };
    const token = cleanAccessToken(typedToken);
    if (!token) return fail(new AuthenticationError('invalid_token'));
    // A full registry refuses before anything is connected or stored.
    refuseAddWhenFull(set, opts);
    const base = serverUrl.replace(/\/+$/, '');
    // Same as `login`: the live connection is kept until the new sign-in has
    // succeeded, and a failure puts it straight back.
    const previous = opts?.addAccount && get().isAuthenticated ? jmapClient.snapshot() : null;

    let session: JMAPSession;
    try {
      session = await jmapClient.connectWithToken(base, token);
    } catch (err) {
      if (isStaleLoad(err)) {
        // A newer load took the client over; it sets its own state.
        set({ isLoading: false });
        throw err;
      }
      if (previous) jmapClient.restoreSnapshot(previous);
      // A 401 is a rejected token; a 403 reaches us as a failed session fetch.
      // The missing-username error and a second-factor demand are not a bad
      // token: they pass through for their own copy.
      const rejected = !(err instanceof Error && (err.name === 'TotpRequiredError' || err.message === NO_ACCOUNT_NAME))
        && (err instanceof AuthenticationError
          || (err instanceof Error && /session discovery failed: 40[13]\b/i.test(err.message)));
      return fail(rejected ? new AuthenticationError('invalid_token') : err);
    }

    // connectWithToken guarantees a username (it throws without one).
    const username = session.username as string;
    const accountId = generateAccountId(username, base);
    const accountStore = useAccountStore.getState();
    const wasRegistered = !!accountStore.getAccountById(accountId);
    // The account may be one signed out moments ago whose cleanup still
    // runs. Released once registered (or undone), so a failure lets it run
    // again.
    const releaseCleanup = await settlePendingCleanup(accountId);
    try {
      assertRoomForAccount(accountId);
      accountStore.addAccount({
        serverUrl: base,
        username,
        displayName: username,
        email: username,
        lastLoginAt: Date.now(),
        isConnected: true,
        hasError: false,
      });
    } catch (err) {
      await undoConnect(previous, accountId, wasRegistered);
      return fail(err);
    } finally {
      releaseCleanup();
    }
    await recordProviderSession(accountId, undefined);
    if (previous) {
      useContactsStore.getState().reset();
      useCalendarStore.getState().reset();
      resetPendingNotificationStores();
    }
    accountStore.setActiveAccount(accountId);
    useEmailStore.getState().setActiveAccount(accountId);

    applyConnectedState(set, session, base, username, accountId);
    void useEmailStore.getState().fetchMailboxes();
    void syncAccountDisplayName(accountId);
    void deviceSyncSignedIn(accountId);
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
    let provider;
    try {
      const metadata = await discoverOAuthMetadata(base);
      if (!metadata) throw new HandoffError('This server does not offer OAuth sign-in');
      // The id token stays out of the stored bundle.
      const { idToken, ...bundle } = await loginWithPkce(base, metadata, { addAccount: opts?.addAccount });
      tokens = bundle;
      provider = { idToken, endSessionEndpoint: metadata.end_session_endpoint };
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
      await completeOAuthHandoff(set, get, { flow: 'oauth', serverUrl: base, tokens }, opts, provider);
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

  logout: async (opts) => {
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
      await clearStoredRelayBaseUrl(currentId).catch(() => undefined);
    } else {
      await teardownPushNotifications().catch(() => undefined);
    }

    // Read before the credentials and registry entry go: they name whose
    // subscriptions to forget.
    const entry = currentId ? accountStore.getAccountById(currentId) : undefined;
    const serverUrl = entry?.serverUrl ?? get().serverUrl;
    const username = entry?.username ?? get().username;

    // Clear credentials for this account first
    let providerLogout: AccountProviderLogout | null = null;
    if (currentId) {
      providerLogout = await revokeStoredRefreshToken(currentId);
      await jmapClient.clearAccountCredentials(currentId);
      afterCredentials(() => accountStore.removeAccount(currentId));
    } else {
      await jmapClient.logout();
    }

    afterCredentials(() => jmapClient.reset());
    afterCredentials(() => clearAccountFeatureStores(currentId));
    const lastAccount = useAccountStore.getState().accounts.length === 0;
    // Best-effort and bounded: a cleanup error or a stuck storage call must
    // not leave the app half signed out.
    if (currentId) {
      await forgetSignedOut({ appAccountId: currentId, serverUrl, username }, opts?.discardQueuedSends);
    } else if (lastAccount) {
      await forgetSharedSignedOut();
    }

    // Switch to next remaining account, if any
    // Read the registry live: the snapshot above still lists the removed account.
    const live = useAccountStore.getState();
    const remaining = live.accounts.filter((a) => a.id !== currentId);
    if (remaining.length > 0) {
      const preferred = live.getDefaultAccount();
      const next = preferred && preferred.id !== currentId ? preferred : remaining[0];
      try {
        await get().switchAccount(next.id);
        // switchAccount can return without switching (failed load, no session).
        if (get().activeAccountId === next.id) {
          endProviderSessionsLater(providerLogout ? [providerLogout] : []);
          return;
        }
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
    endProviderSessionsLater(providerLogout ? [providerLogout] : []);
  },

  logoutAll: async (opts) => {
    const accountStore = useAccountStore.getState();
    const signedOut = [...accountStore.accounts];
    const ids = signedOut.map((a) => a.id);
    // Device sync (#34): as in logout, for every account.
    if (!(await releaseDeviceSyncBeforeSignOut(ids))) return;
    await teardownPushNotifications().catch(() => undefined);
    // The teardown clears every relay too, but stops at its first failure:
    // a relay left behind would be reused if the account signed in again.
    for (const id of ids) await clearStoredRelayBaseUrl(id).catch(() => undefined);
    // Each provider's session is ended once, with the active account's id
    // token when it signed in there, else the first account's that did.
    const activeId = get().activeAccountId;
    const byProvider = new Map<string, AccountProviderLogout>();
    for (const id of [...ids].sort((a, b) => Number(b === activeId) - Number(a === activeId))) {
      const providerLogout = await revokeStoredRefreshToken(id);
      const provider = providerLogout ? providerOf(providerLogout.endpoint) : null;
      if (providerLogout && provider && !byProvider.has(provider)) byProvider.set(provider, providerLogout);
    }
    await jmapClient.clearAllCredentials(ids);
    // Out of the registry before the cleanup: a cleanup only runs while its
    // account is not registered (forgetSignedOut).
    for (const id of ids) afterCredentials(() => accountStore.removeAccount(id));
    afterCredentials(() => jmapClient.reset());
    clearAllFeatureStores();
    // Each account's cleanup, and the shared one, with its own bound, so one
    // that hangs does not keep the others from running. Each forgets only
    // its own account (lastAccount stays false); the shared data goes last.
    for (const a of signedOut) {
      await waitAtMost(startCleanup(a.id, (stillGone) => forgetAccountData(
        { appAccountId: a.id, serverUrl: a.serverUrl, username: a.username },
        { lastAccount: false, discardQueuedSends: opts?.discardQueuedSends, stillGone },
      )));
    }
    await forgetSharedSignedOut();

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
    endProviderSessionsLater([...byProvider.values()]);
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
    resetPendingNotificationStores();
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
        // Credentials missing - evict stale entry and surface error. The
        // previous account gets the client back first, so nothing it sends
        // while the cleanup runs goes out as the dropped one.
        restorePrevious();
        await evictAccount(accountId, { clearCredentials: true, wasActive: false });
        set({ isLoading: false, error: 'Session expired for this account' });
        return;
      }
    } catch (err) {
      if (isStaleLoad(err)) {
        // A newer load (another switch, a session retry) owns the client and
        // sets its own state: restoring the previous one would undo it.
        set({ isLoading: false });
        return;
      }
      if (err instanceof AuthenticationError) {
        restorePrevious();
        await evictAccount(accountId, { clearCredentials: true, wasActive: false });
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

    // Filters and the auto-reply are keyed to "own account" (null) for both
    // logins, so nothing else tells them the account changed; saving the old
    // rules would write them into the new account. Cleared only once the
    // switch succeeded, so a failed one leaves the current account's intact.
    useFilterStore.getState().clearState();
    useVacationStore.getState().reset();
    applyConnectedState(set, session, target.serverUrl, target.username, accountId);
    refetchFeatureStores();
    void syncAccountDisplayName(accountId);
  },

  removeAccount: async (accountId, opts) => {
    if (get().activeAccountId === accountId) {
      await get().logout(opts);
      return;
    }
    const accountStore = useAccountStore.getState();
    const account = accountStore.getAccountById(accountId);
    if (!account) return;
    // Device sync (#34): as in logout.
    if (!(await releaseDeviceSyncBeforeSignOut([accountId]))) return;
    await teardownPushNotificationsForAccount(accountId).catch(() => undefined);
    await clearStoredRelayBaseUrl(accountId).catch(() => undefined);
    const providerLogout = await revokeStoredRefreshToken(accountId);
    await jmapClient.clearAccountCredentials(accountId).catch(() => undefined);
    afterCredentials(() => useEmailStore.getState().removeAccount(accountId));
    afterCredentials(() => clearViewerCaches());
    afterCredentials(() => dropPendingMailFolder(accountId));
    afterCredentials(() => accountStore.removeAccount(accountId));
    await forgetSignedOut(
      { appAccountId: accountId, serverUrl: account.serverUrl, username: account.username },
      opts?.discardQueuedSends,
    );
    endProviderSessionsLater(providerLogout ? [providerLogout] : []);
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
        // Whether to reopen the last folder is read below.
        useSettingsStore.getState().hydrate(),
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

      // Drop offline mail left behind by accounts no longer registered; not
      // awaited so a slow storage scan never delays the restore. Only once
      // the registry loaded: one that timed out reads as empty, and every
      // account's mail would look orphaned.
      if (useAccountStore.persist.hasHydrated()) {
        void sweepOrphanedOfflineCache(useAccountStore.getState().accounts.map((a) => a.id)).catch((e) =>
          console.warn('[offline-cache] orphan sweep failed', e),
        );
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
      // A cold start opens the Inbox, or the last folder when the user asked.
      // Called here, not left to setActiveAccount: that returns early when
      // the persisted state already names this account (the usual cold
      // start), so its own view reset would never run.
      useEmailStore.getState().openStartFolder(useSettingsStore.getState().restoreLastFolder);

      try {
        const ok = await jmapClient.loadAccount(target.id);
        if (!ok) {
          // No stored credentials (or corrupt) — genuine logout. A corrupt
          // blob is deleted too, so it does not linger.
          await evictAccount(target.id, { clearCredentials: true, wasActive: true });
          set({ isLoading: false, hasRestoredSession: true });
          return false;
        }
      } catch (err) {
        if (isStaleLoad(err) && get().session) {
          // A newer load already brought a session up; it set its own state.
          set({ isLoading: false, hasRestoredSession: true });
          return true;
        }
        // Superseded without a session yet: stay signed in offline, as for an
        // unreachable server, and let the session retry take over.
        if (err instanceof NetworkError || isStaleLoad(err)) {
          // Server unreachable. Keep credentials, mark account offline, and
          // surface the cached UI so the user can still browse persisted
          // mail / contacts / calendar. The login screen would lose their
          // settings without recourse, which is the bug we're fixing here.
          accountStore.setActiveAccount(target.id);
          if (err instanceof NetworkError) {
            accountStore.updateAccount(target.id, {
              isConnected: false,
              hasError: true,
              errorMessage: err.message,
            });
          }
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
          await evictAccount(target.id, { clearCredentials: true, wasActive: true });
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
    // Concurrent callers (the retry timer, an online edge, the 401 handler)
    // share one attempt: two overlapping loadAccount calls, a success then a
    // failure, could leave the client without a session while this store
    // holds a live one.
    return retrySessionFlight(activeAccountId);
  },

  refreshSessionFor: async (appAccountId) => {
    const serves = () => get().activeAccountId === appAccountId
      && !!get().session
      && clientServesAccount(appAccountId);
    if (!serves()) return false;
    let fresh: JMAPSession | null;
    try {
      fresh = await jmapClient.refreshSession();
    } catch {
      // Offline or refused: the live session stays; a 401 on a real request
      // takes the usual route.
      return false;
    }
    // A switch, sign-out or a dropped session meanwhile: that owns the state.
    if (!fresh || !serves() || jmapClient.currentSession !== fresh) return false;
    set({ session: fresh });
    return true;
  },

  clearError: () => set({ error: null }),
}));

// One attempt to bring back the session of `activeAccountId`; see retrySession.
async function attemptSessionRetry(activeAccountId: string): Promise<boolean> {
  if (useAuthStore.getState().session) return true;
  const accountStore = useAccountStore.getState();
  const target = accountStore.getAccountById(activeAccountId);
  if (!target) return false;
  try {
    const ok = await jmapClient.loadAccount(activeAccountId);
    if (!ok) return false;
    // The user switched accounts meanwhile; that switch sets its own state.
    if (useAuthStore.getState().activeAccountId !== activeAccountId) return false;
    accountStore.updateAccount(activeAccountId, {
      isConnected: true,
      hasError: false,
      errorMessage: undefined,
    });
    const fresh = jmapClient.currentSession!;
    applyConnectedState(useAuthStore.setState, fresh, target.serverUrl, target.username, activeAccountId);
    refetchFeatureStores();
    return true;
  } catch (err) {
    // StaleLoadError: a newer load owns the client; stay. NetworkError: stay.
    if (err instanceof AuthenticationError) {
      // Now we know the credentials are bad — fall back to logout flow.
      // Only while it is still the account shown: after a switch, the
      // per-session stores hold the other account's data.
      await evictAccount(activeAccountId, {
        clearCredentials: true,
        wasActive: useAuthStore.getState().activeAccountId === activeAccountId,
      });
      // Only if that account is still the active one: after a switch, the
      // user is signed in to the other account, which this says nothing about.
      if (useAuthStore.getState().activeAccountId !== activeAccountId) return false;
      useAuthStore.setState({
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
}

const retrySessionFlight = singleFlightByKey(attemptSessionRetry);

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
