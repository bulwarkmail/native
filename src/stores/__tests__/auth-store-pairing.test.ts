import { describe, it, expect, vi, beforeEach } from 'vitest';

// Signing in with a code from the webmail's Link Mobile App: both answers the
// webmail can give (an OAuth grant, or an app password), first sign-in and
// Add account, the one-redemption guard, and the error once the code is spent.

const session = { apiUrl: 'https://mail.example.com/jmap/' };

const request = vi.fn(async (calls: Array<[string, Record<string, unknown>, string]>) => ({
  methodResponses: calls.map(([name, , id]) => {
    if (name === 'Identity/get') return [name, { list: [{ id: 'i1', name: 'Ada', email: 'ada@example.com' }] }, id];
    if (name === 'Mailbox/get') return [name, { list: [{ id: 'mb-in', name: 'Inbox', role: 'inbox' }], state: 'mbs-1' }, id];
    return ['error', { type: 'forbidden' }, id];
  }),
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    connect: vi.fn(async () => ({ apiUrl: 'https://mail.example.com/jmap/' })),
    connectWithOAuth: vi.fn(async () => ({
      session: { apiUrl: 'https://mail.example.com/jmap/' },
      username: 'ada@example.com',
      accountId: 'app-account-1',
    })),
    snapshot: vi.fn(() => ({ session: null, credentials: null, accountId: null })),
    restoreSnapshot: vi.fn(),
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
}));

vi.mock('../../lib/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/oauth')>()),
  redeemPairingCode: vi.fn(),
}));

import { jmapClient, AuthenticationError } from '../../api/jmap-client';
import { PairingError, redeemPairingCode, type HandoffResult } from '../../lib/oauth';
import { useAuthStore } from '../auth-store';

const WEBMAIL = 'https://webmail.example.org/mail';
const SERVER = 'https://mail.example.com';
const redeem = redeemPairingCode as ReturnType<typeof vi.fn>;
const connect = jmapClient.connect as unknown as ReturnType<typeof vi.fn>;
const connectWithOAuth = jmapClient.connectWithOAuth as unknown as ReturnType<typeof vi.fn>;

let codeCounter = 0;
// Every test uses fresh codes: the redeemed-code guard lives for the process.
function newCode(): string {
  codeCounter += 1;
  return codeCounter.toString(16).padStart(64, '0');
}

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

const passwordResult: HandoffResult = {
  flow: 'password',
  serverUrl: SERVER,
  username: 'ada@example.com',
  password: 'app-pass-123',
};

function signedOut() {
  useAuthStore.setState({ isAuthenticated: false, isLoading: false, error: null, session: null });
}

function signedIn() {
  useAuthStore.setState({ isAuthenticated: true, isLoading: false, error: null, session: session as never });
}

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
});

describe('loginViaPairing with an OAuth grant', () => {
  it('signs in with the redeemed tokens', async () => {
    redeem.mockResolvedValueOnce(oauthResult);
    const code = newCode();

    await useAuthStore.getState().loginViaPairing(WEBMAIL, code);

    expect(redeem).toHaveBeenCalledWith(WEBMAIL, code);
    expect(connectWithOAuth).toHaveBeenCalledWith(SERVER, oauthResult.flow === 'oauth' ? oauthResult.tokens : null);
    expect(jmapClient.snapshot).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, isLoading: false, error: null, serverUrl: SERVER });
  });

  it('adds an account next to the signed-in one', async () => {
    signedIn();
    redeem.mockResolvedValueOnce(oauthResult);

    await useAuthStore.getState().loginViaPairing(WEBMAIL, newCode(), { addAccount: true });

    // The live connection is kept until the new one works.
    expect(jmapClient.snapshot).toHaveBeenCalled();
    expect(connectWithOAuth).toHaveBeenCalled();
    expect(jmapClient.restoreSnapshot).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
});

describe('loginViaPairing with an app password', () => {
  it('signs in through the password login', async () => {
    redeem.mockResolvedValueOnce(passwordResult);

    await useAuthStore.getState().loginViaPairing(WEBMAIL, newCode());

    expect(connect).toHaveBeenCalledWith(SERVER, 'ada@example.com', 'app-pass-123', undefined);
    expect(connectWithOAuth).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, username: 'ada@example.com', serverUrl: SERVER });
  });

  it('passes add-account mode on to login', async () => {
    signedIn();
    redeem.mockResolvedValueOnce(passwordResult);
    const original = useAuthStore.getState().login;
    const login = vi.fn(async () => undefined);
    useAuthStore.setState({ login });
    try {
      await useAuthStore.getState().loginViaPairing(WEBMAIL, newCode(), { addAccount: true });
      expect(login).toHaveBeenCalledWith(SERVER, 'ada@example.com', 'app-pass-123', { addAccount: true });

      redeem.mockResolvedValueOnce(passwordResult);
      await useAuthStore.getState().loginViaPairing(WEBMAIL, newCode());
      expect(login).toHaveBeenLastCalledWith(SERVER, 'ada@example.com', 'app-pass-123', { addAccount: undefined });
    } finally {
      useAuthStore.setState({ login: original });
    }
  });

  it('adds an account through the real login, keeping the live one on failure', async () => {
    signedIn();
    redeem.mockResolvedValueOnce(passwordResult);
    connect.mockRejectedValueOnce(new AuthenticationError('Invalid credentials'));

    const err = await useAuthStore.getState().loginViaPairing(WEBMAIL, newCode(), { addAccount: true })
      .then(() => null, (e: unknown) => e);

    expect(jmapClient.snapshot).toHaveBeenCalled();
    expect(jmapClient.restoreSnapshot).toHaveBeenCalled();
    expect(err).toBeInstanceOf(PairingError);
    expect(err).toMatchObject({ reason: 'connect_failed', host: 'mail.example.com' });
  });

  it('leaves a second-factor prompt to the login screen', async () => {
    redeem.mockResolvedValueOnce(passwordResult);
    const totp = new Error('TOTP required');
    totp.name = 'TotpRequiredError';
    connect.mockRejectedValueOnce(totp);

    await expect(useAuthStore.getState().loginViaPairing(WEBMAIL, newCode())).rejects.toBe(totp);
    expect(useAuthStore.getState().pendingTotpLogin).toEqual({
      serverUrl: SERVER, username: 'ada@example.com', password: 'app-pass-123',
    });
    expect(useAuthStore.getState().isLoading).toBe(false);
  });
});

describe('loginViaPairing guards', () => {
  it('redeems a code once, even when it arrives twice', async () => {
    let resolve!: (value: HandoffResult) => void;
    redeem.mockImplementationOnce(() => new Promise<HandoffResult>((r) => { resolve = r; }));
    const code = newCode();

    const first = useAuthStore.getState().loginViaPairing(WEBMAIL, code);
    // Delivered again while the first is still on its way (a re-read launch URL).
    const second = await useAuthStore.getState().loginViaPairing(WEBMAIL, code).then(() => null, (e: unknown) => e);
    expect(second).toBeInstanceOf(PairingError);
    expect(second).toMatchObject({ reason: 'used', host: 'webmail.example.org' });

    resolve(oauthResult);
    await first;
    expect(useAuthStore.getState().isAuthenticated).toBe(true);

    // And after it went through.
    await expect(useAuthStore.getState().loginViaPairing(WEBMAIL, code)).rejects.toMatchObject({ reason: 'used' });
    expect(redeem).toHaveBeenCalledTimes(1);
  });

  it('lets a code be tried again when redeeming it failed', async () => {
    const code = newCode();
    redeem.mockRejectedValueOnce(new PairingError('network', 'Could not reach webmail.example.org', { host: 'webmail.example.org' }));
    await expect(useAuthStore.getState().loginViaPairing(WEBMAIL, code)).rejects.toMatchObject({ reason: 'network' });
    expect(useAuthStore.getState()).toMatchObject({ isLoading: false, error: 'Could not reach webmail.example.org' });

    redeem.mockResolvedValueOnce(oauthResult);
    await useAuthStore.getState().loginViaPairing(WEBMAIL, code);
    expect(redeem).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('says the code was used but connecting failed, naming the mail server', async () => {
    signedIn();
    redeem.mockResolvedValueOnce(oauthResult);
    connectWithOAuth.mockRejectedValueOnce(new AuthenticationError('401'));

    const err = await useAuthStore.getState().loginViaPairing(WEBMAIL, newCode(), { addAccount: true })
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(PairingError);
    expect(err).toMatchObject({ reason: 'connect_failed', host: 'mail.example.com' });
    expect((err as PairingError).cause).toBeInstanceOf(AuthenticationError);
    expect(jmapClient.restoreSnapshot).toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ isLoading: false, isAuthenticated: true });
    expect(useAuthStore.getState().error).toMatch(/Authentication rejected by server/);
  });
});
