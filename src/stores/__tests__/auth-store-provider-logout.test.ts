import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';

// Signing out of a direct PKCE sign-in also ends the identity provider's
// session (#905), for that account only, after the local sign-out.

const calls: string[] = [];

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    connectWithOAuth: vi.fn(),
    logout: vi.fn(),
    loadAccount: vi.fn(async () => false),
    clearAccountCredentials: vi.fn(async (id: string) => { calls.push(`clear ${id}`); }),
    clearAllCredentials: vi.fn(async (ids: string[]) => { calls.push(`clear all ${ids.join(',')}`); }),
    reset: vi.fn(),
    snapshot: vi.fn(() => ({ session: null, credentials: null, accountId: null })),
    restoreSnapshot: vi.fn(),
    onAuthFailure: vi.fn(() => () => undefined),
    onTokenRefresh: vi.fn(() => () => undefined),
    hasAccountCapability: vi.fn(() => false),
    getAccountName: () => undefined,
    getSharedMailAccounts: () => [],
    request: vi.fn(async () => { throw new Error('not mocked'); }),
    getStoredOAuthTokens: vi.fn(async () => null),
    getStoredCredentials: vi.fn(async () => null),
    connect: vi.fn(),
    accountId: 'acc-1',
    currentSession: { apiUrl: 'https://mail.example.com/jmap/' },
    username: 'user',
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

vi.mock('../account-data-cleanup', () => ({
  forgetAccountData: vi.fn(async () => undefined),
  forgetSharedData: vi.fn(async () => undefined),
}));

vi.mock('../../lib/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/oauth')>()),
  runWebmailHandoff: vi.fn(),
}));

vi.mock('../../lib/oauth-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/oauth-native')>()),
  discoverOAuthMetadata: vi.fn(),
  loginWithPkce: vi.fn(),
  revokeRefreshToken: vi.fn(async () => { calls.push('revoke'); }),
}));

import { jmapClient } from '../../api/jmap-client';
import { discoverOAuthMetadata, loginWithPkce } from '../../lib/oauth-native';
import type { OAuthTokens, OAuthTokenSource } from '../../lib/oauth';
import { idTokenKey } from '../../lib/provider-session';
import { generateAccountId } from '../../lib/account-utils';
import { useAuthStore } from '../auth-store';
import { useAccountStore, type AccountEntry } from '../account-store';

const mockOpen = WebBrowser.openAuthSessionAsync as ReturnType<typeof vi.fn>;
const mockGetItem = SecureStore.getItemAsync as ReturnType<typeof vi.fn>;
const storedTokens = jmapClient.getStoredOAuthTokens as unknown as ReturnType<typeof vi.fn>;
const storedCredentials = jmapClient.getStoredCredentials as unknown as ReturnType<typeof vi.fn>;

const SERVER = 'https://mail.example.com';
const SSO_LOGOUT = 'https://sso.example.com/realms/mail/protocol/openid-connect/logout';
const OTHER_LOGOUT = 'https://other-idp.example.net/logout';

function entry(username: string, endSessionEndpoint?: string): AccountEntry {
  return {
    id: generateAccountId(username, SERVER),
    serverUrl: SERVER,
    username,
    displayName: username,
    email: username,
    avatarColor: '#000',
    lastLoginAt: 0,
    isConnected: true,
    hasError: false,
    isDefault: false,
    ...(endSessionEndpoint ? { endSessionEndpoint } : {}),
  };
}

function bundle(source: OAuthTokenSource, clientId = 'bulwark'): OAuthTokens {
  return { accessToken: 'at', refreshToken: 'rt', tokenEndpoint: 'https://sso.example.com/token', clientId, source };
}

const ADA = entry('ada@example.com', SSO_LOGOUT);
const BOB = entry('bob@example.com', OTHER_LOGOUT);
// Another account at Ada's provider (another realm path, same origin).
const CY = entry('cy@example.com', 'https://sso.example.com/realms/other/protocol/openid-connect/logout');

// Per account: its token bundle and its kept id token.
function accounts(list: Array<[AccountEntry, OAuthTokens | null, string | null]>, activeId: string): void {
  useAccountStore.setState({ accounts: list.map(([e]) => e), activeAccountId: activeId, defaultAccountId: list[0][0].id });
  useAuthStore.setState({ isAuthenticated: true, activeAccountId: activeId, serverUrl: SERVER });
  storedTokens.mockImplementation(async (id: string) => list.find(([e]) => e.id === id)?.[1] ?? null);
  storedCredentials.mockImplementation(async (id: string) => {
    const [e, t] = list.find(([x]) => x.id === id) ?? [];
    if (!e || !t) return null;
    return {
      serverUrl: e.serverUrl, username: e.username, password: '', accessToken: t.accessToken,
      refreshToken: t.refreshToken, tokenEndpoint: t.tokenEndpoint, clientId: t.clientId, tokenSource: t.source,
    };
  });
  mockGetItem.mockImplementation(async (key: string) => list.find(([e]) => idTokenKey(e.id) === key)?.[2] ?? null);
}

function openedUrls(): URL[] {
  return mockOpen.mock.calls.map(([url]) => new URL(url as string));
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  mockOpen.mockImplementation(async () => {
    calls.push('browser');
    return { type: 'cancel' };
  });
  useAuthStore.setState({ isAuthenticated: false, activeAccountId: null, error: null, isLoading: false });
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
});

describe('signing out of a direct PKCE account', () => {
  it('ends that account\'s provider session once, after the local sign-out', async () => {
    accounts([[ADA, bundle('native'), 'ada-id-token'], [BOB, bundle('native', 'other-client'), 'bob-id-token']], ADA.id);

    await useAuthStore.getState().logout();
    await vi.waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));

    const [url] = openedUrls();
    expect(`${url.origin}${url.pathname}`).toBe(SSO_LOGOUT);
    expect(url.searchParams.get('id_token_hint')).toBe('ada-id-token');
    expect(url.searchParams.get('client_id')).toBe('bulwark');
    expect(url.searchParams.has('post_logout_redirect_uri')).toBe(false);
    expect(calls.indexOf('browser')).toBeGreaterThan(calls.indexOf(`clear ${ADA.id}`));
    expect(useAccountStore.getState().getAccountById(ADA.id)).toBeUndefined();
  });

  it('signs out locally even when the browser never answers', async () => {
    accounts([[ADA, bundle('native'), 'ada-id-token']], ADA.id);
    mockOpen.mockImplementationOnce(() => new Promise(() => undefined));

    await useAuthStore.getState().logout();

    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAccountStore.getState().accounts).toEqual([]);
  });

  it('ends the session for a sign-in that has no refresh token', async () => {
    accounts([[ADA, { ...bundle('native'), refreshToken: undefined }, 'ada-id-token']], ADA.id);
    storedTokens.mockResolvedValue(null);

    await useAuthStore.getState().logout();
    await vi.waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
    expect(openedUrls()[0].searchParams.get('id_token_hint')).toBe('ada-id-token');
  });

  it('keeps the provider session while another signed-in account still uses it, and ends it with the last', async () => {
    accounts([[ADA, bundle('native'), 'ada-id-token'], [CY, bundle('native'), 'cy-id-token']], ADA.id);

    await useAuthStore.getState().removeAccount(CY.id);
    await Promise.resolve();
    expect(mockOpen).not.toHaveBeenCalled();

    await useAuthStore.getState().logout();
    await vi.waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
    expect(openedUrls()[0].searchParams.get('id_token_hint')).toBe('ada-id-token');
  });

  it('signing out of everything ends each provider once, one after the other', async () => {
    accounts([
      [ADA, bundle('native'), 'ada-id-token'],
      [BOB, bundle('native', 'other-client'), 'bob-id-token'],
      [CY, bundle('native'), 'cy-id-token'],
    ], CY.id);
    let closeFirst: () => void = () => undefined;
    mockOpen.mockImplementationOnce(() => new Promise((resolve) => { closeFirst = () => resolve({ type: 'cancel' }); }));

    await useAuthStore.getState().logoutAll();
    await vi.waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
    // The browser holds one auth session: the next waits for this one.
    expect(openedUrls()[0].searchParams.get('id_token_hint')).toBe('cy-id-token');
    closeFirst();
    await vi.waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(2));
    expect(openedUrls()[1].searchParams.get('id_token_hint')).toBe('bob-id-token');
    await Promise.resolve();
    expect(mockOpen).toHaveBeenCalledTimes(2);
  });

  it('signs out locally when the browser fails', async () => {
    accounts([[ADA, bundle('native'), 'ada-id-token']], ADA.id);
    mockOpen.mockRejectedValueOnce(new Error('no browser'));

    await useAuthStore.getState().logout();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('opens nothing for a hand-off or pairing sign-in', async () => {
    for (const source of ['handoff', 'pairing'] as const) {
      accounts([[ADA, bundle(source), 'stale-id-token']], ADA.id);
      await useAuthStore.getState().logout();
    }
    await Promise.resolve();
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it('opens nothing when the provider advertises no end-session endpoint', async () => {
    accounts([[entry('ada@example.com'), bundle('native'), 'ada-id-token']], ADA.id);
    await useAuthStore.getState().logout();
    await Promise.resolve();
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it('ends only the removed account\'s provider session when another account is removed', async () => {
    accounts([[ADA, bundle('native'), 'ada-id-token'], [BOB, bundle('native', 'other-client'), 'bob-id-token']], ADA.id);

    await useAuthStore.getState().removeAccount(BOB.id);
    await vi.waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));

    const [url] = openedUrls();
    expect(`${url.origin}${url.pathname}`).toBe(OTHER_LOGOUT);
    expect(url.searchParams.get('id_token_hint')).toBe('bob-id-token');
    expect(url.searchParams.get('client_id')).toBe('other-client');
    expect(calls.indexOf('browser')).toBeGreaterThan(calls.indexOf(`clear ${BOB.id}`));
    expect(useAuthStore.getState().activeAccountId).toBe(ADA.id);
  });

  it('signing out of everything starts with the active account\'s provider', async () => {
    accounts([[ADA, bundle('native'), 'ada-id-token'], [BOB, bundle('native', 'other-client'), 'bob-id-token']], BOB.id);

    await useAuthStore.getState().logoutAll();
    await vi.waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(2));

    const [first, second] = openedUrls();
    expect(`${first.origin}${first.pathname}`).toBe(OTHER_LOGOUT);
    expect(first.searchParams.get('id_token_hint')).toBe('bob-id-token');
    expect(second.searchParams.get('id_token_hint')).toBe('ada-id-token');
    expect(calls.indexOf('browser')).toBeGreaterThan(calls.indexOf(`clear all ${ADA.id},${BOB.id}`));
  });

  it('signing out of everything picks the first eligible account when the active one is not', async () => {
    accounts([[BOB, bundle('pairing'), null], [ADA, bundle('native'), 'ada-id-token']], BOB.id);

    await useAuthStore.getState().logoutAll();
    await vi.waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));

    expect(openedUrls()[0].searchParams.get('id_token_hint')).toBe('ada-id-token');
  });
});

describe('a direct PKCE sign-in', () => {
  const metadata = {
    authorization_endpoint: 'https://sso.example.com/auth',
    token_endpoint: 'https://sso.example.com/token',
    end_session_endpoint: SSO_LOGOUT,
  };

  beforeEach(() => {
    (jmapClient.connectWithOAuth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: { apiUrl: `${SERVER}/jmap/` },
      username: 'ada@example.com',
      accountId: ADA.id,
    });
  });

  it('keeps the id token under its account and the endpoint on its entry, never in the bundle', async () => {
    (discoverOAuthMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(metadata);
    (loginWithPkce as ReturnType<typeof vi.fn>).mockResolvedValue({ ...bundle('native'), idToken: 'ada-id-token' });

    await useAuthStore.getState().loginViaOAuth(SERVER);

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(idTokenKey(ADA.id), 'ada-id-token');
    expect(useAccountStore.getState().getAccountById(ADA.id)?.endSessionEndpoint).toBe(SSO_LOGOUT);
    const [, connectedWith] = (jmapClient.connectWithOAuth as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(connectedWith).not.toHaveProperty('idToken');
  });

  it('keeps no endpoint the id token must not travel to', async () => {
    (discoverOAuthMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({ ...metadata, end_session_endpoint: 'http://sso.example.com/logout' });
    (loginWithPkce as ReturnType<typeof vi.fn>).mockResolvedValue({ ...bundle('native'), idToken: 'ada-id-token' });

    await useAuthStore.getState().loginViaOAuth(SERVER);

    expect(useAccountStore.getState().getAccountById(ADA.id)?.endSessionEndpoint).toBeUndefined();
  });

  it('a later hand-off sign-in of the same account forgets what the PKCE one kept', async () => {
    useAccountStore.setState({ accounts: [ADA], activeAccountId: null, defaultAccountId: ADA.id });
    const { runWebmailHandoff } = await import('../../lib/oauth');
    vi.mocked(runWebmailHandoff).mockResolvedValueOnce({ flow: 'oauth', serverUrl: SERVER, tokens: bundle('handoff') });

    await useAuthStore.getState().loginViaWebmail(SERVER);

    expect(useAccountStore.getState().getAccountById(ADA.id)?.endSessionEndpoint).toBeUndefined();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(idTokenKey(ADA.id));
  });

  it('a later password sign-in of the same account forgets what the PKCE one kept', async () => {
    useAccountStore.setState({ accounts: [ADA], activeAccountId: null, defaultAccountId: ADA.id });
    (jmapClient.connect as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ apiUrl: `${SERVER}/jmap/` });

    await useAuthStore.getState().login(SERVER, 'ada@example.com', 'pw');

    expect(useAccountStore.getState().getAccountById(ADA.id)?.endSessionEndpoint).toBeUndefined();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(idTokenKey(ADA.id));
  });
});

describe('an account evicted for missing credentials', () => {
  it('loses its kept id token', async () => {
    accounts([[ADA, bundle('native'), 'ada-id-token'], [BOB, bundle('native'), 'bob-id-token']], ADA.id);

    await useAuthStore.getState().switchAccount(BOB.id);

    expect(useAccountStore.getState().getAccountById(BOB.id)).toBeUndefined();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(idTokenKey(BOB.id));
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalledWith(idTokenKey(ADA.id));
  });
});
