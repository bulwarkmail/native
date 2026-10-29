import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as WebBrowser from 'expo-web-browser';

const { mockSecureFetch } = vi.hoisted(() => ({ mockSecureFetch: vi.fn() }));
vi.mock('../client-cert', () => ({ secureFetch: mockSecureFetch }));

import { redeemPairingCode, runWebmailHandoff } from '../oauth';

const WEBMAIL = 'https://webmail.example.com';
const SERVER = 'https://mail.example.com';
const ISSUER = 'https://id.example.net';
const TOKEN_ENDPOINT = `${ISSUER}/token`;

let config: Record<string, unknown>;
let metadata: Record<string, unknown>;
let bundle: Record<string, string>;
let stateMismatch: boolean;

function response(url: string, data: unknown): Response {
  return { ok: true, status: 200, url, redirected: false, json: async () => data } as Response;
}

beforeEach(() => {
  vi.resetAllMocks();
  config = {
    jmapServerUrl: SERVER,
    oauthEnabled: true,
    oauthClientId: 'stalwart',
    oauthIssuerUrl: ISSUER,
  };
  metadata = { issuer: ISSUER, token_endpoint: TOKEN_ENDPOINT };
  bundle = {
    flow: 'oauth', server_url: SERVER, access_token: 'test-access',
    refresh_token: 'test-refresh', client_id: 'stalwart', token_endpoint: TOKEN_ENDPOINT,
  };
  stateMismatch = false;
  vi.mocked(WebBrowser.openAuthSessionAsync).mockImplementation(async (url) => ({
    type: 'success',
    url: `bulwarkmobile://auth/callback#${new URLSearchParams({
      ...bundle,
      state: stateMismatch ? 'wrong-state' : new URL(url).searchParams.get('mobile_state')!,
    })}`,
  }));
  mockSecureFetch.mockImplementation(async (url: string) => {
    if (url === `${WEBMAIL}/api/auth/pair/redeem`) return response(url, bundle);
    if (url === `${WEBMAIL}/api/config`) return response(url, config);
    if (url === `${WEBMAIL}/api/auth/oauth/metadata`) return response(url, metadata);
    throw new Error(`Unexpected fetch: ${url}`);
  });
});

afterEach(() => vi.useRealTimers());

for (const flow of ['handoff', 'pairing'] as const) {
  const login = () => flow === 'handoff'
    ? runWebmailHandoff(WEBMAIL)
    : redeemPairingCode(WEBMAIL, 'test-pair-code');

  describe(`${flow} external identity provider`, () => {
    it('accepts an external token endpoint verified through the selected webmail', async () => {
      await expect(login()).resolves.toMatchObject({
        flow: 'oauth', serverUrl: SERVER,
        tokens: { tokenEndpoint: TOKEN_ENDPOINT, clientId: 'stalwart', source: flow },
      });
      const discoveryCalls = mockSecureFetch.mock.calls.filter(([url]) => !url.endsWith('/pair/redeem'));
      expect(discoveryCalls.map(([url]) => url)).toEqual([
        `${WEBMAIL}/api/config`, `${WEBMAIL}/api/auth/oauth/metadata`,
      ]);
      for (const [, options] of discoveryCalls) {
        expect(options).toMatchObject({
          headers: { Accept: 'application/json' }, redirect: 'error', timeoutMs: 8000,
        });
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.body).toBeUndefined();
      }
    });

    it('also accepts a configured sibling-host provider', async () => {
      config.oauthIssuerUrl = metadata.issuer = 'https://id.example.com';
      metadata.token_endpoint = bundle.token_endpoint = 'https://id.example.com/token';
      await expect(login()).resolves.toMatchObject({ flow: 'oauth' });
    });

    it('keeps same-host login independent of webmail metadata', async () => {
      bundle.token_endpoint = `${SERVER}/auth/token`;
      await expect(login()).resolves.toMatchObject({ flow: 'oauth' });
      expect(mockSecureFetch.mock.calls.filter(([url]) => !url.endsWith('/pair/redeem'))).toHaveLength(0);
    });

    const mismatches: [string, () => void][] = [
      ['substituted token endpoint', () => { bundle.token_endpoint = 'https://attacker.test/token'; }],
      ['lookalike token hostname', () => { bundle.token_endpoint = 'https://id.example.net.attacker.test/token'; }],
      ['different token path', () => { bundle.token_endpoint = `${ISSUER}/other`; }],
      ['different token query', () => { bundle.token_endpoint = `${TOKEN_ENDPOINT}?other=1`; }],
      ['token URL with credentials', () => { bundle.token_endpoint = metadata.token_endpoint = 'https://user@id.example.net/token'; }],
      ['token URL with a fragment', () => { bundle.token_endpoint = metadata.token_endpoint = `${TOKEN_ENDPOINT}#other`; }],
      ['cleartext token endpoint', () => { bundle.token_endpoint = metadata.token_endpoint = 'http://id.example.net/token'; }],
      ['different client', () => { bundle.client_id = 'different-client'; }],
      ['different JMAP server', () => { bundle.server_url = 'https://other.example.com'; }],
      ['disabled OAuth', () => { config.oauthEnabled = false; }],
      ['non-boolean OAuth flag', () => { config.oauthEnabled = 'true'; }],
      ['missing issuer', () => { delete config.oauthIssuerUrl; }],
      ['cleartext issuer', () => { config.oauthIssuerUrl = metadata.issuer = 'http://id.example.net'; }],
      ['issuer mismatch', () => { metadata.issuer = 'https://other-id.example.net'; }],
      ['missing token endpoint', () => { delete metadata.token_endpoint; }],
    ];
    it.each(mismatches)('rejects %s', async (_name, mutate) => {
      mutate();
      await expect(login()).rejects.toThrow('token endpoint is not trusted');
    });

    it.each(['/api/config', '/api/auth/oauth/metadata'])('fails closed when %s cannot be fetched', async (path) => {
      const normal = mockSecureFetch.getMockImplementation()!;
      mockSecureFetch.mockImplementation((url, options) => {
        if (url.endsWith(path)) throw new Error('Network unavailable');
        return normal(url, options);
      });
      await expect(login()).rejects.toThrow('token endpoint is not trusted');
    });

    const badResponses: [string, Partial<Response>][] = [
      ['HTTP error', { ok: false, status: 503 }],
      ['cross-origin redirect', { url: 'https://attacker.test/api/config', redirected: true }],
      ['same-origin redirect', { url: `${WEBMAIL}/different`, redirected: true }],
      ['redirect back to the requested URL', { url: `${WEBMAIL}/api/config`, redirected: true }],
      ['missing final URL (native client-certificate bridge)', { url: '' }],
      ['invalid JSON', { json: async () => { throw new SyntaxError('Invalid JSON'); } }],
    ];
    it.each(badResponses)('fails closed for metadata with %s', async (_name, overrides) => {
      const normal = mockSecureFetch.getMockImplementation()!;
      mockSecureFetch.mockImplementation(async (url, options) => {
        const result = await normal(url, options);
        return url.endsWith('/pair/redeem') ? result : { ...result, ...overrides };
      });
      await expect(login()).rejects.toThrow('token endpoint is not trusted');
    });

    it('aborts metadata discovery after its deadline', async () => {
      vi.useFakeTimers();
      const normal = mockSecureFetch.getMockImplementation()!;
      mockSecureFetch.mockImplementation((url, options) => {
        if (!url.endsWith('/api/config')) return normal(url, options);
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Aborted'))));
      });
      const result = expect(login()).rejects.toThrow('token endpoint is not trusted');
      await vi.advanceTimersByTimeAsync(8000);
      await result;
    });
  });
}

it('rejects a mismatched callback state before fetching metadata', async () => {
  stateMismatch = true;
  await expect(runWebmailHandoff(WEBMAIL)).rejects.toThrow('State mismatch');
  expect(mockSecureFetch).not.toHaveBeenCalled();
});

it('leaves password handoff unchanged', async () => {
  bundle = { flow: 'password', server_url: SERVER, username: 'user@example.com', password: 'test-password' };
  await expect(runWebmailHandoff(WEBMAIL)).resolves.toEqual({
    flow: 'password', serverUrl: SERVER, username: 'user@example.com', password: 'test-password',
  });
  expect(mockSecureFetch).not.toHaveBeenCalled();
});
