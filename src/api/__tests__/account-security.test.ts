import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fake } = vi.hoisted(() => ({
  fake: {
    accountId: 'h',
    isConnected: true,
    currentSession: {} as object | null,
    oauthClientId: null as string | null,
    stalwart: true,
    responses: [] as unknown[],
    sent: [] as unknown[][],
    updatePassword: async (_password: string) => undefined,
    usesBearerAuth: false,
    username: 'u@example.org' as string | null,
    serverUrl: 'https://mail.example.org' as string | null,
    storedSource: undefined as string | undefined,
    async getStoredOAuthTokens() {
      return this.storedSource ? { source: this.storedSource } : null;
    },
    hasAccountCapability(cap: string) {
      return cap === 'urn:stalwart:jmap' && this.stalwart;
    },
    async request(calls: unknown[][]) {
      this.sent.push(...calls);
      return { methodResponses: this.responses };
    },
  },
}));

vi.mock('../jmap-client', () => ({ jmapClient: fake }));

import {
  AccountSecurityForbiddenError,
  changePassword,
  disableTotp,
  fetchAuthInfo,
  isLimitedStalwartSignIn,
  signedInWithPassword,
} from '../account-security';

const queries = [
  ['x:AppPassword/query', { ids: [] }, 'aq'],
  ['x:ApiKey/query', { ids: [] }, 'kq'],
];

describe('fetchAuthInfo', () => {
  beforeEach(() => {
    fake.stalwart = true;
    fake.oauthClientId = null;
    fake.currentSession = {};
  });

  it('says the sign-in is refused, not that something broke, when Stalwart answers forbidden', async () => {
    fake.responses = [
      ['error', { type: 'forbidden', description: 'You are not authorized to perform this action' }, 'p'],
      ...queries,
    ];
    await expect(fetchAuthInfo()).rejects.toBeInstanceOf(AccountSecurityForbiddenError);
  });

  it('reads two-factor as on from otpAuth.otpUrl', async () => {
    fake.responses = [['x:AccountPassword/get', { list: [{ otpAuth: { otpUrl: '****' } }] }, 'p'], ...queries];
    expect((await fetchAuthInfo()).otpEnabled).toBe(true);
  });

  it("reads two-factor as on from 1.0's top-level otpUrl", async () => {
    fake.responses = [['x:AccountPassword/get', { list: [{ otpUrl: '****' }] }, 'p'], ...queries];
    expect((await fetchAuthInfo()).otpEnabled).toBe(true);
  });

  it('reads two-factor as off when neither is set', async () => {
    fake.responses = [['x:AccountPassword/get', { list: [{ otpAuth: {} }] }, 'p'], ...queries];
    expect((await fetchAuthInfo()).otpEnabled).toBe(false);
  });
});

describe('isLimitedStalwartSignIn', () => {
  it('is true for a client Stalwart registered when the session hides the extension', () => {
    fake.oauthClientId = 'swc1.abc';
    fake.stalwart = false;
    expect(isLimitedStalwartSignIn()).toBe(true);
  });

  it('is false when the extension is there, or the client is not a registered one', () => {
    fake.oauthClientId = 'swc1.abc';
    fake.stalwart = true;
    expect(isLimitedStalwartSignIn()).toBe(false);
    fake.oauthClientId = 'bulwark-webmail';
    fake.stalwart = false;
    expect(isLimitedStalwartSignIn()).toBe(false);
    fake.oauthClientId = null;
    expect(isLimitedStalwartSignIn()).toBe(false);
  });
});

describe('changes that need the current code with TOTP on', () => {
  const singletonSent = () => (fake.sent.at(-1)![1] as { update: { singleton: Record<string, unknown> } }).update.singleton;

  beforeEach(() => {
    fake.sent = [];
    fake.responses = [['x:AccountPassword/set', { updated: { singleton: null } }, '0']];
  });

  it('sends the code with a password change, patching only otpAuth/otpCode', async () => {
    await changePassword('old', 'new-password', ' 123456 ');
    expect(singletonSent()).toEqual({ currentSecret: 'old', secret: 'new-password', 'otpAuth/otpCode': '123456' });
  });

  it('sends no OTP field without TOTP', async () => {
    await changePassword('old', 'new-password');
    expect(singletonSent()).toEqual({ currentSecret: 'old', secret: 'new-password' });
  });

  it('sends the code when turning TOTP off', async () => {
    await disableTotp('pw', '654321');
    expect(singletonSent()).toEqual({ currentSecret: 'pw', otpAuth: { otpUrl: null, otpCode: '654321' } });
  });

  it("shows Stalwart's reason when it refuses the change", async () => {
    fake.responses = [['x:AccountPassword/set', {
      notUpdated: { singleton: { type: 'forbidden', description: 'Current OTP code is required to change the password or OTP auth.' } },
    }, '0']];
    await expect(changePassword('old', 'new-password')).rejects.toThrow('Current OTP code is required');
  });
});

describe('signedInWithPassword', () => {
  it('is true for Basic auth and for the password + TOTP sign-in, which holds tokens', async () => {
    fake.usesBearerAuth = false;
    expect(await signedInWithPassword()).toBe(true);
    fake.usesBearerAuth = true;
    fake.storedSource = 'totp';
    expect(await signedInWithPassword()).toBe(true);
  });

  it('is false for a browser or webmail sign-in', async () => {
    fake.usesBearerAuth = true;
    for (const source of ['native', 'handoff', 'pairing', undefined]) {
      fake.storedSource = source;
      expect(await signedInWithPassword()).toBe(false);
    }
  });
});
