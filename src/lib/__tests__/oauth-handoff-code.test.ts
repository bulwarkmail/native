import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as WebBrowser from 'expo-web-browser';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock('../client-cert', () => ({ secureFetch: mockFetch, fetchWithoutForeignRedirect: mockFetch }));

import { createHandoffPkce, HandoffRedeemError, runWebmailHandoff } from '../oauth';
import { describeHandoffRedeemError } from '../../screens/login/handoff-errors';

// The browser hand-off with a one-time code (webmail fb3ba0275,
// bulwarkmail.org/docs/development/mobile-handoff): the app sends a PKCE
// challenge, the webmail answers with ?code=&state=, and the app redeems the
// code with its verifier. Older webmails still answer in the fragment.

const WEBMAIL = 'https://webmail.example.com';
const SERVER = 'https://webmail.example.com';
const CODE = 'a'.repeat(64);

let opened: URL;
let callback: (url: URL) => string;
let redeem: (body: { code: string; code_verifier: string }) => { status: number; data: unknown };

function jsonResponse(url: string, status: number, data: unknown): Response {
  return { ok: status >= 200 && status < 300, status, url, redirected: false, json: async () => data } as Response;
}

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

beforeEach(() => {
  vi.resetAllMocks();
  callback = (url) => `bulwarkmobile://auth/callback?${new URLSearchParams({ code: CODE, state: url.searchParams.get('mobile_state')! })}`;
  redeem = () => ({
    status: 200,
    data: { flow: 'password', server_url: SERVER, username: 'alice@example.org', password: 'pw', state: opened.searchParams.get('mobile_state') },
  });
  vi.mocked(WebBrowser.openAuthSessionAsync).mockImplementation(async (url) => {
    opened = new URL(url);
    return { type: 'success', url: callback(opened) };
  });
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === `${WEBMAIL}/api/auth/handoff/redeem`) {
      const { status, data } = redeem(JSON.parse(String(init?.body)));
      return jsonResponse(url, status, data);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
});

describe('createHandoffPkce', () => {
  it('makes a fresh 43-character verifier and its S256 challenge', () => {
    const a = createHandoffPkce();
    const b = createHandoffPkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toBe(s256(a.verifier));
    expect(b.verifier).not.toBe(a.verifier);
  });
});

describe('runWebmailHandoff with a one-time code', () => {
  it('sends a challenge and redeems the code with the matching verifier', async () => {
    let sent: { code: string; code_verifier: string } | null = null;
    const next = redeem;
    redeem = (body) => { sent = body; return next(body); };

    await expect(runWebmailHandoff(WEBMAIL)).resolves.toEqual({
      flow: 'password', serverUrl: SERVER, username: 'alice@example.org', password: 'pw',
    });

    const challenge = opened.searchParams.get('mobile_code_challenge');
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(opened.searchParams.get('mobile_redirect_uri')).toBe('bulwarkmobile://auth/callback');
    expect(sent!.code).toBe(CODE);
    expect(s256(sent!.code_verifier)).toBe(challenge);

    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe('POST');
    const headerNames = Object.keys(init.headers).map((h) => h.toLowerCase());
    expect(headerNames).not.toContain('origin');
    expect(headerNames).not.toContain('sec-fetch-site');
  });

  it('uses a new challenge for every sign-in', async () => {
    await runWebmailHandoff(WEBMAIL);
    const first = opened.searchParams.get('mobile_code_challenge');
    await runWebmailHandoff(WEBMAIL);
    expect(opened.searchParams.get('mobile_code_challenge')).not.toBe(first);
  });

  it('reads an OAuth bundle whose expires_in is a number', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    redeem = () => ({
      status: 200,
      data: {
        flow: 'oauth', server_url: SERVER, access_token: 'at', refresh_token: 'rt', expires_in: 3540,
        token_endpoint: `${WEBMAIL}/api/auth/pair/token`, client_id: 'bulwark-webmail',
        state: opened.searchParams.get('mobile_state'),
      },
    });
    await expect(runWebmailHandoff(WEBMAIL)).resolves.toEqual({
      flow: 'oauth',
      serverUrl: SERVER,
      tokens: {
        accessToken: 'at', refreshToken: 'rt', expiresAt: 1_000_000 + 3540 * 1000,
        tokenEndpoint: `${WEBMAIL}/api/auth/pair/token`, clientId: 'bulwark-webmail', source: 'handoff',
      },
    });
    vi.mocked(Date.now).mockRestore();
  });

  it('refuses a link whose state does not match, without spending the code', async () => {
    callback = () => `bulwarkmobile://auth/callback?${new URLSearchParams({ code: CODE, state: 'forged' })}`;
    await expect(runWebmailHandoff(WEBMAIL)).rejects.toThrow('State mismatch');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a redeem answer that names another state', async () => {
    redeem = () => ({ status: 200, data: { flow: 'password', server_url: SERVER, username: 'a', password: 'b', state: 'other' } });
    await expect(runWebmailHandoff(WEBMAIL)).rejects.toThrow('State mismatch');
  });

  for (const error of ['expired_code', 'invalid_code', 'invalid_verifier', 'invalid_request'] as const) {
    it(`turns a 400 ${error} into a redeem error that asks to sign in again`, async () => {
      redeem = () => ({ status: 400, data: { error } });
      const err = await runWebmailHandoff(WEBMAIL).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HandoffRedeemError);
      expect(err).toMatchObject({ reason: error, status: 400 });
      const copy = describeHandoffRedeemError(err, (_k, fallback) => fallback ?? _k);
      expect(copy?.detail).toMatch(/sign in again/i);
    });
  }

  it('treats an unknown 400 as a used code', async () => {
    redeem = () => ({ status: 400, data: null });
    await expect(runWebmailHandoff(WEBMAIL)).rejects.toMatchObject({ name: 'HandoffRedeemError', reason: 'invalid_code' });
  });

  it('keeps reading the fragment of an older webmail or Lite', async () => {
    callback = (url) => `bulwarkmobile://auth/callback#${new URLSearchParams({
      flow: 'password', server_url: SERVER, username: 'bob@example.org', password: 'pw2', state: url.searchParams.get('mobile_state')!,
    })}`;
    await expect(runWebmailHandoff(WEBMAIL)).resolves.toEqual({
      flow: 'password', serverUrl: SERVER, username: 'bob@example.org', password: 'pw2',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a fragment with the wrong state', async () => {
    callback = () => `bulwarkmobile://auth/callback#${new URLSearchParams({
      flow: 'password', server_url: SERVER, username: 'bob@example.org', password: 'pw2', state: 'forged',
    })}`;
    await expect(runWebmailHandoff(WEBMAIL)).rejects.toThrow('State mismatch');
  });

  it('sends no challenge to a plain-http webmail, which answers in the fragment', async () => {
    callback = (url) => `bulwarkmobile://auth/callback#${new URLSearchParams({
      flow: 'password', server_url: 'https://mail.example.org', username: 'c', password: 'd', state: url.searchParams.get('mobile_state')!,
    })}`;
    await runWebmailHandoff('http://webmail.example.com');
    expect(opened.searchParams.has('mobile_code_challenge')).toBe(false);
  });
});
