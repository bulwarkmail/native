/**
 * Live sign-in checks against a real Stalwart, for both server lines.
 *
 * Opt-in like live-stalwart.test.ts: skipped unless `BULWARK_LIVE_JMAP` and a
 * password are set. The TOTP part also needs an account with two-factor on
 * and a current code (one code per run; Stalwart refuses a code twice):
 *
 *   BULWARK_LIVE_JMAP=http://10.10.10.62:8120 \
 *   BULWARK_LIVE_USER=e2e-login-phone@example.org BULWARK_LIVE_PASS=… \
 *   BULWARK_LIVE_TOTP_USER=e2e-totp-phone@example.org BULWARK_LIVE_TOTP_PASS=… \
 *   BULWARK_LIVE_TOTP_CODE=… npx vitest run src/api/__tests__/live-stalwart-auth.test.ts
 *
 * With `BULWARK_LIVE_TOTP_SECRET` (the TOTP account's base32 secret) the run
 * also checks what a password change and turning TOTP off ask for; it makes
 * its own codes, each in a later 30 s window than the one before. It changes
 * the password to itself and never turns TOTP off, so the account ends as it
 * started.
 *
 * What differs between the lines (checked on 0.16.27 and 1.0.0):
 * - 1.0 knows only registered clients, so the app signs in as
 *   `bulwark-mobile` where the webmail's admin OAuth setup registered it
 *   (webmail #1459), else registers its own public client (RFC 7591); 0.16
 *   takes `bulwark-webmail`. The run checks whichever the server has.
 * - 1.0 rotates refresh tokens and revokes the whole grant when a superseded
 *   one comes back after its successor was used.
 * - 1.0 has a revocation endpoint; 0.16 has none.
 * - 1.0 refuses every x:* method to a client that isn't first-party.
 *
 * Everything the tests create (API keys, grants) is removed again.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const { secrets } = vi.hoisted(() => ({ secrets: new Map<string, string>() }));
vi.mock('expo-secure-store', () => ({
  setItemAsync: vi.fn(async (key: string, value: string) => { secrets.set(key, value); }),
  getItemAsync: vi.fn(async (key: string) => secrets.get(key) ?? null),
  deleteItemAsync: vi.fn(async (key: string) => { secrets.delete(key); }),
}));

import { createHmac } from 'node:crypto';
import * as WebBrowser from 'expo-web-browser';
import { JMAPClient, TotpRequiredError, credentialsKey, jmapClient, type StoredCredentials } from '../jmap-client';
import {
  AccountSecurityForbiddenError,
  changePassword,
  disableTotp,
  fetchAuthInfo,
  isLimitedStalwartSignIn,
  isStalwartSupported,
  signedInWithPassword,
} from '../account-security';
import {
  DEFAULT_CLIENT_ID,
  MOBILE_CLIENT_ID,
  REGISTERED_REDIRECT_URI,
  STALWART_LOGIN_SCOPE,
  answerConsent,
  exchangePasswordForTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  readStalwartLoginResponse,
  resolveLoginClient,
  resetLoginClients,
  stalwartLoginBody,
} from '../../lib/totp-login';
import { discoverOAuthMetadata, loginWithPkce, pkceScopes, revokeRefreshToken } from '../../lib/oauth-native';
import {
  HANDOFF_REDIRECT_URI,
  HandoffCancelledError,
  HandoffError,
  forgetRefreshRotations,
  refreshOAuthAccessToken,
  type OAuthTokens,
} from '../../lib/oauth';
import { freshStoredCredentials } from '../../lib/stored-token-refresh';
import { generateAccountId } from '../../lib/account-utils';

const SERVER = (process.env.BULWARK_LIVE_JMAP ?? '').replace(/\/+$/, '');
const USER = process.env.BULWARK_LIVE_USER ?? '';
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const TOTP_USER = process.env.BULWARK_LIVE_TOTP_USER ?? '';
const TOTP_PASS = process.env.BULWARK_LIVE_TOTP_PASS ?? '';
const TOTP_CODE = process.env.BULWARK_LIVE_TOTP_CODE ?? '';
const live = SERVER && USER && PASS ? describe : describe.skip;
const liveTotp = SERVER && TOTP_USER && TOTP_PASS && TOTP_CODE ? it : it.skip;
const TOTP_SECRET = process.env.BULWARK_LIVE_TOTP_SECRET ?? '';
const liveTotpSecret = SERVER && TOTP_USER && TOTP_PASS && TOTP_SECRET ? it : it.skip;

// RFC 6238 with the usual parameters (SHA-1, 6 digits, 30 s).
function totpAt(secret: string, at: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secret.replace(/[\s=]/g, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

// Stalwart takes each code once: every one comes from a later window than
// the last, the first from a later one than BULWARK_LIVE_TOTP_CODE's.
let lastTotpWindow = Math.floor(Date.now() / 30_000);
async function nextTotpCode(): Promise<string> {
  for (;;) {
    const now = Date.now();
    const w = Math.floor(now / 30_000);
    if (w > lastTotpWindow && 30_000 - (now % 30_000) > 3_000) {
      lastTotpWindow = w;
      return totpAt(TOTP_SECRET.startsWith('otpauth://') ? new URL(TOTP_SECRET).searchParams.get('secret')! : TOTP_SECRET, now);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Stalwart 1.0 is the line with RP-initiated logout; 0.16 has none.
let isV1 = false;
// A 1.0 where the webmail's admin OAuth setup registered `bulwark-mobile`.
let hasMobileClient = false;

/** The client a 1.0 sign-in must have used. */
function expectV1Client(clientId: string | null | undefined): void {
  if (hasMobileClient) expect(clientId).toBe(MOBILE_CLIENT_ID);
  else expect(clientId).toMatch(/^swc1\./);
}

function useSingleton(client: JMAPClient): void {
  (jmapClient as unknown as JMAPClient).restoreSnapshot(client.snapshot());
}

async function sessionStatus(accessToken: string): Promise<number> {
  const res = await fetch(`${SERVER}/.well-known/jmap`, { headers: { Authorization: `Bearer ${accessToken}` } });
  return res.status;
}

async function basicCall(methodCalls: unknown[]): Promise<unknown[][]> {
  const client = new JMAPClient();
  await client.connect(SERVER, USER, PASS);
  const res = await client.request(methodCalls as [string, Record<string, unknown>, string][], [
    'urn:ietf:params:jmap:core',
    'urn:stalwart:jmap',
  ]);
  return res.methodResponses as unknown[][];
}

live('live Stalwart sign-in', () => {
  beforeAll(async () => {
    const metadata = await discoverOAuthMetadata(SERVER);
    isV1 = !!(metadata as { end_session_endpoint?: string } | null)?.end_session_endpoint;
    if (isV1) {
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: MOBILE_CLIENT_ID,
        redirect_uri: REGISTERED_REDIRECT_URI,
        state: 's',
        code_challenge: 'A'.repeat(43),
        code_challenge_method: 'S256',
      });
      const check = (await (await fetch(`${SERVER}/api/auth/client?${query}`)).json()) as { error?: string };
      hasMobileClient = !check.error;
    }
    // Optional so the suite also runs against older sign-in code, to show
    // what it does on a server.
    resetLoginClients?.();
  });

  describe('client', () => {
    it("1.0 doesn't know the webmail's client id; 0.16 has no client check", async () => {
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: DEFAULT_CLIENT_ID,
        redirect_uri: HANDOFF_REDIRECT_URI,
        state: 's',
        code_challenge: 'A'.repeat(43),
        code_challenge_method: 'S256',
      });
      const res = await fetch(`${SERVER}/api/auth/client?${query}`);
      if (isV1) {
        expect(await res.json()).toMatchObject({ error: 'invalid_client' });
      } else {
        expect(res.status).toBe(404);
      }
    });

    it('signs in with a client the server accepts, on a redirect it accepts', async () => {
      const client = await resolveLoginClient(SERVER);
      if (isV1) {
        expectV1Client(client.clientId);
        expect(client.redirectUri).toBe(REGISTERED_REDIRECT_URI);
        // The browser sign-in's authorization request with this client and
        // the scopes the app asks for passes 1.0's client check.
        const metadata = (await discoverOAuthMetadata(SERVER))!;
        const query = new URLSearchParams({
          response_type: 'code',
          client_id: client.clientId,
          redirect_uri: client.redirectUri,
          state: 's',
          scope: pkceScopes(metadata),
          code_challenge: 'A'.repeat(43),
          code_challenge_method: 'S256',
        });
        const check = (await (await fetch(`${SERVER}/api/auth/client?${query}`)).json()) as { error?: string; scopes?: string[] };
        expect(check.error).toBeUndefined();
        // A first-party client shows as one scope, "Full access to your account".
        expect(check.scopes?.length).toBeGreaterThan(hasMobileClient ? 0 : 1);
      } else {
        expect(client).toEqual({ clientId: DEFAULT_CLIENT_ID, redirectUri: HANDOFF_REDIRECT_URI });
      }
    });
  });

  describe('password through the structured endpoint', () => {
    let tokens: OAuthTokens;
    let client: JMAPClient;

    beforeAll(async () => {
      tokens = await exchangePasswordForTokens(SERVER, USER, PASS);
      client = new JMAPClient();
      await client.connectWithOAuth(SERVER, tokens, USER);
    }, 30_000);

    afterAll(async () => {
      const latest = await client?.getStoredOAuthTokens(generateAccountId(USER, SERVER));
      if (latest) await revokeRefreshToken(SERVER, latest);
    });

    it('gets tokens for the client it signed in as', () => {
      expect(tokens.accessToken).toBeTruthy();
      expect(tokens.refreshToken).toBeTruthy();
      expect(tokens.tokenEndpoint).toBe(`${SERVER}/auth/token`);
      if (isV1) expectV1Client(tokens.clientId);
      else expect(tokens.clientId).toBe(DEFAULT_CLIENT_ID);
    });

    it('reads mail with them', async () => {
      const res = await client.request([['Mailbox/get', { accountId: client.accountId, properties: ['role'] }, '0']]);
      const [name, result] = res.methodResponses[0] as unknown as [string, { list?: { role?: string }[] }];
      expect(name).toBe('Mailbox/get');
      expect(result.list?.some((m) => m.role === 'inbox')).toBe(true);
    });

    it('stores the rotated refresh token, and an old copy of the bundle does not end the grant', async () => {
      const accountId = generateAccountId(USER, SERVER);
      expect(await client.forceRefreshToken()).toBe(true);
      const stored = JSON.parse(secrets.get(credentialsKey(accountId))!) as { refreshToken: string; accessToken: string };
      if (isV1) expect(stored.refreshToken).not.toBe(tokens.refreshToken);
      else expect(stored.refreshToken).toBe(tokens.refreshToken);

      // Spend the new one, then present the first bundle again, the way a
      // second holder (unified inbox, background task) with an old copy
      // would. On 1.0 the server would revoke the grant for that.
      expect(await client.forceRefreshToken()).toBe(true);
      const again = await refreshOAuthAccessToken(tokens);
      const latest = JSON.parse(secrets.get(credentialsKey(accountId))!) as { refreshToken: string; accessToken: string };
      expect(again.refreshToken).toBe(latest.refreshToken);
      expect(await sessionStatus(latest.accessToken)).toBe(200);
      expect(await client.forceRefreshToken()).toBe(true);
    }, 30_000);

    it('account security: 1.0 refuses it to the registered client, allows it to bulwark-mobile; 0.16 allows it', async () => {
      useSingleton(client);
      if (isV1 && !hasMobileClient) {
        // The session hides the extension from this client, and the calls
        // themselves are refused.
        expect(isStalwartSupported()).toBe(false);
        expect(isLimitedStalwartSignIn()).toBe(true);
        await expect(fetchAuthInfo()).rejects.toBeInstanceOf(AccountSecurityForbiddenError);
      } else {
        expect(isStalwartSupported()).toBe(true);
        expect(isLimitedStalwartSignIn()).toBe(false);
        expect((await fetchAuthInfo()).otpEnabled).toBe(false);
      }
    });
  });

  it('1.0.1: a consentRequired answer is met with authConsent and signs in', async () => {
    if (!isV1) return;
    // A client of its own (1.0 ids are sealed, so registering stores
    // nothing) has no grant yet, so leaving `consent` out gets the question.
    const reg = await fetch(`${SERVER}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: `Bulwark Mobile consent check ${Date.now()}`,
        redirect_uris: [REGISTERED_REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: STALWART_LOGIN_SCOPE,
      }),
    });
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    const verifier = generateCodeVerifier();
    const state = 'consent-state';
    const body = stalwartLoginBody({
      username: USER,
      password: PASS,
      clientId,
      redirectUri: REGISTERED_REDIRECT_URI,
      codeChallenge: generateCodeChallenge(verifier),
      state,
    });
    delete body.consent;
    const first = await fetch(`${SERVER}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const asked = readStalwartLoginResponse(await first.json(), state);
    expect(asked.kind).toBe('consent_required');
    if (asked.kind !== 'consent_required') return;

    const answered = await answerConsent(SERVER, asked.token, String(body.query), state);
    expect(answered.kind).toBe('code');
    if (answered.kind !== 'code') return;
    const tokenRes = await fetch(`${SERVER}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: answered.code,
        client_id: clientId,
        redirect_uri: REGISTERED_REDIRECT_URI,
        code_verifier: verifier,
      }).toString(),
    });
    const tokens = (await tokenRes.json()) as { access_token?: string; refresh_token?: string };
    expect(tokens.access_token).toBeTruthy();
    expect(await sessionStatus(tokens.access_token!)).toBe(200);
    await revokeRefreshToken(SERVER, {
      accessToken: tokens.access_token!,
      refreshToken: tokens.refresh_token,
      tokenEndpoint: `${SERVER}/auth/token`,
      clientId,
      source: 'totp',
    });
  }, 30_000);

  it('account security with the password (Basic) works on both', async () => {
    const client = new JMAPClient();
    await client.connect(SERVER, USER, PASS);
    useSingleton(client);
    const info = await fetchAuthInfo();
    expect(info.otpEnabled).toBe(false);
    expect(Array.isArray(info.appPasswords)).toBe(true);
  });

  it('sign-out revokes the grant on 1.0; 0.16 has no revocation endpoint', async () => {
    const tokens = await exchangePasswordForTokens(SERVER, USER, PASS);
    await revokeRefreshToken(SERVER, tokens);
    if (isV1) {
      expect(await sessionStatus(tokens.accessToken)).toBe(401);
      await expect(refreshOAuthAccessToken(tokens)).rejects.toBeInstanceOf(HandoffError);
    } else {
      expect(await sessionStatus(tokens.accessToken)).toBe(200);
    }
  }, 30_000);

  describe('pasted access token', () => {
    it('signs in with a Stalwart API key on both', async () => {
      const basic = new JMAPClient();
      await basic.connect(SERVER, USER, PASS);
      const accountId = basic.accountId;
      const [[, created]] = (await basicCall([
        ['x:ApiKey/set', { accountId, create: { k: { description: 'live-stalwart-auth' } } }, '0'],
      ])) as [string, { created?: Record<string, { id: string; secret: string }> }][];
      const key = created?.created?.k;
      expect(key?.secret).toBeTruthy();
      try {
        const client = new JMAPClient();
        const { username } = await client.connectWithToken(SERVER, key!.secret);
        expect(username).toBe(USER);
        expect(client.usesPastedToken).toBe(true);
        const res = await client.request([['Mailbox/get', { accountId: client.accountId, properties: ['role'] }, '0']]);
        expect(res.methodResponses[0][0]).toBe('Mailbox/get');
      } finally {
        await basicCall([['x:ApiKey/set', { accountId, destroy: [key!.id] }, '0']]);
      }
    }, 30_000);

    it('signs in with a pasted OAuth access token on both, without a way to renew it', async () => {
      const tokens = await exchangePasswordForTokens(SERVER, USER, PASS);
      try {
        const client = new JMAPClient();
        const { username } = await client.connectWithToken(SERVER, tokens.accessToken);
        expect(username).toBe(USER);
        expect(await client.forceRefreshToken()).toBe(false);
      } finally {
        await revokeRefreshToken(SERVER, tokens);
      }
    }, 30_000);
  });

  it('signs in through the browser with a client the server accepts, wherever its metadata points', async () => {
    const metadata = (await discoverOAuthMetadata(SERVER))!;
    const browser = vi.mocked(WebBrowser.openAuthSessionAsync);
    browser.mockClear();
    resetLoginClients();
    await expect(loginWithPkce(SERVER, metadata)).rejects.toBeInstanceOf(HandoffCancelledError);
    const authUrl = new URL(browser.mock.calls[0][0] as string);
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe(metadata.authorization_endpoint);
    if (isV1) {
      expectV1Client(authUrl.searchParams.get('client_id'));
      expect(metadata.registration_endpoint).toBeTruthy();
    } else {
      // 0.16 on :8016 names its public address, not the one typed here, and
      // takes the webmail's client.
      expect(authUrl.searchParams.get('client_id')).toBe(DEFAULT_CLIENT_ID);
    }
  });

  it('a stale copy refreshed after sign-out writes nothing back', async () => {
    const tokens = await exchangePasswordForTokens(SERVER, USER, PASS);
    const client = new JMAPClient();
    await client.connectWithOAuth(SERVER, tokens, USER);
    const accountId = generateAccountId(USER, SERVER);
    const stale = JSON.parse(secrets.get(credentialsKey(accountId))!) as StoredCredentials;
    expect(await client.forceRefreshToken()).toBe(true);
    const latest = (await client.getStoredOAuthTokens(accountId))!;
    // Sign-out as the auth store does it.
    forgetRefreshRotations(latest.refreshToken);
    await revokeRefreshToken(SERVER, latest);
    secrets.delete(credentialsKey(accountId));

    const result = await freshStoredCredentials(accountId, { ...stale, expiresAt: Date.now() });

    expect(secrets.has(credentialsKey(accountId))).toBe(false);
    expect(result.accessToken).toBe(stale.accessToken);
  }, 30_000);

  liveTotp('TOTP account: asks for the code, then signs in with tokens', async () => {
    const client = new JMAPClient();
    await expect(client.connect(SERVER, TOTP_USER, TOTP_PASS)).rejects.toBeInstanceOf(TotpRequiredError);
    await client.connect(SERVER, TOTP_USER, TOTP_PASS, TOTP_CODE);
    expect(client.usesBearerAuth).toBe(true);
    const stored = JSON.parse(secrets.get(credentialsKey(generateAccountId(TOTP_USER, SERVER)))!) as {
      clientId: string;
      tokenSource: string;
    };
    expect(stored.tokenSource).toBe('totp');
    if (isV1) expectV1Client(stored.clientId);
    else expect(stored.clientId).toBe(DEFAULT_CLIENT_ID);
    const res = await client.request([['Mailbox/get', { accountId: client.accountId, properties: ['role'] }, '0']]);
    expect(res.methodResponses[0][0]).toBe('Mailbox/get');
    const tokens = await client.getStoredOAuthTokens(generateAccountId(TOTP_USER, SERVER));
    if (tokens) await revokeRefreshToken(SERVER, tokens);
  }, 30_000);

  liveTotpSecret('TOTP account: a password change and turning TOTP off want the current code', async () => {
    const tokens = await exchangePasswordForTokens(SERVER, TOTP_USER, TOTP_PASS, await nextTotpCode());
    const client = new JMAPClient();
    await client.connectWithOAuth(SERVER, tokens, TOTP_USER);
    useSingleton(client);
    expect(await signedInWithPassword()).toBe(true);
    if (isV1) {
      // The client the app registers reaches no x:* object on 1.0.
      await expect(fetchAuthInfo()).rejects.toBeInstanceOf(AccountSecurityForbiddenError);
      await revokeRefreshToken(SERVER, tokens);
      return;
    }
    expect((await fetchAuthInfo()).otpEnabled).toBe(true);
    await expect(changePassword(TOTP_PASS, TOTP_PASS)).rejects.toThrow('Current OTP code is required');
    await expect(disableTotp(TOTP_PASS)).rejects.toThrow('Current OTP code is required');
    await expect(disableTotp(TOTP_PASS, '000000')).rejects.toThrow('Current secret is incorrect');
    expect((await fetchAuthInfo()).otpEnabled).toBe(true);

    // To the same password, with the code: accepted, and TOTP stays on. The
    // change ends the sign-in's tokens.
    await changePassword(TOTP_PASS, TOTP_PASS, await nextTotpCode());
    expect(await sessionStatus(tokens.accessToken)).toBe(401);
    const again = await exchangePasswordForTokens(SERVER, TOTP_USER, TOTP_PASS, await nextTotpCode());
    const after = new JMAPClient();
    await after.connectWithOAuth(SERVER, again, TOTP_USER);
    useSingleton(after);
    expect((await fetchAuthInfo()).otpEnabled).toBe(true);
  }, 150_000);
});
