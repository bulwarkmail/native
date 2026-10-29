import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSecureFetch } = vi.hoisted(() => ({
  mockSecureFetch: vi.fn(),
}));

vi.mock('../client-cert', () => ({
  secureFetch: mockSecureFetch,
}));

import {
  PAIRING_REDEEM_TIMEOUT_MS,
  PairingError,
  TransientRefreshError,
  insecurePairingLinkError,
  isInsecurePairingUrl,
  parsePastedSignInLink,
  parseQrLoginPayload,
  redeemPairingCode,
  refreshOAuthAccessToken,
  signInLinkHost,
} from '../oauth';

const CODE = 'a1'.repeat(32);
const WEBMAIL = 'https://webmail.example.org/mail';
const SERVER = 'https://mail.example.com';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function html(status: number): Response {
  return new Response('<!doctype html><html><body>Not here</body></html>', {
    status,
    headers: { 'Content-Type': 'text/html' },
  });
}

async function redeemFailure(response: Response | Error): Promise<PairingError> {
  if (response instanceof Error) mockSecureFetch.mockRejectedValueOnce(response);
  else mockSecureFetch.mockResolvedValueOnce(response);
  try {
    await redeemPairingCode(WEBMAIL, CODE);
  } catch (err) {
    expect(err).toBeInstanceOf(PairingError);
    return err as PairingError;
  }
  throw new Error('redeemPairingCode resolved');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseQrLoginPayload', () => {
  const server = encodeURIComponent('https://mail.example.com/webmail');

  it('reads a pairing link, with or without a slash after the host', () => {
    const expected = { kind: 'pair', webmailUrl: 'https://mail.example.com/webmail', code: CODE };
    expect(parseQrLoginPayload(`bulwarkmail://pair?server=${server}&code=${CODE}`)).toEqual(expected);
    expect(parseQrLoginPayload(`bulwarkmail://pair/?server=${server}&code=${CODE}`)).toEqual(expected);
    expect(parseQrLoginPayload(`  BulwarkMail://PAIR?code=${CODE}&server=${server}\n`)).toEqual(expected);
  });

  it('reads a server-bootstrap link and a bare webmail address', () => {
    expect(parseQrLoginPayload('bulwarkmail://connect?server=https%3A%2F%2Fmail.example.com'))
      .toEqual({ kind: 'connect', webmailUrl: 'https://mail.example.com' });
    expect(parseQrLoginPayload('bulwarkmail://connect/?server=https://mail.example.com'))
      .toEqual({ kind: 'connect', webmailUrl: 'https://mail.example.com' });
    // Unchanged: a connect link may still name a plain-http server.
    expect(parseQrLoginPayload('bulwarkmail://connect?server=http://mail.example.com'))
      .toEqual({ kind: 'connect', webmailUrl: 'http://mail.example.com' });
    expect(parseQrLoginPayload('https://mail.example.com')).toEqual({ kind: 'connect', webmailUrl: 'https://mail.example.com' });
  });

  it('only redeems a pairing code over https, or plain http on loopback', () => {
    expect(parseQrLoginPayload(`bulwarkmail://pair?server=http://mail.example.com&code=${CODE}`)).toBeNull();
    expect(parseQrLoginPayload(`bulwarkmail://pair?server=http%3A%2F%2F192.168.1.5%3A3000&code=${CODE}`)).toBeNull();
    for (const dev of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://10.0.2.2:3000']) {
      expect(parseQrLoginPayload(`bulwarkmail://pair?server=${encodeURIComponent(dev)}&code=${CODE}`))
        .toEqual({ kind: 'pair', webmailUrl: dev, code: CODE });
    }
  });

  it('rejects links without a server or a usable code, and garbage', () => {
    expect(parseQrLoginPayload(`bulwarkmail://pair?code=${CODE}`)).toBeNull();
    expect(parseQrLoginPayload(`bulwarkmail://pair?server=${server}`)).toBeNull();
    expect(parseQrLoginPayload(`bulwarkmail://pair?server=${server}&code=has%20space`)).toBeNull();
    expect(parseQrLoginPayload(`bulwarkmail://pair?server=javascript:alert(1)&code=${CODE}`)).toBeNull();
    expect(parseQrLoginPayload(`bulwarkmail://unlock?server=${server}&code=${CODE}`)).toBeNull();
    expect(parseQrLoginPayload(`bulwarkmail://pairing?server=${server}&code=${CODE}`)).toBeNull();
    expect(parseQrLoginPayload('WIFI:S:home;T:WPA;P:secret;;')).toBeNull();
    expect(parseQrLoginPayload('')).toBeNull();
  });
});

describe('parsePastedSignInLink', () => {
  it('finds the link inside pasted text', () => {
    const link = `bulwarkmail://pair?server=${encodeURIComponent(WEBMAIL)}&code=${CODE}`;
    expect(parsePastedSignInLink(`Open this on your phone: ${link}.`))
      .toEqual({ kind: 'pair', webmailUrl: WEBMAIL, code: CODE });
    expect(parsePastedSignInLink(`\n  ${link}  \n`)).toEqual({ kind: 'pair', webmailUrl: WEBMAIL, code: CODE });
  });

  it('accepts a pasted webmail address and rejects anything else', () => {
    expect(parsePastedSignInLink('https://mail.example.com')).toEqual({ kind: 'connect', webmailUrl: 'https://mail.example.com' });
    expect(parsePastedSignInLink('my code is 123456')).toBeNull();
    expect(parsePastedSignInLink('')).toBeNull();
  });
});

describe('insecurePairingLinkError', () => {
  const httpLink = `bulwarkmail://pair?server=${encodeURIComponent('http://Mail.Example.com:8080/webmail')}&code=${CODE}`;

  it('says why a pairing link for a plain-http webmail is refused', () => {
    // Still refused by the parser: nothing can redeem it.
    expect(parseQrLoginPayload(httpLink)).toBeNull();
    expect(parsePastedSignInLink(`Open ${httpLink} on your phone.`)).toBeNull();

    for (const text of [httpLink, `Open ${httpLink}.`, `bulwarkmail://pair/?code=${CODE}&server=http://mail.example.com:8080`]) {
      const err = insecurePairingLinkError(text);
      expect(err).toBeInstanceOf(PairingError);
      expect(err).toMatchObject({ reason: 'insecure', host: 'mail.example.com:8080' });
    }
  });

  it('names the host the code would really go to', () => {
    const spoof = `bulwarkmail://pair?server=${encodeURIComponent('http://webmail.example.org@attacker.example')}&code=${CODE}`;
    expect(insecurePairingLinkError(spoof)).toMatchObject({ host: 'attacker.example' });
  });

  it('is null for links that are fine or broken for another reason', () => {
    expect(insecurePairingLinkError(`bulwarkmail://pair?server=${encodeURIComponent(WEBMAIL)}&code=${CODE}`)).toBeNull();
    expect(insecurePairingLinkError(`bulwarkmail://pair?server=http%3A%2F%2Flocalhost%3A3000&code=${CODE}`)).toBeNull();
    expect(insecurePairingLinkError('bulwarkmail://pair?server=http://mail.example.com&code=has%20space')).toBeNull();
    expect(insecurePairingLinkError('bulwarkmail://pair?server=http://mail.example.com')).toBeNull();
    expect(insecurePairingLinkError('bulwarkmail://connect?server=http://mail.example.com')).toBeNull();
    expect(insecurePairingLinkError(`bulwarkmail://pair?server=ftp://mail.example.com&code=${CODE}`)).toBeNull();
    expect(insecurePairingLinkError('http://mail.example.com')).toBeNull();
    expect(insecurePairingLinkError('')).toBeNull();
  });
});

describe('isInsecurePairingUrl', () => {
  it('allows https and loopback http only', () => {
    expect(isInsecurePairingUrl('https://mail.example.com')).toBe(false);
    expect(isInsecurePairingUrl('http://localhost:3000')).toBe(false);
    expect(isInsecurePairingUrl('http://10.0.2.2:3000')).toBe(false);
    expect(isInsecurePairingUrl('http://mail.example.com')).toBe(true);
    expect(isInsecurePairingUrl('http://192.168.1.5:3000')).toBe(true);
  });
});

describe('signInLinkHost', () => {
  it('names the host the link talks to', () => {
    expect(signInLinkHost('https://mail.example.com/webmail')).toBe('mail.example.com');
    expect(signInLinkHost('https://Mail.Example.com:8443')).toBe('mail.example.com:8443');
    expect(signInLinkHost('http://127.0.0.1:3000/?x=1')).toBe('127.0.0.1:3000');
  });

  it('is not fooled by user info or backslashes', () => {
    expect(signInLinkHost('https://mail.example.com@attacker.example/webmail')).toBe('attacker.example');
    expect(signInLinkHost('https://a@mail.example.com@attacker.example')).toBe('attacker.example');
    expect(signInLinkHost('https://attacker.example\\@mail.example.com')).toBe('attacker.example');
    expect(signInLinkHost('https://attacker.example#@mail.example.com')).toBe('attacker.example');
    expect(signInLinkHost('https://attacker.example?@mail.example.com')).toBe('attacker.example');
  });
});

describe('redeemPairingCode', () => {
  it('posts the code to the webmail and returns an OAuth bundle for its token proxy', async () => {
    mockSecureFetch.mockResolvedValueOnce(json(200, {
      flow: 'oauth',
      server_url: SERVER,
      access_token: 'at-1',
      refresh_token: 'sealed.opaque.refresh',
      expires_in: 3600,
      token_endpoint: `${WEBMAIL}/api/auth/pair/token`,
      client_id: 'bulwark-webmail',
    }));
    const before = Date.now();

    const result = await redeemPairingCode(`${WEBMAIL}/`, CODE);

    expect(result).toEqual({
      flow: 'oauth',
      serverUrl: SERVER,
      tokens: {
        accessToken: 'at-1',
        refreshToken: 'sealed.opaque.refresh',
        expiresAt: expect.any(Number),
        tokenEndpoint: `${WEBMAIL}/api/auth/pair/token`,
        clientId: 'bulwark-webmail',
        source: 'pairing',
      },
    });
    if (result.flow !== 'oauth') throw new Error('unreachable');
    expect(result.tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);

    const [url, init] = mockSecureFetch.mock.calls[0];
    expect(url).toBe(`${WEBMAIL}/api/auth/pair/redeem`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ pairing_code: CODE });
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain('origin');
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain('cookie');
    // Deadline for both the fetch path (signal) and the client-cert path.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.timeoutMs).toBe(PAIRING_REDEEM_TIMEOUT_MS);
  });

  it('accepts the mail server as token endpoint, and a bundle without `flow` from an older webmail', async () => {
    mockSecureFetch.mockResolvedValueOnce(json(200, {
      server_url: SERVER,
      access_token: 'at-2',
      token_endpoint: `${SERVER}/auth/token`,
      client_id: 'webmail',
    }));
    const result = await redeemPairingCode(WEBMAIL, CODE);
    expect(result).toMatchObject({ flow: 'oauth', serverUrl: SERVER, tokens: { tokenEndpoint: `${SERVER}/auth/token`, source: 'pairing' } });
  });

  it('returns app-password credentials', async () => {
    mockSecureFetch.mockResolvedValueOnce(json(200, {
      flow: 'password',
      server_url: SERVER,
      username: 'ada@example.com',
      password: 'app-pass-123',
    }));
    await expect(redeemPairingCode(WEBMAIL, CODE)).resolves.toEqual({
      flow: 'password',
      serverUrl: SERVER,
      username: 'ada@example.com',
      password: 'app-pass-123',
    });
  });

  it('allows a loopback http mail server for development', async () => {
    mockSecureFetch.mockResolvedValueOnce(json(200, {
      flow: 'password', server_url: 'http://10.0.2.2:8080', username: 'u', password: 'p',
    }));
    await expect(redeemPairingCode('http://10.0.2.2:3000', CODE)).resolves.toMatchObject({ serverUrl: 'http://10.0.2.2:8080' });
  });

  it('never sends a code to a plain-http webmail', async () => {
    await expect(redeemPairingCode('http://webmail.example.org/mail', CODE))
      .rejects.toMatchObject({ name: 'PairingError', reason: 'insecure', host: 'webmail.example.org' });
    expect(mockSecureFetch).not.toHaveBeenCalled();
  });

  it('tells an unknown code from an expired or a used one', async () => {
    expect((await redeemFailure(json(400, { error: 'invalid_code' }))).reason).toBe('invalid');
    expect((await redeemFailure(json(410, { error: 'expired_code' }))).reason).toBe('expired');
    expect((await redeemFailure(json(410, { error: 'used_code' }))).reason).toBe('used');
    expect((await redeemFailure(json(410, {}))).reason).toBe('expired_or_used');
  });

  it('reads the catch-all 400 of webmail up to 1.11 as expired or used', async () => {
    expect((await redeemFailure(json(400, { error: 'Invalid or expired pairing code' }))).reason).toBe('expired_or_used');
    expect((await redeemFailure(json(400, { error: 'Missing pairing code' }))).reason).toBe('expired_or_used');
  });

  it('says the webmail cannot pair when the route is missing, naming the webmail', async () => {
    const err = await redeemFailure(html(404));
    expect(err.reason).toBe('unsupported');
    expect(err.host).toBe('webmail.example.org');
  });

  it('maps rate limiting and server errors', async () => {
    expect((await redeemFailure(json(429, { error: 'Too many requests' }))).reason).toBe('rate_limited');
    expect((await redeemFailure(json(500, { error: 'Internal server error' }))).reason).toBe('server');
    expect((await redeemFailure(html(502))).reason).toBe('server');
  });

  it('refuses a 200 that is not JSON', async () => {
    expect((await redeemFailure(html(200))).reason).toBe('bad_response');
  });

  it('refuses answers with missing fields or an unknown flow', async () => {
    expect((await redeemFailure(json(200, { flow: 'oauth', server_url: SERVER, access_token: 'x' }))).reason).toBe('bad_response');
    expect((await redeemFailure(json(200, { flow: 'password', server_url: SERVER, username: 'u' }))).reason).toBe('bad_response');
    expect((await redeemFailure(json(200, { flow: 'magic', server_url: SERVER }))).reason).toBe('bad_response');
    expect((await redeemFailure(json(200, { flow: 'password', username: 'u', password: 'p' }))).reason).toBe('bad_response');
  });

  it('reports an unreachable webmail as a network problem', async () => {
    const err = await redeemFailure(new TypeError('Network request failed'));
    expect(err.reason).toBe('network');
    expect(err.host).toBe('webmail.example.org');
  });

  it('gives up after the timeout and aborts the request', async () => {
    vi.useFakeTimers();
    mockSecureFetch.mockImplementationOnce(() => new Promise(() => undefined));

    const pending = redeemPairingCode(WEBMAIL, CODE);
    const assertion = expect(pending).rejects.toMatchObject({ name: 'PairingError', reason: 'network' });
    await vi.advanceTimersByTimeAsync(PAIRING_REDEEM_TIMEOUT_MS);
    await assertion;
    expect((mockSecureFetch.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
  });

  it('does not hand a refresh token to a token endpoint on a foreign host', async () => {
    const err = await redeemFailure(json(200, {
      flow: 'oauth',
      server_url: SERVER,
      access_token: 'at',
      refresh_token: 'rt',
      token_endpoint: 'https://attacker.example.net/token',
      client_id: 'c',
    }));
    expect(err.reason).toBe('untrusted');
  });

  it('refuses an unencrypted mail server', async () => {
    const err = await redeemFailure(json(200, {
      flow: 'password', server_url: 'http://mail.example.com', username: 'u', password: 'p',
    }));
    expect(err.reason).toBe('insecure');
  });
});

describe('refreshOAuthAccessToken with a non-JSON answer', () => {
  it('keeps the account: a 200 page that is not JSON is transient', async () => {
    mockSecureFetch.mockResolvedValueOnce(html(200));
    await expect(refreshOAuthAccessToken({
      accessToken: 'old',
      refreshToken: 'non-json-refresh',
      tokenEndpoint: `${WEBMAIL}/api/auth/pair/token`,
      clientId: 'bulwark-webmail',
      source: 'pairing',
    })).rejects.toBeInstanceOf(TransientRefreshError);
  });

  it('sends the standard form-encoded refresh grant to the token proxy', async () => {
    mockSecureFetch.mockResolvedValueOnce(json(200, { access_token: 'new', expires_in: 60 }));
    const next = await refreshOAuthAccessToken({
      accessToken: 'old',
      refreshToken: 'sealed.opaque.refresh',
      tokenEndpoint: `${WEBMAIL}/api/auth/pair/token`,
      clientId: 'bulwark-webmail',
      source: 'pairing',
    });
    expect(next).toMatchObject({ accessToken: 'new', refreshToken: 'sealed.opaque.refresh', source: 'pairing' });
    const [url, init] = mockSecureFetch.mock.calls[0];
    expect(url).toBe(`${WEBMAIL}/api/auth/pair/token`);
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'sealed.opaque.refresh',
      client_id: 'bulwark-webmail',
    });
  });
});
