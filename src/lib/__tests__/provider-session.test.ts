import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import {
  buildEndSessionUrl,
  captureProviderLogout,
  endProviderSession,
  idTokenKey,
  providerOf,
  replaceIdToken,
  storeIdToken,
} from '../provider-session';
import type { OAuthTokenSource } from '../oauth';
import { reactNativeURL } from './helpers/rn-url';

const mockGet = SecureStore.getItemAsync as ReturnType<typeof vi.fn>;
const mockOpen = WebBrowser.openAuthSessionAsync as ReturnType<typeof vi.fn>;

const ENDPOINT = 'https://sso.example.com/realms/mail/protocol/openid-connect/logout';

// Stored credentials as captureProviderLogout reads them: a sign-in without
// a refresh token still names its source and client.
function tokens(tokenSource: OAuthTokenSource | undefined) {
  return { tokenSource, clientId: 'bulwark' };
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

  it('counts a direct PKCE sign-in that has no refresh token', async () => {
    mockGet.mockResolvedValue('id');
    expect(await captureProviderLogout('acct-a', ENDPOINT, { tokenSource: 'native', clientId: 'bulwark' }))
      .toEqual({ endpoint: ENDPOINT, clientId: 'bulwark', idToken: 'id' });
    expect(await captureProviderLogout('acct-a', ENDPOINT, { tokenSource: 'native' })).toBeNull();
  });

  it('is null when the provider advertises no usable endpoint', async () => {
    mockGet.mockResolvedValue('id');
    expect(await captureProviderLogout('acct-a', undefined, tokens('native'))).toBeNull();
    expect(await captureProviderLogout('acct-a', 'http://sso.example.com/logout', tokens('native'))).toBeNull();
  });
});

describe('endProviderSession', () => {
  it('opens the end-session URL in an auth session, sending no post-logout redirect', async () => {
    await endProviderSession({ endpoint: ENDPOINT, clientId: 'bulwark', idToken: 'id-a' });
    expect(mockOpen).toHaveBeenCalledTimes(1);
    const [url, , options] = mockOpen.mock.calls[0];
    const params = new URL(url as string).searchParams;
    expect(params.get('id_token_hint')).toBe('id-a');
    expect(params.get('client_id')).toBe('bulwark');
    // An unregistered one makes most providers refuse the whole logout.
    expect(params.has('post_logout_redirect_uri')).toBe(false);
    // The provider's cookies are the point: never a private session.
    expect(options).toBeUndefined();
  });

  it('never throws when the browser fails', async () => {
    mockOpen.mockRejectedValueOnce(new Error('no browser'));
    await expect(endProviderSession({ endpoint: ENDPOINT, clientId: 'bulwark' })).resolves.toBeUndefined();
  });
});

describe('replaceIdToken', () => {
  const signedIn = (...answers: boolean[]) => {
    let i = 0;
    return vi.fn(async () => answers[Math.min(i++, answers.length - 1)]);
  };

  it('replaces a kept token while the account stays signed in', async () => {
    mockGet.mockResolvedValue('old');
    await replaceIdToken('acct-a', 'new', signedIn(true));
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(idTokenKey('acct-a'), 'new');
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('never starts one for an account that kept none, nor without a new one', async () => {
    mockGet.mockResolvedValue(null);
    await replaceIdToken('acct-a', 'new', signedIn(true));
    mockGet.mockResolvedValue('old');
    await replaceIdToken('acct-a', undefined, signedIn(true));
    await replaceIdToken('acct-a', '', signedIn(true));
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('writes nothing once the account is signed out, and takes back a write sign-out overtook', async () => {
    mockGet.mockResolvedValue('old');
    await replaceIdToken('acct-a', 'new', signedIn(false));
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();

    await replaceIdToken('acct-a', 'new', signedIn(true, false));
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(idTokenKey('acct-a'));
  });
});

describe('providerOf', () => {
  it('is the whole endpoint without query, fragment or trailing slash', () => {
    expect(providerOf(ENDPOINT)).toBe(ENDPOINT);
    expect(providerOf(`${ENDPOINT}/?client_id=x#top`)).toBe(ENDPOINT);
    expect(providerOf('https://SSO.example.com:443/realms/mail/protocol/openid-connect/logout')).toBe(ENDPOINT);
    expect(providerOf('http://sso.example.com/logout')).toBeNull();
    expect(providerOf(undefined)).toBeNull();
  });

  it('tells two realms on one host apart, and a port apart', () => {
    const other = 'https://sso.example.com/realms/other/protocol/openid-connect/logout';
    expect(providerOf(other)).not.toBe(providerOf(ENDPOINT));
    expect(providerOf('https://sso.example.com:8443/realms/mail/protocol/openid-connect/logout')).not.toBe(providerOf(ENDPOINT));
  });
});

// On a device the global `URL` is React Native's, which appends `/` to a bare
// path and repeats a query it already had (helpers/rn-url.ts). A strict
// provider answers `/logout/` with a 404 and keeps its session, so the URL
// must come out the same under both.
describe.each([
  ['WHATWG', () => URL],
  ['React Native', reactNativeURL],
])('under %s URL', (_name, impl) => {
  beforeEach(() => {
    vi.stubGlobal('URL', impl());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the end-session URL on the endpoint exactly as advertised', () => {
    expect(buildEndSessionUrl({ endpoint: ENDPOINT, clientId: 'bulwark', idToken: 'id.jwt.sig' }))
      .toBe(`${ENDPOINT}?client_id=bulwark&id_token_hint=id.jwt.sig`);
    expect(buildEndSessionUrl({ endpoint: 'https://idp.example/oidc/logout', clientId: 'bulwark' }))
      .toBe('https://idp.example/oidc/logout?client_id=bulwark');
  });

  it('keeps an existing query once, and drops a fragment', () => {
    expect(buildEndSessionUrl({ endpoint: 'https://b2c.example/logout?p=B2C_1_signin#x', clientId: 'bulwark' }))
      .toBe('https://b2c.example/logout?p=B2C_1_signin&client_id=bulwark');
  });

  it('replaces a parameter the endpoint already names, and encodes values', () => {
    expect(buildEndSessionUrl({
      endpoint: `${ENDPOINT}?client_id=old&tenant=a`,
      clientId: 'bulwark app',
      idToken: 'a+b/c=',
    })).toBe(`${ENDPOINT}?tenant=a&client_id=bulwark%20app&id_token_hint=a%2Bb%2Fc%3D`);
  });

  it('refuses an endpoint the id token must not travel to', () => {
    for (const endpoint of [
      'http://sso.example.com/logout', 'javascript:alert(1)', 'not a url', '',
      String.raw`https:/\evil.com/logout`, 'https://a.com@evil.com/logout', 'https://',
    ]) {
      expect(buildEndSessionUrl({ endpoint, clientId: 'bulwark', idToken: 'id' })).toBeNull();
    }
  });

  it('names the provider the same way', () => {
    expect(providerOf(ENDPOINT)).toBe(ENDPOINT);
    expect(providerOf(`${ENDPOINT}/?client_id=x#top`)).toBe(ENDPOINT);
    expect(providerOf('HTTPS://SSO.example.com:443/realms/mail/protocol/openid-connect/logout')).toBe(ENDPOINT);
    expect(providerOf('https://sso.example.com:8443/realms/mail/protocol/openid-connect/logout'))
      .toBe('https://sso.example.com:8443/realms/mail/protocol/openid-connect/logout');
  });
});
