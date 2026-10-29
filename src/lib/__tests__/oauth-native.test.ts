import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as WebBrowser from 'expo-web-browser';

// One fake server behind both: the client check and registration go out
// with fetchWithoutForeignRedirect.
vi.mock('../client-cert', () => {
  const fetchFn = vi.fn();
  return { secureFetch: fetchFn, fetchWithoutForeignRedirect: fetchFn };
});

import { secureFetch } from '../client-cert';
import { loginWithPkce, pkceScopes, type OAuthMetadata } from '../oauth-native';
import { HandoffCancelledError } from '../oauth';
import { REGISTERED_REDIRECT_URI, resetLoginClients } from '../totp-login';

const mockOpenAuthSession = WebBrowser.openAuthSessionAsync as ReturnType<typeof vi.fn>;

const metadata: OAuthMetadata = {
  authorization_endpoint: 'https://mail.example.com/authorize/code',
  token_endpoint: 'https://mail.example.com/auth/token',
};

// The browser mock answers every session with `cancel`, so the flow stops
// right after opening the authorization URL - which is all these tests need.
async function openedSession(meta: OAuthMetadata, addAccount?: boolean) {
  await expect(loginWithPkce('https://mail.example.com', meta, { addAccount })).rejects.toBeInstanceOf(
    HandoffCancelledError,
  );
  expect(mockOpenAuthSession).toHaveBeenCalledTimes(1);
  const [authUrl, redirectUri, options] = mockOpenAuthSession.mock.calls[0];
  return { params: new URL(authUrl as string).searchParams, redirectUri, options };
}

describe('loginWithPkce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reuses the browser session and sends no prompt for the first sign-in', async () => {
    const { params, redirectUri, options } = await openedSession(metadata);

    expect(params.get('prompt')).toBeNull();
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(redirectUri).toBe('bulwarkmobile://auth/callback');
    expect(options).toBeUndefined();
  });

  it('asks for the account picker in a private session when adding an account', async () => {
    const { params, options } = await openedSession(metadata, true);

    expect(params.get('prompt')).toBe('select_account');
    expect(options).toEqual({ preferEphemeralSession: true });
  });

  it('asks for a fresh login when the server advertises no account picker', async () => {
    const keycloak = { ...metadata, prompt_values_supported: ['none', 'login', 'consent'] };
    const { params } = await openedSession(keycloak, true);

    expect(params.get('prompt')).toBe('login');
  });

  it('keeps the account picker when the server advertises it', async () => {
    const picker = { ...metadata, prompt_values_supported: ['none', 'login', 'select_account'] };
    const { params } = await openedSession(picker, true);

    expect(params.get('prompt')).toBe('select_account');
  });
});

describe('loginWithPkce on Stalwart', () => {
  const fetchMock = secureFetch as unknown as ReturnType<typeof vi.fn>;
  const stalwart: OAuthMetadata = {
    ...metadata,
    authorization_endpoint: 'https://mail.example.com/login',
    scopes_supported: [
      'openid',
      'offline_access',
      'urn:ietf:params:oauth:scope:mail',
      'urn:ietf:params:oauth:scope:contacts',
      'urn:ietf:params:oauth:scope:calendars',
      'urn:ietf:params:oauth:scope:files',
    ],
  };
  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  beforeEach(() => {
    vi.clearAllMocks();
    resetLoginClients();
  });

  it('signs in on 1.0 with a client it registers, on a redirect 1.0 accepts', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/client')) return answer({ error: 'invalid_client', description: 'Unknown client id' });
      if (url.endsWith('/auth/register')) return answer({ client_id: 'swc1.abc' }, 201);
      return answer({}, 404);
    });
    const { params, redirectUri } = await openedSession(stalwart);

    expect(params.get('client_id')).toBe('swc1.abc');
    expect(params.get('redirect_uri')).toBe(REGISTERED_REDIRECT_URI);
    expect(redirectUri).toBe(REGISTERED_REDIRECT_URI);
  });

  it('keeps the webmail client and the app scheme on 0.16', async () => {
    fetchMock.mockImplementation(async () => answer({ status: 404 }, 404));
    const { params, redirectUri } = await openedSession(stalwart);

    expect(params.get('client_id')).toBe('bulwark-webmail');
    expect(redirectUri).toBe('bulwarkmobile://auth/callback');
  });

  it("asks for Stalwart's data scopes and none it doesn't list", async () => {
    fetchMock.mockImplementation(async () => answer({ status: 404 }, 404));
    const { params } = await openedSession(stalwart);
    const scopes = params.get('scope')!.split(' ');

    expect(scopes).toEqual(expect.arrayContaining(['openid', 'offline_access', 'urn:ietf:params:oauth:scope:mail', 'urn:ietf:params:oauth:scope:files']));
    expect(scopes).not.toContain('email');
    expect(scopes).not.toContain('profile');
  });

  it('asks another identity provider for the usual OpenID scopes', () => {
    expect(pkceScopes({ ...metadata, scopes_supported: ['openid', 'email', 'profile', 'offline_access', 'groups'] }))
      .toBe('openid email profile offline_access');
  });
});
