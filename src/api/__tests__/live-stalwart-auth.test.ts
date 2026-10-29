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
 * What differs between the lines (checked on 0.16.27 and 1.0.0):
 * - 1.0 knows only registered clients, so the app registers its own public
 *   client (RFC 7591); 0.16 takes `bulwark-webmail`.
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

import { JMAPClient, TotpRequiredError, credentialsKey, jmapClient } from '../jmap-client';
import {
  AccountSecurityForbiddenError,
  fetchAuthInfo,
  isLimitedStalwartSignIn,
  isStalwartSupported,
} from '../account-security';
import {
  DEFAULT_CLIENT_ID,
  REGISTERED_REDIRECT_URI,
  exchangePasswordForTokens,
  resolveLoginClient,
  resetLoginClients,
} from '../../lib/totp-login';
import { discoverOAuthMetadata, pkceScopes, revokeRefreshToken } from '../../lib/oauth-native';
import { HANDOFF_REDIRECT_URI, HandoffError, refreshOAuthAccessToken, type OAuthTokens } from '../../lib/oauth';
import { generateAccountId } from '../../lib/account-utils';

const SERVER = (process.env.BULWARK_LIVE_JMAP ?? '').replace(/\/+$/, '');
const USER = process.env.BULWARK_LIVE_USER ?? '';
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const TOTP_USER = process.env.BULWARK_LIVE_TOTP_USER ?? '';
const TOTP_PASS = process.env.BULWARK_LIVE_TOTP_PASS ?? '';
const TOTP_CODE = process.env.BULWARK_LIVE_TOTP_CODE ?? '';
const live = SERVER && USER && PASS ? describe : describe.skip;
const liveTotp = SERVER && TOTP_USER && TOTP_PASS && TOTP_CODE ? it : it.skip;

// Stalwart 1.0 is the line with RP-initiated logout; 0.16 has none.
let isV1 = false;

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
        expect(client.clientId).toMatch(/^swc1\./);
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
        expect(check.scopes?.length).toBeGreaterThan(1);
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
      if (isV1) expect(tokens.clientId).toMatch(/^swc1\./);
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

    it('account security: 1.0 refuses it to the registered client, 0.16 allows it', async () => {
      useSingleton(client);
      if (isV1) {
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
    if (isV1) expect(stored.clientId).toMatch(/^swc1\./);
    else expect(stored.clientId).toBe(DEFAULT_CLIENT_ID);
    const res = await client.request([['Mailbox/get', { accountId: client.accountId, properties: ['role'] }, '0']]);
    expect(res.methodResponses[0][0]).toBe('Mailbox/get');
    const tokens = await client.getStoredOAuthTokens(generateAccountId(TOTP_USER, SERVER));
    if (tokens) await revokeRefreshToken(SERVER, tokens);
  }, 30_000);
});
