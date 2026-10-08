import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import {
  buildEndSessionUrl,
  captureProviderLogout,
  endProviderSession,
  idTokenKey,
  storeIdToken,
} from '../provider-session';
import type { OAuthTokens } from '../oauth';

const mockGet = SecureStore.getItemAsync as ReturnType<typeof vi.fn>;
const mockOpen = WebBrowser.openAuthSessionAsync as ReturnType<typeof vi.fn>;

const ENDPOINT = 'https://sso.example.com/realms/mail/protocol/openid-connect/logout';

function tokens(source: OAuthTokens['source']): OAuthTokens {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    tokenEndpoint: 'https://sso.example.com/token',
    clientId: 'bulwark',
    source,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildEndSessionUrl', () => {
  it('always names the client, and adds the id token and the redirect when given', () => {
    const url = new URL(buildEndSessionUrl({
      endpoint: ENDPOINT,
      clientId: 'bulwark',
      idToken: 'id.jwt.sig',
      postLogoutRedirectUri: 'bulwarkmobile://auth/callback',
    })!);
    expect(`${url.origin}${url.pathname}`).toBe(ENDPOINT);
    expect(url.searchParams.get('client_id')).toBe('bulwark');
    expect(url.searchParams.get('id_token_hint')).toBe('id.jwt.sig');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('bulwarkmobile://auth/callback');
  });

  it('sends the client alone without an id token or redirect', () => {
    const url = new URL(buildEndSessionUrl({ endpoint: ENDPOINT, clientId: 'bulwark' })!);
    expect([...url.searchParams.keys()]).toEqual(['client_id']);
  });

  it('keeps the query the endpoint already has', () => {
    const url = new URL(buildEndSessionUrl({ endpoint: `${ENDPOINT}?tenant=a`, clientId: 'bulwark' })!);
    expect(url.searchParams.get('tenant')).toBe('a');
    expect(url.searchParams.get('client_id')).toBe('bulwark');
  });

  it('refuses an endpoint the id token must not travel to', () => {
    for (const endpoint of ['http://sso.example.com/logout', 'javascript:alert(1)', 'intent://x', 'not a url', '']) {
      expect(buildEndSessionUrl({ endpoint, clientId: 'bulwark', idToken: 'id' })).toBeNull();
    }
  });
});

describe('storeIdToken', () => {
  it('keeps the token under its own account, and forgets it when there is none', async () => {
    await storeIdToken('a@x.com@https://mail.x.com', 'id.jwt');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(idTokenKey('a@x.com@https://mail.x.com'), 'id.jwt');
    await storeIdToken('a@x.com@https://mail.x.com', undefined);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(idTokenKey('a@x.com@https://mail.x.com'));
  });

  it('keys hold only characters SecureStore accepts, one per account', () => {
    expect(idTokenKey('a@x.com@https://mail.x.com')).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(idTokenKey('a@x.com@https://mail.x.com')).not.toBe(idTokenKey('b@x.com@https://mail.x.com'));
  });
});

describe('captureProviderLogout', () => {
  it('reads the id token of the account signing out, and only that one', async () => {
    mockGet.mockImplementation(async (key: string) => (key === idTokenKey('acct-a') ? 'id-a' : 'id-other'));
    const logout = await captureProviderLogout('acct-a', ENDPOINT, tokens('native'));
    expect(logout).toEqual({ endpoint: ENDPOINT, clientId: 'bulwark', idToken: 'id-a' });
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith(idTokenKey('acct-a'));
  });

  it('ends the session by client id alone when no id token was kept', async () => {
    mockGet.mockResolvedValue(null);
    expect(await captureProviderLogout('acct-a', ENDPOINT, tokens('native'))).toEqual({ endpoint: ENDPOINT, clientId: 'bulwark' });
  });

  it('is null for every sign-in but the direct PKCE one', async () => {
    mockGet.mockResolvedValue('id');
    for (const source of ['handoff', 'pairing', 'totp', 'manual', undefined] as const) {
      expect(await captureProviderLogout('acct-a', ENDPOINT, tokens(source))).toBeNull();
    }
    expect(await captureProviderLogout('acct-a', ENDPOINT, null)).toBeNull();
  });

  it('is null when the provider advertises no usable endpoint', async () => {
    mockGet.mockResolvedValue('id');
    expect(await captureProviderLogout('acct-a', undefined, tokens('native'))).toBeNull();
    expect(await captureProviderLogout('acct-a', 'http://sso.example.com/logout', tokens('native'))).toBeNull();
  });
});

describe('endProviderSession', () => {
  it('opens the end-session URL in a browser session that returns to the app', async () => {
    await endProviderSession({ endpoint: ENDPOINT, clientId: 'bulwark', idToken: 'id-a' });
    expect(mockOpen).toHaveBeenCalledTimes(1);
    const [url, redirect, options] = mockOpen.mock.calls[0];
    const params = new URL(url as string).searchParams;
    expect(params.get('id_token_hint')).toBe('id-a');
    expect(params.get('post_logout_redirect_uri')).toBe('bulwarkmobile://auth/callback');
    expect(redirect).toBe('bulwarkmobile://auth/callback');
    // The provider's cookies are the point: never a private session.
    expect(options).toBeUndefined();
  });

  it('never throws when the browser fails', async () => {
    mockOpen.mockRejectedValueOnce(new Error('no browser'));
    await expect(endProviderSession({ endpoint: ENDPOINT, clientId: 'bulwark' })).resolves.toBeUndefined();
  });
});
