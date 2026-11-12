import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

const discovery = vi.hoisted(() => ({ scopes: [] as string[] | null }));
vi.mock('../../lib/oauth-native', () => ({
  discoverOAuthMetadata: vi.fn(async () => (discovery.scopes ? { scopes_supported: discovery.scopes } : null)),
}));

import {
  AccountSecurityForbiddenError,
  changePassword,
  createPublicKey,
  disableTotp,
  encryptionDialect,
  fetchAuthInfo,
  fetchCryptoInfo,
  getManagementCapability,
  isLimitedStalwartSignIn,
  isStalwartSupported,
  serverOffersSecurityScope,
  signedInWithPassword,
  updateEncryptionAtRest,
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

describe('encryption at rest (Stalwart 1.0.2 has no cipher)', () => {
  const settings = (encryptionAtRest: unknown) => [['x:AccountSettings/get', { list: [{ encryptionAtRest }] }, '0']];
  const sentPayloads = () => fake.sent
    .filter((c) => c[0] === 'x:AccountSettings/set')
    .map((c) => (c[1] as { update: { singleton: { encryptionAtRest: Record<string, unknown> } } }).update.singleton.encryptionAtRest);
  // One answer per request, in order.
  function answers(...list: unknown[][]) {
    const queue = [...list];
    fake.request = async function request(this: typeof fake, calls: unknown[][]) {
      this.sent.push(...calls);
      return { methodResponses: queue.shift() ?? [] };
    } as typeof fake.request;
  }
  const original = fake.request;

  beforeEach(() => {
    fake.sent = [];
    fake.request = original;
    fake.usesBearerAuth = false;
    fake.username = `enc-${Math.random()}@example.org`;
  });

  it('reads 1.0.2\'s Enabled as on, not as Disabled', async () => {
    fake.responses = settings({ '@type': 'Enabled', publicKey: 'k1', headerProtection: 'None', encryptOnAppend: true, allowSpamTraining: false });
    const info = await fetchCryptoInfo();
    expect(info).toMatchObject({ type: 'Enabled', dialect: 'enabled', publicKeyId: 'k1', encryptOnAppend: true, headerProtection: 'None' });
  });

  it('turns it on as Enabled on 1.0.2, keeping headerProtection, with no cipher', async () => {
    fake.responses = [['x:AccountSettings/set', { updated: { singleton: null } }, '0']];
    await updateEncryptionAtRest({ type: 'Enabled', publicKeyId: 'k1', encryptOnAppend: true, headerProtection: 'None', dialect: 'enabled' });
    expect(sentPayloads()).toEqual([{ '@type': 'Enabled', publicKey: 'k1', encryptOnAppend: true, allowSpamTraining: false, headerProtection: 'None' }]);
  });

  it('keeps Aes256 for 0.16 to 1.0.1', async () => {
    fake.responses = [['x:AccountSettings/set', { updated: { singleton: null } }, '0']];
    await updateEncryptionAtRest({ type: 'Aes256', publicKeyId: 'k1', dialect: null });
    expect(sentPayloads()).toEqual([{ '@type': 'Aes256', publicKey: 'k1', encryptOnAppend: false, allowSpamTraining: false }]);
  });

  it('tries Enabled when a server of unknown form refuses the cipher', async () => {
    answers(
      [['x:AccountSettings/set', { notUpdated: { singleton: { type: 'invalidPatch', description: 'Invalid value for encryptionAtRest' } } }, '0']],
      [['x:AccountSettings/set', { updated: { singleton: null } }, '0']],
    );
    await updateEncryptionAtRest({ type: 'Aes256', publicKeyId: 'k1', dialect: null });
    expect(sentPayloads().map((p) => p['@type'])).toEqual(['Aes256', 'Enabled']);
  });

  it('reports the first refusal when Enabled is refused too, and does not retry a known cipher server', async () => {
    answers(
      [['x:AccountSettings/set', { notUpdated: { singleton: { type: 'invalidProperties', description: 'Key not usable' } } }, '0']],
      [['x:AccountSettings/set', { notUpdated: { singleton: { type: 'invalidPatch', description: 'Unknown variant' } } }, '0']],
    );
    await expect(updateEncryptionAtRest({ type: 'Aes256', publicKeyId: 'k1', dialect: null })).rejects.toThrow('Key not usable');
    fake.sent = [];
    answers([['x:AccountSettings/set', { notUpdated: { singleton: { type: 'invalidProperties', description: 'Key not usable' } } }, '0']]);
    await expect(updateEncryptionAtRest({ type: 'Aes256', publicKeyId: 'k1', dialect: 'cipher' })).rejects.toThrow('Key not usable');
    expect(sentPayloads()).toHaveLength(1);
  });

  it('knows a 1.0.2 server from its keys while encryption is off', () => {
    expect(encryptionDialect({ dialect: null }, [{ id: 'k', description: '', emailAddresses: [], createdAt: null, expiresAt: null, hasKeyOptions: true }])).toBe('enabled');
    expect(encryptionDialect({ dialect: null }, [{ id: 'k', description: '', emailAddresses: [], createdAt: null, expiresAt: null }])).toBeNull();
    expect(encryptionDialect({ dialect: 'cipher' }, [])).toBe('cipher');
  });

  it('knows a 1.0.3+ server from its discovery scopes while encryption is off and no key says so', async () => {
    fake.responses = settings({ '@type': 'Disabled' });
    discovery.scopes = ['openid', 'urn:ietf:params:oauth:scope:mail', 'urn:stalwart:oauth:scope:settings'];
    const info = await fetchCryptoInfo();
    expect(info.dialect).toBe('enabled');
    expect(encryptionDialect(info, [])).toBe('enabled');

    // 0.16 and 1.0.0 to 1.0.2 list none: the cipher picker stays.
    discovery.scopes = ['openid', 'urn:ietf:params:oauth:scope:mail'];
    expect((await fetchCryptoInfo()).dialect).toBeNull();
    discovery.scopes = null;
    expect((await fetchCryptoInfo()).dialect).toBeNull();

    // A cipher read back is a cipher server, whatever discovery says.
    discovery.scopes = ['urn:stalwart:oauth:scope:settings'];
    fake.responses = settings({ '@type': 'Aes256', publicKey: 'k1' });
    expect((await fetchCryptoInfo()).dialect).toBe('cipher');
    discovery.scopes = null;
  });

  it('says so when the server turned it off (the 1.0.2 upgrade), not when the user did here', async () => {
    fake.responses = settings({ '@type': 'Aes256', publicKey: 'k1' });
    expect((await fetchCryptoInfo()).turnedOffOnServer).toBeFalsy();
    fake.responses = settings({ '@type': 'Disabled' });
    expect((await fetchCryptoInfo()).turnedOffOnServer).toBe(true);

    fake.responses = [['x:AccountSettings/set', { updated: { singleton: null } }, '0']];
    await updateEncryptionAtRest({ type: 'Disabled' });
    fake.responses = settings({ '@type': 'Disabled' });
    expect((await fetchCryptoInfo()).turnedOffOnServer).toBeFalsy();
  });
});

describe('serverOffersSecurityScope', () => {
  it('is true where discovery lists the security scope (1.0.3+), so signing in again helps', async () => {
    discovery.scopes = ['openid', 'urn:ietf:params:oauth:scope:mail', 'urn:stalwart:oauth:scope:security'];
    expect(await serverOffersSecurityScope()).toBe(true);
  });

  it('is false on 1.0.0 to 1.0.2 and without discovery', async () => {
    discovery.scopes = ['openid', 'urn:ietf:params:oauth:scope:mail'];
    expect(await serverOffersSecurityScope()).toBe(false);
    discovery.scopes = null;
    expect(await serverOffersSecurityScope()).toBe(false);
  });
});

describe('account security on Inbuxa (urn:inbuxa:jmap:registry)', () => {
  const originalCap = fake.hasAccountCapability;
  const originalRequest = fake.request;
  let usings: unknown[] = [];
  beforeEach(() => {
    usings = [];
    fake.currentSession = {};
    fake.hasAccountCapability = (cap: string) => cap === 'urn:inbuxa:jmap:registry';
    fake.request = async function request(this: typeof fake, calls: unknown[][], using?: unknown) {
      usings.push(using);
      this.sent.push(...calls);
      return { methodResponses: this.responses };
    } as typeof fake.request;
  });
  afterEach(() => {
    fake.hasAccountCapability = originalCap;
    fake.request = originalRequest;
  });

  it("counts as supported and asks with Inbuxa's capability", async () => {
    expect(isStalwartSupported()).toBe(true);
    fake.responses = [['x:AccountPassword/get', { list: [{ otpAuth: {} }] }, 'p'], ...queries];
    await fetchAuthInfo();
    expect(usings).toEqual([['urn:ietf:params:jmap:core', 'urn:inbuxa:jmap:registry']]);
  });

  it('prefers Stalwart\'s where an account lists both, and is unsupported with neither', () => {
    fake.hasAccountCapability = () => true;
    expect(getManagementCapability()).toBe('urn:stalwart:jmap');
    fake.hasAccountCapability = () => false;
    expect(isStalwartSupported()).toBe(false);
  });
});

describe('createPublicKey', () => {
  const originalRequest = fake.request;
  const creates = () => fake.sent.filter((c) => c[0] === 'x:PublicKey/set')
    .map((c) => (c[1] as { create: { new: Record<string, unknown> } }).create.new);
  // A Stalwart of the given line: 1.0.2+ refuses addresses and expiry, 1.0.1 and 0.16 take them.
  function server(line: '1.0.1' | '1.1.0') {
    fake.request = async function request(this: typeof fake, calls: unknown[][]) {
      this.sent.push(...calls);
      const payload = (calls[0][1] as { create: { new: Record<string, unknown> } }).create.new;
      const serverSet = line === '1.1.0' && ('emailAddresses' in payload || 'expiresAt' in payload);
      return { methodResponses: [['x:PublicKey/set', serverSet
        ? { notCreated: { new: { type: 'invalidPatch', description: 'Cannot modify server set property' } } }
        : { created: { new: { id: 'k1' } } }, '0']] };
    } as typeof fake.request;
  }
  beforeEach(() => { fake.sent = []; });
  afterEach(() => { fake.request = originalRequest; });

  it('sends only the key and its name, which 1.1.0 takes, when the screen adds one', async () => {
    server('1.1.0');
    expect(await createPublicKey({ description: 'Work', key: '-----BEGIN CERTIFICATE-----' })).toBe('k1');
    expect(creates()).toEqual([{ description: 'Work', key: '-----BEGIN CERTIFICATE-----' }]);
  });

  it('keeps addresses and expiry for 1.0.1 and 0.16, and drops them where 1.1.0 sets them itself', async () => {
    const input = { description: 'Work', key: 'k', emailAddresses: ['a@example.org'], expiresAt: '2027-01-01T00:00:00Z' };
    server('1.0.1');
    await createPublicKey(input);
    expect(creates()).toEqual([{ description: 'Work', key: 'k', emailAddresses: { 'a@example.org': true }, expiresAt: '2027-01-01T00:00:00Z' }]);
    fake.sent = [];
    server('1.1.0');
    expect(await createPublicKey(input)).toBe('k1');
    expect(creates().map((p) => Object.keys(p).sort())).toEqual([
      ['description', 'emailAddresses', 'expiresAt', 'key'],
      ['description', 'key'],
    ]);
  });
});
