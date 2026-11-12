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

  it('registers its client on 1.0 when the metadata names another public address', async () => {
    const registered: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('https://mail.example.com/api/auth/client')) return answer({ error: 'invalid_client' });
      if (url.endsWith('/auth/register')) {
        registered.push(url);
        return answer({ client_id: 'swc1.pub' }, 201);
      }
      return answer({}, 404);
    });
    const advertised: OAuthMetadata = {
      ...stalwart,
      issuer: 'https://stalwart.internal.example.net',
      authorization_endpoint: 'https://stalwart.internal.example.net/login',
      token_endpoint: 'https://stalwart.internal.example.net/auth/token',
      registration_endpoint: 'https://stalwart.internal.example.net/auth/register',
    };
    const { params } = await openedSession(advertised);

    expect(params.get('client_id')).toBe('swc1.pub');
    expect(registered).toEqual(['https://stalwart.internal.example.net/auth/register']);
  });

  it('says the server is unreachable instead of opening the browser with a client it may not know', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    const err = await loginWithPkce('https://mail.example.com', stalwart).catch((e) => e);

    expect(err.name).toBe('NetworkError');
    expect(mockOpenAuthSession).not.toHaveBeenCalled();
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

  // 1.0.3 dropped first-party clients: the bulwark-mobile client the webmail
  // setup registered now allows only openid and offline_access, and refuses
  // the whole request with invalid_scope.
  const stalwart103: OAuthMetadata = {
    ...stalwart,
    scopes_supported: [
      ...stalwart.scopes_supported!,
      'urn:stalwart:oauth:scope:security',
      'urn:stalwart:oauth:scope:settings',
      'urn:stalwart:oauth:scope:full',
    ],
  };

  it('registers its own client on 1.0.3 when bulwark-mobile does not allow the scopes it asks for', async () => {
    const checked: URLSearchParams[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/client')) {
        const q = new URL(url).searchParams;
        checked.push(q);
        if (q.get('client_id') !== 'bulwark-mobile') return answer({ error: 'invalid_client' });
        const extra = (q.get('scope') ?? '').split(' ').filter((s) => s && s !== 'openid' && s !== 'offline_access');
        return extra.length
          ? answer({ error: 'invalid_request', redirect: true, location: `${REGISTERED_REDIRECT_URI}?error=invalid_scope` })
          : answer({ name: 'Bulwark Mobile (auto-configured)', scopes: ['Full access to your account'] });
      }
      if (url.endsWith('/auth/register')) return answer({ client_id: 'swc1.own' }, 201);
      return answer({}, 404);
    });
    const { params } = await openedSession(stalwart103);

    expect(params.get('client_id')).toBe('swc1.own');
    // The check asked with the scopes the browser then asks for.
    expect(checked.map((q) => q.get('scope'))).toContain(params.get('scope'));
  });

  it('asks 1.0.3 for full access as the bulwark-mobile a superuser allowed it, in the check and the browser', async () => {
    const checked: URLSearchParams[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/client')) {
        const q = new URL(url).searchParams;
        checked.push(q);
        if (q.get('client_id') !== 'bulwark-mobile') return answer({ error: 'invalid_client' });
        const scopes = (q.get('scope') ?? '').split(' ');
        return scopes.some((s) => s.startsWith('urn:stalwart:oauth:scope:') && s !== 'urn:stalwart:oauth:scope:full')
          ? answer({ error: 'invalid_request', redirect: true, location: `${REGISTERED_REDIRECT_URI}?error=invalid_scope` })
          : answer({ name: 'Bulwark Mobile (auto-configured)' });
      }
      return answer({}, 404);
    });
    const { params } = await openedSession(stalwart103);
    const scopes = params.get('scope')!.split(' ');

    expect(params.get('client_id')).toBe('bulwark-mobile');
    expect(scopes).toContain('urn:stalwart:oauth:scope:full');
    expect(scopes).not.toContain('urn:stalwart:oauth:scope:security');
    expect(checked[0].get('scope')).toBe(params.get('scope'));
  });

  it("asks 1.0.3 for the account's settings, but not for full access", async () => {
    fetchMock.mockImplementation(async () => answer({ status: 404 }, 404));
    const { params } = await openedSession(stalwart103);
    const scopes = params.get('scope')!.split(' ');

    expect(scopes).toEqual(expect.arrayContaining(['urn:stalwart:oauth:scope:security', 'urn:stalwart:oauth:scope:settings']));
    expect(scopes).not.toContain('urn:stalwart:oauth:scope:full');
    // A server that doesn't list them isn't asked for them.
    expect(pkceScopes(stalwart)).not.toContain('urn:stalwart:');
  });

  it('asks another identity provider for the usual OpenID scopes', () => {
    expect(pkceScopes({ ...metadata, scopes_supported: ['openid', 'email', 'profile', 'offline_access', 'groups'] }))
      .toBe('openid email profile offline_access');
  });
});
