import { describe, it, expect, vi, beforeEach } from 'vitest';

// A full account registry (MAX_ACCOUNTS): adding an account is refused before
// a pairing code is spent or a browser sign-in starts, and a sign-in that
// finds the registry full only once it has connected hands the live account
// its connection back instead of leaving the shared client signed in as the
// new account.

const session = { apiUrl: 'https://mail.example.com/jmap/' };

const request = vi.fn(async (calls: Array<[string, Record<string, unknown>, string]>) => ({
  methodResponses: calls.map(([name, , id]) => {
    if (name === 'Identity/get') return [name, { list: [{ id: 'i1', name: 'Ada', email: 'ada@example.com' }] }, id];
    if (name === 'Mailbox/get') return [name, { list: [{ id: 'mb-in', name: 'Inbox', role: 'inbox' }], state: 'mbs-1' }, id];
    return ['error', { type: 'forbidden' }, id];
  }),
}));

const LIVE_SNAPSHOT = { session: 'live-session', credentials: 'live-credentials', accountId: 'live-jmap' };

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    connect: vi.fn(async () => ({ apiUrl: 'https://mail.example.com/jmap/' })),
    connectWithOAuth: vi.fn(async () => ({
      session: { apiUrl: 'https://mail.example.com/jmap/' },
      username: 'ada@example.com',
      accountId: 'ada@example.com@mail.example.com',
    })),
    snapshot: vi.fn(() => LIVE_SNAPSHOT),
    restoreSnapshot: vi.fn(),
    reset: vi.fn(),
    clearAccountCredentials: vi.fn(async () => undefined),
    onAuthFailure: vi.fn(() => () => undefined),
    onTokenRefresh: vi.fn(() => () => undefined),
    hasAccountCapability: vi.fn(() => false),
    getAccountName: () => undefined,
    getSharedMailAccounts: () => [],
    request: (calls: Array<[string, Record<string, unknown>, string]>) => request(calls),
    accountId: 'acc-1',
    isConnected: true,
    currentSession: { apiUrl: 'https://mail.example.com/jmap/' },
    username: 'ada@example.com',
    serverUrl: 'https://mail.example.com',
  },
  AuthenticationError: class AuthenticationError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));

vi.mock('../../lib/push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
  clearStoredRelayBaseUrl: vi.fn(async () => undefined),
}));

vi.mock('../../lib/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/oauth')>()),
  redeemPairingCode: vi.fn(),
}));

vi.mock('../../lib/oauth-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/oauth-native')>()),
  discoverOAuthMetadata: vi.fn(),
  loginWithPkce: vi.fn(),
  probeWebmail: vi.fn(),
}));

import * as WebBrowser from 'expo-web-browser';
import { jmapClient } from '../../api/jmap-client';
import { redeemPairingCode, type HandoffResult } from '../../lib/oauth';
import { discoverOAuthMetadata, loginWithPkce, probeWebmail } from '../../lib/oauth-native';
import { AccountLimitError, MAX_ACCOUNTS } from '../../lib/account-utils';
import { useAccountStore, type AccountEntry } from '../account-store';
import { useAuthStore } from '../auth-store';

const WEBMAIL = 'https://webmail.example.org/mail';
const SERVER = 'https://mail.example.com';
const NEW_ID = 'ada@example.com@mail.example.com';
const redeem = redeemPairingCode as ReturnType<typeof vi.fn>;
const connect = jmapClient.connect as unknown as ReturnType<typeof vi.fn>;
const connectWithOAuth = jmapClient.connectWithOAuth as unknown as ReturnType<typeof vi.fn>;

const oauthResult: HandoffResult = {
  flow: 'oauth',
  serverUrl: SERVER,
  tokens: {
    accessToken: 'at',
    refreshToken: 'sealed-refresh',
    tokenEndpoint: `${WEBMAIL}/api/auth/pair/token`,
    clientId: 'bulwark-webmail',
    source: 'pairing',
  },
};

let codeCounter = 0;
function newCode(): string {
  codeCounter += 1;
  return `ffff${codeCounter.toString(16).padStart(60, '0')}`;
}

function entry(i: number): AccountEntry {
  return {
    id: `user${i}@mail${i}.example.net`,
    serverUrl: `https://mail${i}.example.net`,
    username: `user${i}`,
    displayName: `User ${i}`,
    email: `user${i}@example.net`,
    avatarColor: '#336699',
    lastLoginAt: 0,
    isConnected: true,
    hasError: false,
    isDefault: i === 0,
  };
}

// `count` accounts, the first one live.
function registry(count: number, extra: AccountEntry[] = []): void {
  const accounts = [...Array.from({ length: count - extra.length }, (_, i) => entry(i)), ...extra];
  useAccountStore.setState({ accounts, activeAccountId: accounts[0].id, defaultAccountId: accounts[0].id });
  useAuthStore.setState({
    isAuthenticated: true,
    isLoading: false,
    error: null,
    session: session as never,
    activeAccountId: accounts[0].id,
    username: accounts[0].username,
    serverUrl: accounts[0].serverUrl,
  });
}

// What a sign-in finishing elsewhere meanwhile does: takes the last free slot.
function fillLastSlotDuring<T>(result: T): () => Promise<T> {
  return async () => {
    const { accounts } = useAccountStore.getState();
    useAccountStore.setState({ accounts: [...accounts, entry(99)] });
    return result;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (probeWebmail as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  (discoverOAuthMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

describe('a full registry refuses before anything is spent', () => {
  it('keeps a pairing code unredeemed when adding an account', async () => {
    registry(MAX_ACCOUNTS);
    const code = newCode();

    await expect(useAuthStore.getState().loginViaPairing(WEBMAIL, code, { addAccount: true }))
      .rejects.toBeInstanceOf(AccountLimitError);
    expect(redeem).not.toHaveBeenCalled();
    expect(jmapClient.snapshot).not.toHaveBeenCalled();
    expect(connectWithOAuth).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({
      isAuthenticated: true,
      isLoading: false,
      activeAccountId: entry(0).id,
      error: `Maximum of ${MAX_ACCOUNTS} accounts reached`,
    });

    // Not spent: once there is room, the same code still works.
    registry(MAX_ACCOUNTS - 1);
    redeem.mockResolvedValueOnce(oauthResult);
    await useAuthStore.getState().loginViaPairing(WEBMAIL, code, { addAccount: true });
    expect(redeem).toHaveBeenCalledWith(WEBMAIL, code);
    expect(useAccountStore.getState().accounts).toHaveLength(MAX_ACCOUNTS);
    expect(useAuthStore.getState().activeAccountId).toBe(NEW_ID);
  });

  it('does not open the webmail or OAuth sign-in when adding an account', async () => {
    registry(MAX_ACCOUNTS);

    await expect(useAuthStore.getState().loginViaWebmail(SERVER, { addAccount: true }))
      .rejects.toBeInstanceOf(AccountLimitError);
    await expect(useAuthStore.getState().loginViaOAuth(SERVER, { addAccount: true }))
      .rejects.toBeInstanceOf(AccountLimitError);
    expect(probeWebmail).not.toHaveBeenCalled();
    expect(loginWithPkce).not.toHaveBeenCalled();
    expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ isLoading: false, activeAccountId: entry(0).id });
  });

  it('refuses a password sign-in for a new account before connecting', async () => {
    registry(MAX_ACCOUNTS);

    await expect(useAuthStore.getState().login(SERVER, 'ada@example.com', 'pw', { addAccount: true }))
      .rejects.toBeInstanceOf(AccountLimitError);
    expect(connect).not.toHaveBeenCalled();
    expect(jmapClient.restoreSnapshot).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ isLoading: false, activeAccountId: entry(0).id });
  });

  it('still signs in again to an account it already holds', async () => {
    const ada = { ...entry(5), id: NEW_ID, serverUrl: SERVER, username: 'ada@example.com' };
    registry(MAX_ACCOUNTS, [ada]);

    await useAuthStore.getState().login(SERVER, 'ada@example.com', 'pw', { addAccount: true });
    expect(connect).toHaveBeenCalled();
    expect(useAccountStore.getState().accounts).toHaveLength(MAX_ACCOUNTS);
    expect(useAuthStore.getState().activeAccountId).toBe(NEW_ID);
  });
});

describe('a registry that fills up while connecting', () => {
  it('gives the live account its connection back after an OAuth sign-in (pairing)', async () => {
    registry(MAX_ACCOUNTS - 1);
    redeem.mockResolvedValueOnce(oauthResult);
    connectWithOAuth.mockImplementationOnce(fillLastSlotDuring({
      session: { apiUrl: 'https://mail.example.com/jmap/' },
      username: 'ada@example.com',
      accountId: NEW_ID,
    }));

    await expect(useAuthStore.getState().loginViaPairing(WEBMAIL, newCode(), { addAccount: true }))
      .rejects.toBeInstanceOf(AccountLimitError);

    expect(jmapClient.restoreSnapshot).toHaveBeenCalledWith(LIVE_SNAPSHOT);
    // The new account's stored credentials don't outlive it.
    expect(jmapClient.clearAccountCredentials).toHaveBeenCalledWith(NEW_ID);
    expect(useAccountStore.getState().accounts.map((a) => a.id)).not.toContain(NEW_ID);
    expect(useAccountStore.getState().activeAccountId).toBe(entry(0).id);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, isLoading: false, activeAccountId: entry(0).id });
  });

  it('gives the live account its connection back after a password sign-in', async () => {
    registry(MAX_ACCOUNTS - 1);
    connect.mockImplementationOnce(fillLastSlotDuring({ apiUrl: 'https://mail.example.com/jmap/' }));

    await expect(useAuthStore.getState().login(SERVER, 'ada@example.com', 'pw', { addAccount: true }))
      .rejects.toBeInstanceOf(AccountLimitError);

    expect(jmapClient.restoreSnapshot).toHaveBeenCalledWith(LIVE_SNAPSHOT);
    expect(jmapClient.clearAccountCredentials).toHaveBeenCalledWith(NEW_ID);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, isLoading: false, activeAccountId: entry(0).id });
    expect(useAuthStore.getState().error).toBe(`Maximum of ${MAX_ACCOUNTS} accounts reached`);
  });

  it('keeps the credentials of an account it already held', async () => {
    const ada = { ...entry(5), id: NEW_ID, serverUrl: SERVER, username: 'ada@example.com' };
    registry(MAX_ACCOUNTS - 1, [ada]);
    // Held, so the update fits; make registering fail another way.
    const addAccount = useAccountStore.getState().addAccount;
    useAccountStore.setState({ addAccount: () => { throw new AccountLimitError(); } });
    try {
      await expect(useAuthStore.getState().login(SERVER, 'ada@example.com', 'pw', { addAccount: true }))
        .rejects.toBeInstanceOf(AccountLimitError);
    } finally {
      useAccountStore.setState({ addAccount });
    }
    expect(jmapClient.restoreSnapshot).toHaveBeenCalledWith(LIVE_SNAPSHOT);
    expect(jmapClient.clearAccountCredentials).not.toHaveBeenCalled();
  });
});
