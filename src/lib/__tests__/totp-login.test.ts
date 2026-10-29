import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client-cert', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client-cert')>();
  return { ...actual, secureFetch: vi.fn() };
});

import { secureFetch } from '../client-cert';
import {
  exchangePasswordForTokens,
  resetLoginClients,
  resolveLoginClient,
  TotpLoginError,
  REGISTERED_REDIRECT_URI,
} from '../totp-login';
import { describeLoginError } from '../login-errors';

const fetchMock = secureFetch as unknown as ReturnType<typeof vi.fn>;
const BASE = 'https://mail.example.com';

function json(body: unknown, status = 200, extra?: { url?: string; redirected?: boolean }): Response {
  const res = new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (extra) {
    Object.defineProperty(res, 'url', { value: extra.url });
    Object.defineProperty(res, 'redirected', { value: extra.redirected });
  }
  return res;
}

interface Call { url: string; method: string; body?: string }

// A fake Stalwart of either line. `v1` knows no client but the ones it
// registered (ids `swc1.<n>`), takes `{query, consent}` and answers with a
// location; 0.16 has no client check and answers `client_code`.
function fakeServer(version: '0.16' | '1.0', answer?: (query: URLSearchParams) => unknown) {
  const calls: Call[] = [];
  let registered = 0;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const call = { url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined };
    calls.push(call);
    const path = url.slice(BASE.length).split('?')[0];
    if (path === '/api/auth/client') {
      if (version === '0.16') return json({ type: 'about:blank', status: 404 }, 404);
      const clientId = new URL(url).searchParams.get('client_id') ?? '';
      return json(clientId.startsWith('swc1.') ? { name: 'Bulwark Mobile' } : { error: 'invalid_client', description: 'Unknown client id', redirect: false });
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
      if (!query.get('client_id')?.startsWith('swc1.')) return json({ type: 'invalid', error: 'invalid_client', description: 'Unknown client id' });
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

  it('does not post the password when the server redirects to another host', async () => {
    const calls: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      calls.push(url);
      return json({}, 404, { url: 'https://evil.example/api/auth/client', redirected: true });
    });
    const err = await exchangePasswordForTokens(BASE, 'u', 'pw', '1').catch((e) => e);

    expect(err).toBeInstanceOf(TotpLoginError);
    expect(calls.some((u) => u.endsWith('/api/auth'))).toBe(false);
  });
});

describe('resolveLoginClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLoginClients();
  });

  it('keeps the webmail client when the server is unreachable, without remembering it', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    expect((await resolveLoginClient(BASE)).clientId).toBe('bulwark-webmail');
    fakeServer('1.0');
    expect((await resolveLoginClient(BASE)).clientId).toBe('swc1.1');
  });
});
