import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as WebBrowser from 'expo-web-browser';

// Sign-out ends the identity provider's own session too (OIDC RP-Initiated
// Logout, webmail #905): revoking the refresh token left the browser signed
// in at the provider, and the next browser sign-in went through unasked.

vi.mock('../client-cert', () => {
  const fetchFn = vi.fn();
  return {
    secureFetch: fetchFn,
    fetchWithoutForeignRedirect: fetchFn,
    followedOnlyAllowedRedirects: () => true,
    mayFollowRedirect: () => true,
  };
});

import { fetchWithoutForeignRedirect } from '../client-cert';
import { buildEndSessionUrl, endProviderSession, loginWithPkce, type OAuthMetadata } from '../oauth-native';
import { refreshOAuthAccessToken, resetRefreshRotations, type OAuthTokens } from '../oauth';
import { DEFAULT_CLIENT_ID, MOBILE_CLIENT_ID, REGISTERED_LOGOUT_REDIRECT_URI } from '../totp-login';

const fetchMock = fetchWithoutForeignRedirect as unknown as ReturnType<typeof vi.fn>;
const browser = WebBrowser.openAuthSessionAsync as ReturnType<typeof vi.fn>;

const SERVER = 'https://mail.example.org';
const DISCOVERY = {
  issuer: SERVER,
  authorization_endpoint: `${SERVER}/login`,
  token_endpoint: `${SERVER}/auth/token`,
  end_session_endpoint: `${SERVER}/auth/logout`,
};
const json = (body: unknown) => ({ ok: true, status: 200, url: '', json: async () => body, text: async () => JSON.stringify(body) });

function tokens(over: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: 'at', refreshToken: 'rt', tokenEndpoint: `${SERVER}/auth/token`,
    clientId: 'registered-client', source: 'native', idToken: 'id.token.sig', ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRefreshRotations();
  browser.mockResolvedValue({ type: 'dismiss' });
});

describe('buildEndSessionUrl', () => {
  it('names the client, hints the id token and comes back to the app for a client the app registered', () => {
    const target = buildEndSessionUrl(SERVER, DISCOVERY, tokens());
    const url = new URL(target!.url);
    expect(url.origin + url.pathname).toBe(`${SERVER}/auth/logout`);
    expect(url.searchParams.get('client_id')).toBe('registered-client');
    expect(url.searchParams.get('id_token_hint')).toBe('id.token.sig');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(REGISTERED_LOGOUT_REDIRECT_URI);
    expect(target!.returnUrl).toBe(REGISTERED_LOGOUT_REDIRECT_URI);
  });

  it('sends no return address for a client someone else registered', () => {
    for (const clientId of [DEFAULT_CLIENT_ID, MOBILE_CLIENT_ID]) {
      const url = new URL(buildEndSessionUrl(SERVER, DISCOVERY, tokens({ clientId }))!.url);
      expect(url.searchParams.get('post_logout_redirect_uri')).toBeNull();
      expect(url.searchParams.get('client_id')).toBe(clientId);
    }
  });

  it('skips a provider without an end_session_endpoint, or one on another host in the clear', () => {
    expect(buildEndSessionUrl(SERVER, { end_session_endpoint: undefined }, tokens())).toBeNull();
    expect(buildEndSessionUrl(SERVER, { end_session_endpoint: 'http://idp.example.net/logout' }, tokens())).toBeNull();
    // The server's own host over http is what the user signed in to.
    expect(buildEndSessionUrl('http://10.10.10.62:8120', { end_session_endpoint: 'http://10.10.10.62:8120/auth/logout' }, tokens()))
      .not.toBeNull();
  });
});

describe('endProviderSession', () => {
  it("opens the provider's logout page after a browser sign-in", async () => {
    fetchMock.mockResolvedValue(json(DISCOVERY));
    await endProviderSession(SERVER, tokens());
    expect(browser).toHaveBeenCalledTimes(1);
    const [url, returnUrl] = browser.mock.calls[0] as [string, string];
    expect(new URL(url).searchParams.get('id_token_hint')).toBe('id.token.sig');
    expect(returnUrl).toBe(REGISTERED_LOGOUT_REDIRECT_URI);
  });

  it('opens nothing for sign-ins that left no browser session, or a provider without logout', async () => {
    fetchMock.mockResolvedValue(json(DISCOVERY));
    await endProviderSession(SERVER, tokens({ source: 'totp' }));
    await endProviderSession(SERVER, tokens({ source: 'pairing' }));
    fetchMock.mockResolvedValue(json({ ...DISCOVERY, end_session_endpoint: undefined }));
    await endProviderSession(SERVER, tokens());
    expect(browser).not.toHaveBeenCalled();
  });

  it('never fails the sign-out', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(endProviderSession(SERVER, tokens())).resolves.toBeUndefined();
    fetchMock.mockResolvedValue(json(DISCOVERY));
    browser.mockRejectedValueOnce(new Error('another session is open'));
    await expect(endProviderSession(SERVER, tokens())).resolves.toBeUndefined();
  });
});

describe('the id token', () => {
  it('is kept from the browser sign-in', async () => {
    const meta: OAuthMetadata = { authorization_endpoint: `${SERVER}/authorize`, token_endpoint: `${SERVER}/auth/token` };
    browser.mockImplementationOnce(async (authUrl: string) => {
      const state = new URL(authUrl).searchParams.get('state');
      return { type: 'success', url: `bulwarkmobile://auth/callback?code=c&state=${state}` };
    });
    fetchMock.mockResolvedValue(json({ access_token: 'at', refresh_token: 'rt', expires_in: 300, id_token: 'id.token.sig' }));
    const got = await loginWithPkce(SERVER, meta, { clientId: 'c1' });
    expect(got.idToken).toBe('id.token.sig');
  });

  it('outlives a refresh that hands out none', async () => {
    fetchMock.mockResolvedValue(json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 300 }));
    const next = await refreshOAuthAccessToken(tokens());
    expect(next.idToken).toBe('id.token.sig');
  });
});
