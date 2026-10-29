import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as WebBrowser from 'expo-web-browser';

import { setManualFetchForTests } from '../client-cert';
import { HandoffError, PairingError, TransientRefreshError, redeemPairingCode, refreshOAuthAccessToken, resetRefreshRotations } from '../oauth';
import { discoverOAuthMetadata, loginWithPkce, revokeRefreshToken, type OAuthMetadata } from '../oauth-native';

// The refresh token, the code + verifier and the metadata that decides where
// they go must not follow a redirect to another host. One fake network sits
// behind both fetches: the one told `redirect: 'manual'` (Expo's on a device)
// gets the 3xx back; React Native's own follows a 307/308 anywhere with the
// method and body, as OkHttp does.

const SERVER = 'https://mail.example.com';
// An external identity provider: its token endpoint is on another host than
// the mail server, and that is fine.
const IDP = 'https://id.example.net';
const EVIL = 'https://evil.example';

interface Hit { url: string; body?: string }
let hits: Hit[];
let routes: Record<string, () => Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function redirect(location: string, status = 307): Response {
  return new Response(null, { status, headers: { Location: location } });
}

async function network(url: string, init?: RequestInit): Promise<Response> {
  hits.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
  const route = routes[url.split('?')[0]];
  const response = route ? route() : json({ error: 'not found' }, 404);
  const location = response.headers.get('location');
  if (location && init?.redirect !== 'manual') return network(location, init);
  return response;
}

const evilHits = () => hits.filter((h) => h.url.startsWith(EVIL));

beforeEach(() => {
  hits = [];
  routes = {};
  resetRefreshRotations();
  setManualFetchForTests(network);
  vi.stubGlobal('fetch', vi.fn(network));
});
afterEach(() => {
  setManualFetchForTests(undefined);
  vi.unstubAllGlobals();
});

const tokens = {
  accessToken: 'a1',
  refreshToken: 'r1',
  expiresAt: Date.now() + 5_000,
  tokenEndpoint: `${IDP}/token`,
  clientId: 'bulwark-webmail',
};

describe('token refresh', () => {
  it('does not take the refresh token along a redirect to another host', async () => {
    routes[`${IDP}/token`] = () => redirect(`${EVIL}/token`);

    await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(TransientRefreshError);

    expect(evilHits()).toEqual([]);
  });

  it("follows a redirect within the token endpoint's own host, not the server's", async () => {
    routes[`${IDP}/token`] = () => redirect(`${IDP}/oauth/token`, 308);
    routes[`${IDP}/oauth/token`] = () => json({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 });

    const next = await refreshOAuthAccessToken(tokens);

    expect(next.accessToken).toBe('a2');
    expect(hits.map((h) => h.url)).toEqual([`${IDP}/token`, `${IDP}/oauth/token`]);
  });
});

describe('PKCE code exchange', () => {
  it('does not take the code and verifier along a redirect to another host', async () => {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockImplementationOnce(async (authUrl: string) => ({
      type: 'success',
      url: `bulwarkmobile://auth/callback?code=c1&state=${new URL(authUrl).searchParams.get('state')}`,
    }));
    routes[`${IDP}/token`] = () => redirect(`${EVIL}/token`);
    const metadata: OAuthMetadata = { authorization_endpoint: `${IDP}/authorize`, token_endpoint: `${IDP}/token` };

    await expect(loginWithPkce(SERVER, metadata, { clientId: 'bulwark-webmail' })).rejects.toBeInstanceOf(HandoffError);

    expect(hits.map((h) => h.url)).toEqual([`${IDP}/token`]);
    expect(evilHits()).toEqual([]);
  });
});

describe('revocation', () => {
  it('reaches an identity provider on another host but not a redirect away from it', async () => {
    routes[`${SERVER}/.well-known/oauth-authorization-server`] = () => json({
      authorization_endpoint: `${IDP}/authorize`,
      token_endpoint: `${IDP}/token`,
      revocation_endpoint: `${IDP}/revoke`,
    });
    routes[`${IDP}/revoke`] = () => redirect(`${EVIL}/revoke`);

    await revokeRefreshToken(SERVER, { ...tokens, source: 'native' });

    expect(hits.map((h) => h.url)).toContain(`${IDP}/revoke`);
    expect(evilHits()).toEqual([]);
  });
});

describe('metadata discovery', () => {
  it('ignores metadata reached through a redirect to another host', async () => {
    routes[`${SERVER}/.well-known/oauth-authorization-server`] = () =>
      redirect(`${EVIL}/.well-known/oauth-authorization-server`, 302);
    routes[`${EVIL}/.well-known/oauth-authorization-server`] = () => json({
      authorization_endpoint: `${EVIL}/authorize`,
      token_endpoint: `${EVIL}/token`,
      registration_endpoint: `${EVIL}/register`,
    });

    expect(await discoverOAuthMetadata(SERVER)).toBeNull();
    expect(evilHits()).toEqual([]);
  });

  it('ignores it where the platform followed the redirect anyway', async () => {
    // No fetch that takes `redirect: 'manual'`: the answer's url gives the
    // redirect away.
    setManualFetchForTests(null);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      hits.push({ url });
      const response = json({ authorization_endpoint: `${EVIL}/authorize`, token_endpoint: `${EVIL}/token` });
      Object.defineProperty(response, 'url', { value: `${EVIL}/.well-known/oauth-authorization-server` });
      return response;
    }));

    expect(await discoverOAuthMetadata(SERVER)).toBeNull();
  });

  it('takes metadata from the server itself', async () => {
    routes[`${SERVER}/.well-known/oauth-authorization-server`] = () => json({
      authorization_endpoint: `${IDP}/authorize`,
      token_endpoint: `${IDP}/token`,
    });

    expect((await discoverOAuthMetadata(SERVER))?.token_endpoint).toBe(`${IDP}/token`);
  });
});

describe('pairing', () => {
  it('does not take a sign-in code along a redirect to another host', async () => {
    routes[`${SERVER}/api/auth/pair/redeem`] = () => redirect(`${EVIL}/api/auth/pair/redeem`);

    await expect(redeemPairingCode(SERVER, 'ABCD-EFGH')).rejects.toBeInstanceOf(PairingError);

    expect(evilHits()).toEqual([]);
  });
});
