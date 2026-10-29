import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fake } = vi.hoisted(() => ({
  fake: {
    accountId: 'h',
    isConnected: true,
    currentSession: {} as object | null,
    oauthClientId: null as string | null,
    stalwart: true,
    responses: [] as unknown[],
    hasAccountCapability(cap: string) {
      return cap === 'urn:stalwart:jmap' && this.stalwart;
    },
    async request() {
      return { methodResponses: this.responses };
    },
  },
}));

vi.mock('../jmap-client', () => ({ jmapClient: fake }));

import { AccountSecurityForbiddenError, fetchAuthInfo, isLimitedStalwartSignIn } from '../account-security';

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
