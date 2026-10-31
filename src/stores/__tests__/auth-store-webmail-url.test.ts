import { describe, it, expect, vi, beforeEach } from 'vitest';

// The webmail an account signed in through (QR pairing, the browser
// hand-off) is kept on the account: its organisation policy is read from
// there. A sign-in straight to the mail server has none.

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
      accountId: 'ada@example.com@mail.example.com',
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
  runWebmailHandoff: vi.fn(),
}));

vi.mock('../../lib/oauth-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/oauth-native')>()),
  probeWebmail: vi.fn(async () => true),
}));

import { redeemPairingCode, runWebmailHandoff, type HandoffResult } from '../../lib/oauth';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';

const WEBMAIL = 'https://webmail.example.org/mail/';
const SERVER = 'https://mail.example.com';
const redeem = redeemPairingCode as ReturnType<typeof vi.fn>;
const handoff = runWebmailHandoff as ReturnType<typeof vi.fn>;

const oauthResult: HandoffResult = {
  flow: 'oauth',
  serverUrl: SERVER,
  tokens: { accessToken: 'at', refreshToken: 'rt', tokenEndpoint: `${SERVER}/auth/token`, clientId: 'bulwark-webmail', source: 'handoff' },
};
const passwordResult: HandoffResult = { flow: 'password', serverUrl: SERVER, username: 'ada@example.com', password: 'pw' };

let codeCounter = 0;
const newCode = () => (codeCounter += 1).toString(16).padStart(64, 'b');

const onlyAccount = () => {
  const { accounts } = useAccountStore.getState();
  expect(accounts).toHaveLength(1);
  return accounts[0];
};

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ isAuthenticated: false, isLoading: false, error: null, session: null, pendingTotpLogin: null });
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
});

describe('the webmail an account came through', () => {
  it('is kept for a pairing with an OAuth grant', async () => {
    redeem.mockResolvedValueOnce(oauthResult);
    await useAuthStore.getState().loginViaPairing(WEBMAIL, newCode());
    expect(onlyAccount().webmailUrl).toBe('https://webmail.example.org/mail');
  });

  it('is kept for a pairing with an app password', async () => {
    redeem.mockResolvedValueOnce(passwordResult);
    await useAuthStore.getState().loginViaPairing(WEBMAIL, newCode());
    expect(onlyAccount().webmailUrl).toBe('https://webmail.example.org/mail');
  });

  it('is kept for a browser hand-off, both flows', async () => {
    handoff.mockResolvedValueOnce(oauthResult);
    await useAuthStore.getState().loginViaWebmail(WEBMAIL);
    expect(onlyAccount().webmailUrl).toBe('https://webmail.example.org/mail');

    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
    handoff.mockResolvedValueOnce(passwordResult);
    await useAuthStore.getState().loginViaWebmail(WEBMAIL);
    expect(onlyAccount().webmailUrl).toBe('https://webmail.example.org/mail');
  });

  it('is kept when the hand-off password needs a second factor first', async () => {
    const { jmapClient } = await import('../../api/jmap-client');
    const totp = new Error('TOTP required');
    totp.name = 'TotpRequiredError';
    (jmapClient.connect as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(totp);
    handoff.mockResolvedValueOnce(passwordResult);
    await expect(useAuthStore.getState().loginViaWebmail(WEBMAIL)).rejects.toBe(totp);
    expect(useAccountStore.getState().accounts).toHaveLength(0);

    // The login screen asks for the code and signs in again with it.
    await useAuthStore.getState().login(SERVER, 'ada@example.com', 'pw', { totp: '123456' });
    expect(onlyAccount().webmailUrl).toBe('https://webmail.example.org/mail');
  });

  it('is not invented for a sign-in straight to the mail server', async () => {
    await useAuthStore.getState().login(SERVER, 'ada@example.com', 'pw');
    expect(onlyAccount().webmailUrl).toBeUndefined();
  });

  it('stays on the account when it signs in again directly', async () => {
    redeem.mockResolvedValueOnce(passwordResult);
    await useAuthStore.getState().loginViaPairing(WEBMAIL, newCode());
    await useAuthStore.getState().login(SERVER, 'ada@example.com', 'pw');
    expect(onlyAccount().webmailUrl).toBe('https://webmail.example.org/mail');
  });
});
