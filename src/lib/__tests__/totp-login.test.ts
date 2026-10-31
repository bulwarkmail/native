import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { setManualFetchForTests } from '../client-cert';
import {
  exchangePasswordForTokens,
  resetLoginClients,
  resolveLoginClient,
  TotpLoginError,
  REGISTERED_REDIRECT_URI,
  MOBILE_CLIENT_ID,
} from '../totp-login';
import { describeLoginError } from '../login-errors';

// The fetch that honours `redirect: 'manual'` (Expo's on a device). Tests that
// model React Native's own fetch take it away.
const fetchMock = vi.fn();
const BASE = 'https://mail.example.com';

beforeEach(() => {
  setManualFetchForTests(fetchMock as unknown as Parameters<typeof setManualFetchForTests>[0]);
});
afterEach(() => {
  setManualFetchForTests(undefined);
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
  const res = new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  return res;
}

interface Call { url: string; method: string; body?: string }

// A fake Stalwart of either line. `v1` knows no client but the ones it
// registered (ids `swc1.<n>`) and those in `admin` (registered by an admin
// for the given redirect URI), takes `{query, consent}` and answers with a
// location; 0.16 has no client check and answers `client_code`.
function fakeServer(
  version: '0.16' | '1.0',
  answer?: (query: URLSearchParams) => unknown,
  admin: Record<string, string> = {},
) {
  const calls: Call[] = [];
  let registered = 0;
  const knows = (clientId: string, redirectUri: string | null) =>
    clientId.startsWith('swc1.') || (clientId in admin && admin[clientId] === redirectUri);
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const call = { url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined };
    calls.push(call);
    const path = url.slice(BASE.length).split('?')[0];
    if (path === '/api/auth/client') {
      if (version === '0.16') return json({ type: 'about:blank', status: 404 }, 404);
      const params = new URL(url).searchParams;
      return json(knows(params.get('client_id') ?? '', params.get('redirect_uri'))
        ? { name: 'Bulwark Mobile' }
        : { error: 'invalid_client', description: 'Unknown client id', redirect: false });
    }
    if (path === '/auth/register') {
      if (version === '0.16') return json({ error: 'invalid_redirect_uri' }, 400);
      registered += 1;
      return json({ client_id: `swc1.${registered}` }, 201);
    }
    if (path === '/api/auth') {
      const body = JSON.parse(call.body!);
      if (version === '0.16') return json(answer ? answer(new URLSearchParams()) : { type: 'authenticated', client_code: 'code-016' });
      if (typeof body.query !== 'string') return json({ title: 'Invalid parameters', detail: 'JSON deserialization failed' }, 400);
      const query = new URLSearchParams(body.query);
      if (answer) return json(answer(query));
      if (!knows(query.get('client_id') ?? '', query.get('redirect_uri'))) return json({ type: 'invalid', error: 'invalid_client', description: 'Unknown client id' });
      return json({
        type: 'authenticated',
        location: `${query.get('redirect_uri')}?code=code-10&state=${query.get('state')}&iss=x`,
      });
    }
    if (path === '/auth/token') {
      return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    }
    return json({}, 404);
  });
  return calls;
}

const tokenCall = (calls: Call[]) => new URLSearchParams(calls.find((c) => c.url.endsWith('/auth/token'))!.body);
const authCalls = (calls: Call[]) => calls.filter((c) => c.url === `${BASE}/api/auth`);

describe('exchangePasswordForTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLoginClients();
  });

  it('signs in on Stalwart 0.16 with the webmail client id and the 0.16 fields', async () => {
    const calls = fakeServer('0.16');
    const tokens = await exchangePasswordForTokens(BASE, 'u@example.org', 'pw', '123456');

    expect(tokens.clientId).toBe('bulwark-webmail');
    const body = JSON.parse(authCalls(calls)[0].body!);
    expect(body).toMatchObject({ clientId: 'bulwark-webmail', redirectUri: 'bulwarkmobile://auth/callback', mfaToken: '123456', consent: true });
    expect(tokenCall(calls).get('code')).toBe('code-016');
    expect(tokenCall(calls).get('client_id')).toBe('bulwark-webmail');
    expect(calls.some((c) => c.url.endsWith('/auth/register'))).toBe(false);
  });

  it('cancels the client check and the login requests with the sign-in screen (U-133)', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new TypeError('Aborted')));
      });
    });
    const controller = new AbortController();
    const pending = exchangePasswordForTokens(BASE, 'u@example.org', 'pw', '123456', { signal: controller.signal });
    await vi.waitFor(() => expect(signals.length).toBe(1));
    controller.abort();
    // A cancel, not "server unreachable".
    await expect(pending).rejects.toMatchObject({ name: 'SignInCancelledError' });
    expect(signals[0]?.aborted).toBe(true);
  });

  it('registers its own client on Stalwart 1.0 and signs in with it', async () => {
    const calls = fakeServer('1.0');
    const tokens = await exchangePasswordForTokens(BASE, 'u@example.org', 'pw', '123456');

    expect(tokens.clientId).toBe('swc1.1');
    expect(tokens.source).toBe('totp');
    const register = JSON.parse(calls.find((c) => c.url.endsWith('/auth/register'))!.body!);
    expect(register.redirect_uris).toEqual([REGISTERED_REDIRECT_URI]);
    expect(register.token_endpoint_auth_method).toBe('none');
    expect(register.scope).toContain('urn:ietf:params:oauth:scope:mail');
    // The password goes out once, with the registered client.
    expect(authCalls(calls)).toHaveLength(1);
    const query = new URLSearchParams(JSON.parse(authCalls(calls)[0].body!).query);
    expect(query.get('client_id')).toBe('swc1.1');
    expect(query.get('redirect_uri')).toBe(REGISTERED_REDIRECT_URI);
    expect(tokenCall(calls).get('code')).toBe('code-10');
    expect(tokenCall(calls).get('client_id')).toBe('swc1.1');
    expect(tokenCall(calls).get('redirect_uri')).toBe(REGISTERED_REDIRECT_URI);
  });

  it('signs in on Stalwart 1.0 through the bulwark-mobile client the webmail setup registered (webmail #1459)', async () => {
    const calls = fakeServer('1.0', undefined, { 'bulwark-mobile': REGISTERED_REDIRECT_URI });
    const tokens = await exchangePasswordForTokens(BASE, 'u@example.org', 'pw', '123456');

    expect(tokens.clientId).toBe(MOBILE_CLIENT_ID);
    expect(calls.some((c) => c.url.endsWith('/auth/register'))).toBe(false);
    const query = new URLSearchParams(JSON.parse(authCalls(calls)[0].body!).query);
    expect(query.get('client_id')).toBe(MOBILE_CLIENT_ID);
    expect(query.get('redirect_uri')).toBe(REGISTERED_REDIRECT_URI);
    expect(tokenCall(calls).get('client_id')).toBe(MOBILE_CLIENT_ID);
    expect(tokenCall(calls).get('redirect_uri')).toBe(REGISTERED_REDIRECT_URI);
    // A public client: there is no secret to send.
    expect(tokenCall(calls).has('client_secret')).toBe(false);
  });

  it('keeps the registered client per server for the next sign-in', async () => {
    fakeServer('1.0');
    await exchangePasswordForTokens(BASE, 'u@example.org', 'pw', '123456');
    const calls = fakeServer('1.0');
    const tokens = await exchangePasswordForTokens(BASE, 'u@example.org', 'pw', '654321');

    expect(tokens.clientId).toBe('swc1.1');
    expect(calls.map((c) => c.url.slice(BASE.length).split('?')[0])).toEqual(['/api/auth', '/auth/token']);
  });

  it('refuses a code whose state is not the one it sent', async () => {
    fakeServer('1.0', (q) => ({ type: 'authenticated', location: `${q.get('redirect_uri')}?code=c&state=other` }));
    const err = await exchangePasswordForTokens(BASE, 'u', 'pw', '1').catch((e) => e);

    expect(err).toBeInstanceOf(TotpLoginError);
    expect(err.code).toBe('login_failed');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/auth/token'))).toBe(false);
  });

  it('reports a refused authorization request as the server refusing the app, not the password', async () => {
    fakeServer('1.0', (q) => ({
      type: 'redirect',
      location: `${q.get('redirect_uri')}?error=invalid_scope&error_description=The+requested+scope+is+not+allowed`,
    }));
    const err = await exchangePasswordForTokens(BASE, 'u', 'pw', '1').catch((e) => e);

    expect(err.code).toBe('client_rejected');
    expect(describeLoginError(err, { serverUrl: BASE }).title).toBe("mail.example.com didn't accept the app");
  });

  it('maps the credential verdicts of 1.0', async () => {
    fakeServer('1.0', () => ({ type: 'failure' }));
    expect((await exchangePasswordForTokens(BASE, 'u', 'pw', '1').catch((e) => e)).code).toBe('invalid_credentials');
    fakeServer('1.0', () => ({ type: 'mfaRequired' }));
    expect((await exchangePasswordForTokens(BASE, 'u', 'pw', '1').catch((e) => e)).code).toBe('totp_required');
  });

  // The probe can't stand in for this check: it is skipped with a remembered
  // client, and a redirect may apply to /api/auth alone.
  function redirectingServer(target: string) {
    const received: Call[] = [];
    const server = async (url: string, init?: RequestInit): Promise<Response> => {
      const body = typeof init?.body === 'string' ? init.body : undefined;
      received.push({ url, method: init?.method ?? 'GET', body });
      if (url === `${BASE}/api/auth`) {
        return new Response(null, { status: 307, headers: { Location: `${target}/api/auth` } });
      }
      if (url.startsWith(target)) return json({ type: 'authenticated', client_code: 'stolen' });
      return json({}, 404);
    };
    return { received, server };
  }

  it('does not follow a redirect of the password post to another host', async () => {
    const { received, server } = redirectingServer('https://evil.example');
    fetchMock.mockImplementation(server);
    const err = await exchangePasswordForTokens(BASE, 'u', 'pw', '1', { clientId: 'bulwark-webmail' }).catch((e) => e);

    expect(err).toBeInstanceOf(TotpLoginError);
    expect(err.code).toBe('login_failed');
    expect(fetchMock.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
    expect(received.some((c) => c.url.startsWith('https://evil.example'))).toBe(false);
  });

  it('follows a redirect within the server, keeping the post', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://mail.example.com/api/auth') {
        return new Response(null, { status: 308, headers: { Location: `${BASE}/api/auth` } });
      }
      if (url === `${BASE}/api/auth` && init?.method === 'POST') return json({ type: 'authenticated', client_code: 'c' });
      if (url === 'http://mail.example.com/auth/token') return json({ access_token: 'at', refresh_token: 'rt' });
      return json({}, 404);
    });
    const tokens = await exchangePasswordForTokens('http://mail.example.com', 'u', 'pw', '1', { clientId: 'bulwark-webmail' });

    expect(tokens.accessToken).toBe('at');
  });

  // Android's fetch names the URL as OkHttp normalised it: no default port,
  // a non-ASCII host in punycode. Those are the same server.
  it('signs in when the answers name the server the way the platform normalised it', async () => {
    const server = 'https://mail.m\u00fcller.de:443';
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const normalised = url.replace('m\u00fcller.de:443', 'xn--mller-kva.de');
      let res: Response;
      if (url.endsWith('/api/auth') && init?.method === 'POST') res = json({ type: 'authenticated', client_code: 'c' });
      else if (url.endsWith('/auth/token')) res = json({ access_token: 'at', refresh_token: 'rt' });
      else res = json({}, 404);
      Object.defineProperty(res, 'url', { value: normalised });
      return res;
    });
    const tokens = await exchangePasswordForTokens(server, 'u', 'pw', '1', { clientId: 'bulwark-webmail' });

    expect(tokens.accessToken).toBe('at');
  });

  it('takes a URL without its default port for the same server on the platform fetch too', async () => {
    setManualFetchForTests(null);
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      let res: Response;
      if (url.endsWith('/api/auth') && init?.method === 'POST') res = json({ type: 'authenticated', client_code: 'c' });
      else if (url.endsWith('/auth/token')) res = json({ access_token: 'at', refresh_token: 'rt' });
      else res = json({}, 404);
      Object.defineProperty(res, 'url', { value: url.replace(':443', '') });
      return res;
    });
    const tokens = await exchangePasswordForTokens('https://mail.example.com:443', 'u', 'pw', '1', { clientId: 'bulwark-webmail' });

    expect(tokens.accessToken).toBe('at');
  });

  it('refuses the answer when the platform fetch followed a redirect to another host', async () => {
    // React Native's fetch follows redirects itself and never sets
    // `redirected`; only `url` tells where the answer came from.
    setManualFetchForTests(null);
    const { received, server } = redirectingServer('https://evil.example');
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      let res = await server(url, init);
      let at = url;
      const location = res.headers.get('location');
      if (res.status === 307 && location) {
        at = location;
        res = await server(location, init);
      }
      Object.defineProperty(res, 'url', { value: at });
      return res;
    });
    const err = await exchangePasswordForTokens(BASE, 'u', 'pw', '1', { clientId: 'bulwark-webmail' }).catch((e) => e);

    expect(err).toBeInstanceOf(TotpLoginError);
    expect(err.code).toBe('login_failed');
    expect(received.some((c) => c.url.endsWith('/auth/token'))).toBe(false);
  });
});

describe('resolveLoginClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLoginClients();
  });

  it('says the server is unreachable, not that it refused the app, and remembers nothing', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    const err = await exchangePasswordForTokens(BASE, 'u', 'pw', '1').catch((e) => e);

    expect(err.name).toBe('NetworkError');
    expect(describeLoginError(err, { serverUrl: BASE }).title).toBe("Can't reach mail.example.com");
    expect(fetchMock.mock.calls.some(([url]) => url === `${BASE}/api/auth`)).toBe(false);
    fakeServer('1.0');
    expect((await resolveLoginClient(BASE)).clientId).toBe('swc1.1');
  });

  it.each([503, 429])('does not remember the webmail client after a %i from the client check', async (status) => {
    fetchMock.mockResolvedValueOnce(json({ error: 'busy' }, status));
    expect((await resolveLoginClient(BASE)).clientId).toBe('bulwark-webmail');
    fakeServer('1.0');
    expect((await resolveLoginClient(BASE)).clientId).toBe('swc1.1');
  });

  it('remembers the webmail client on a server without the client check', async () => {
    fakeServer('0.16');
    await resolveLoginClient(BASE);
    const calls = fakeServer('0.16');
    expect((await resolveLoginClient(BASE)).clientId).toBe('bulwark-webmail');
    expect(calls).toHaveLength(0);
  });

  it('registers at the endpoint the OAuth metadata names', async () => {
    const urls: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      urls.push(url.split('?')[0]);
      if (url.startsWith(`${BASE}/api/auth/client`)) return json({ error: 'invalid_client' });
      if (url === 'https://public.example.com/auth/register') return json({ client_id: 'swc1.pub' }, 201);
      return json({}, 404);
    });
    const client = await resolveLoginClient(BASE, { registrationEndpoint: 'https://public.example.com/auth/register' });

    expect(client.clientId).toBe('swc1.pub');
    expect(urls).toEqual([`${BASE}/api/auth/client`, `${BASE}/api/auth/client`, 'https://public.example.com/auth/register']);
  });

  it('asks for bulwark-mobile first, then the webmail client, before registering one', async () => {
    const calls = fakeServer('1.0');
    await resolveLoginClient(BASE);

    const checked = calls
      .filter((c) => c.url.startsWith(`${BASE}/api/auth/client`))
      .map((c) => new URL(c.url).searchParams);
    expect(checked.map((p) => [p.get('client_id'), p.get('redirect_uri')])).toEqual([
      [MOBILE_CLIENT_ID, REGISTERED_REDIRECT_URI],
      ['bulwark-webmail', 'bulwarkmobile://auth/callback'],
    ]);
  });

  it('remembers bulwark-mobile for the next sign-in', async () => {
    fakeServer('1.0', undefined, { 'bulwark-mobile': REGISTERED_REDIRECT_URI });
    await resolveLoginClient(BASE);
    const calls = fakeServer('1.0', undefined, { 'bulwark-mobile': REGISTERED_REDIRECT_URI });
    expect((await resolveLoginClient(BASE)).clientId).toBe(MOBILE_CLIENT_ID);
    expect(calls).toHaveLength(0);
  });
});
