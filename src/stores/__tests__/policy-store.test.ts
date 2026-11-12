import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The organisation policy, read from the webmail each account signed in
// through (webmail f74ff49f5: Bearer token, X-JMAP-Server-Url), cached per
// account and applied to the settings.

const { client, mockFetch } = vi.hoisted(() => ({
  client: {
    serverUrl: 'https://mail.example.com' as string | null,
    username: 'ada@example.com' as string | null,
    usesBearerAuth: true,
    authHeader: 'Bearer test-token',
    currentSession: null as unknown,
    ensureFreshToken: vi.fn(async () => undefined),
  },
  mockFetch: vi.fn(),
}));

vi.mock('../../api/jmap-client', () => ({ jmapClient: client }));
vi.mock('../../lib/client-cert', () => ({ fetchWithoutForeignRedirect: mockFetch, secureFetch: mockFetch }));
vi.mock('../auth-store', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ activeAccountId: null as string | null, session: null as unknown })) };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuthStore } from '../auth-store';
import { useAccountStore, type AccountEntry } from '../account-store';
import { useSettingsStore, resetPolicyRulesForTests } from '../settings-store';
import { useToastStore } from '../toast-store';
import { noThirdPartyTraffic, startPolicySync, usePolicyStore, settingKeyFor } from '../policy-store';

const WEBMAIL = 'https://webmail.example.org';
const ADA = 'ada@example.com@mail.example.com';
const BOB = 'bob@other.org@mail.other.org';

function account(id: string, username: string, serverUrl: string, webmailUrl?: string): AccountEntry {
  return {
    id, serverUrl, username, displayName: username, email: username, avatarColor: '#000',
    lastLoginAt: 1, isConnected: true, hasError: false, isDefault: false,
    ...(webmailUrl ? { webmailUrl } : {}),
  };
}

let policies: Record<string, unknown>;
let configs: Record<string, unknown>;
let publicScope: boolean;

function response(url: string, data: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: true, status: 200, url, redirected: false,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => data,
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPolicyRulesForTests();
  client.serverUrl = 'https://mail.example.com';
  client.username = 'ada@example.com';
  client.usesBearerAuth = true;
  client.currentSession = null;
  publicScope = false;
  policies = {
    [WEBMAIL]: { restrictions: { density: { locked: true, value: 'compact' } }, features: {}, defaults: { markAsReadDelay: 2000 }, themePolicy: {} },
    'https://webmail.other.org': { restrictions: {}, features: { calendarEnabled: false }, defaults: {}, themePolicy: {} },
  };
  configs = { [WEBMAIL]: { helpUrl: 'https://help.example.org' } };
  mockFetch.mockImplementation(async (url: string) => {
    const m = /^(https?:\/\/[^/]+)\/api\/(admin\/policy|config)$/.exec(url);
    if (!m) throw new Error(`Unexpected fetch: ${url}`);
    if (m[2] === 'config') return response(url, configs[m[1]] ?? {});
    return response(url, policies[m[1]], publicScope ? { 'x-bulwark-policy-scope': 'public' } : {});
  });
  useAccountStore.setState({
    accounts: [
      account(ADA, 'ada@example.com', 'https://mail.example.com', WEBMAIL),
      account(BOB, 'bob@other.org', 'https://mail.other.org', 'https://webmail.other.org'),
    ],
    activeAccountId: ADA,
    defaultAccountId: ADA,
  });
  useAuthStore.setState({ activeAccountId: ADA, session: null });
  usePolicyStore.setState({ byAccount: {}, configByAccount: {}, accountId: null, effective: null, links: {}, configPending: true });
  useSettingsStore.setState({ density: 'regular', markAsReadDelay: 0, explicitSettings: [], hydrated: true });
  useToastStore.setState({ toasts: [] });
});

afterEach(() => resetPolicyRulesForTests());

describe('fetching the policy', () => {
  it('sends the access token and the account server, and applies the answer', async () => {
    await usePolicyStore.getState().refresh(ADA);

    const call = mockFetch.mock.calls.find(([url]) => url === `${WEBMAIL}/api/admin/policy`)!;
    expect(call[1].headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer test-token',
      'X-JMAP-Server-Url': 'https://mail.example.com',
    });
    expect(client.ensureFreshToken).toHaveBeenCalled();
    expect(useSettingsStore.getState()).toMatchObject({ density: 'compact', markAsReadDelay: 2000 });
    expect(usePolicyStore.getState().links).toEqual({ helpUrl: 'https://help.example.org' });
  });

  it('asks without a token for a password account and keeps that it got the public part', async () => {
    client.usesBearerAuth = false;
    publicScope = true;
    await usePolicyStore.getState().refresh(ADA);
    const call = mockFetch.mock.calls.find(([url]) => url === `${WEBMAIL}/api/admin/policy`)!;
    expect(call[1].headers).toEqual({ Accept: 'application/json' });
    expect(usePolicyStore.getState().byAccount[ADA].partial).toBe(true);
  });

  it('never sends the token to a plain-http webmail', async () => {
    useAccountStore.getState().updateAccount(ADA, { webmailUrl: 'http://webmail.example.org' });
    policies['http://webmail.example.org'] = policies[WEBMAIL];
    await usePolicyStore.getState().refresh(ADA);
    const call = mockFetch.mock.calls.find(([url]) => url === 'http://webmail.example.org/api/admin/policy')!;
    expect(call[1].headers.Authorization).toBeUndefined();
  });

  it('does nothing for an account without a webmail', async () => {
    useAccountStore.getState().updateAccount(ADA, { webmailUrl: undefined });
    await usePolicyStore.getState().refresh(ADA);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().density).toBe('regular');
  });

  it('keeps the cached policy when the webmail cannot be reached', async () => {
    await usePolicyStore.getState().refresh(ADA);
    mockFetch.mockRejectedValue(new Error('Network request failed'));
    await usePolicyStore.getState().refresh(ADA);
    // An offline start applies it from the cache.
    resetPolicyRulesForTests();
    useSettingsStore.setState({ density: 'regular' });
    usePolicyStore.getState().activate(ADA);
    expect(useSettingsStore.getState().density).toBe('compact');
  });
});

describe('applying it', () => {
  it('refuses a change to a locked setting and says why', async () => {
    const stop = startPolicySync();
    await usePolicyStore.getState().refresh(ADA);
    useSettingsStore.getState().updateSetting('density', 'comfortable');
    expect(useSettingsStore.getState().density).toBe('compact');
    expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(['Set by your organisation']);
    // A setting the policy only defaults stays the user's to change.
    useSettingsStore.getState().updateSetting('markAsReadDelay', 0);
    expect(useSettingsStore.getState().markAsReadDelay).toBe(0);
    stop();
  });

  it('follows the account switch: the old policy lets go, the new one applies', async () => {
    await usePolicyStore.getState().refresh(ADA);
    await usePolicyStore.getState().refresh(BOB);
    expect(useSettingsStore.getState().density).toBe('compact');

    useAuthStore.setState({ activeAccountId: BOB });
    usePolicyStore.getState().activate(BOB);
    expect(useSettingsStore.getState()).toMatchObject({ density: 'regular', markAsReadDelay: 0 });
    expect(usePolicyStore.getState().effective?.features.calendarEnabled).toBe(false);
  });

  it('ignores a cached policy from another webmail than the account has now', async () => {
    await usePolicyStore.getState().refresh(ADA);
    useAccountStore.getState().updateAccount(ADA, { webmailUrl: 'https://elsewhere.example.org' });
    usePolicyStore.getState().activate(ADA);
    expect(usePolicyStore.getState().effective).toBeNull();
    expect(useSettingsStore.getState().density).toBe('regular');
  });
});

describe('startPolicySync', () => {
  it('fetches once the session is up, and again after a switch', async () => {
    const stop = startPolicySync();
    expect(mockFetch).not.toHaveBeenCalled();
    useAuthStore.setState({ session: { apiUrl: 'x' } as never });
    await vi.waitFor(() => expect(usePolicyStore.getState().byAccount[ADA]).toBeDefined());

    client.serverUrl = 'https://mail.other.org';
    client.username = 'bob@other.org';
    useAuthStore.setState({ activeAccountId: BOB, session: { apiUrl: 'y' } as never });
    await vi.waitFor(() => expect(usePolicyStore.getState().byAccount[BOB]).toBeDefined());
    expect(usePolicyStore.getState().accountId).toBe(BOB);
    stop();
  });

  it('drops the cache of a removed account', async () => {
    const stop = startPolicySync();
    await usePolicyStore.getState().refresh(BOB);
    useAccountStore.getState().removeAccount(BOB);
    expect(usePolicyStore.getState().byAccount[BOB]).toBeUndefined();
    stop();
  });
});

describe('no third-party traffic', () => {
  const mode = () => noThirdPartyTraffic(usePolicyStore.getState());

  it('counts as on until the config of the account\'s webmail is known', async () => {
    usePolicyStore.getState().activate(ADA);
    expect(mode()).toBe(true);
    await usePolicyStore.getState().refresh(ADA);
    expect(mode()).toBe(false);
  });

  it('keeps it on when the config says so', async () => {
    configs[WEBMAIL] = { noThirdPartyTraffic: true };
    await usePolicyStore.getState().refresh(ADA);
    expect(mode()).toBe(true);
  });

  it('is off for an account without a webmail', () => {
    useAccountStore.getState().updateAccount(ADA, { webmailUrl: undefined });
    usePolicyStore.getState().activate(ADA);
    expect(mode()).toBe(false);
  });

  it('uses the cached config on an offline start', async () => {
    await usePolicyStore.getState().refresh(ADA);
    usePolicyStore.setState({ links: {}, configPending: true });
    mockFetch.mockRejectedValue(new Error('Network request failed'));
    usePolicyStore.getState().activate(ADA);
    await usePolicyStore.getState().refresh(ADA);
    expect(mode()).toBe(false);
    expect(usePolicyStore.getState().links).toEqual({ helpUrl: 'https://help.example.org' });
  });

  it('uses the links a policy cached by an earlier version holds', async () => {
    await usePolicyStore.getState().refresh(ADA);
    const cached = usePolicyStore.getState().byAccount[ADA];
    usePolicyStore.setState({ byAccount: { [ADA]: { ...cached, links: { noThirdPartyTraffic: true } } }, configByAccount: {} });
    usePolicyStore.getState().activate(ADA);
    expect(mode()).toBe(true);
    usePolicyStore.setState({ byAccount: { [ADA]: { ...cached, links: {} } } });
    usePolicyStore.getState().activate(ADA);
    expect(mode()).toBe(false);
  });

  it('reads the config of a webmail without the policy route', async () => {
    mockFetch.mockImplementation(async (url: string) => (url.endsWith('/api/config')
      ? response(url, {})
      : ({ ok: false, status: 404, headers: { get: () => null } } as unknown as Response)));
    usePolicyStore.getState().activate(ADA);
    await usePolicyStore.getState().refresh(ADA);
    expect(mode()).toBe(false);
  });

  it('stays on when only the policy answered', async () => {
    mockFetch.mockImplementation(async (url: string) => (url.endsWith('/api/config')
      ? Promise.reject(new Error('timeout'))
      : response(url, policies[WEBMAIL])));
    await usePolicyStore.getState().refresh(ADA);
    expect(usePolicyStore.getState().effective).not.toBeNull();
    expect(mode()).toBe(true);
  });
});

describe('the notification rule pushWithoutContent', () => {
  const withRule = (on: boolean) => ({ ...(policies[WEBMAIL] as object), organisation: { devices: { pushWithoutContent: on } } });

  it('holds while the webmail answers with the public part, until a full policy turns it off', async () => {
    policies[WEBMAIL] = withRule(true);
    await usePolicyStore.getState().refresh(ADA);
    expect(usePolicyStore.getState().byAccount[ADA].pushWithoutContent).toBeUndefined();

    // A refused token: the public subset, without organisation settings.
    publicScope = true;
    policies[WEBMAIL] = { ...(policies[WEBMAIL] as object), organisation: undefined };
    await usePolicyStore.getState().refresh(ADA);
    expect(usePolicyStore.getState().byAccount[ADA]).toMatchObject({ partial: true, pushWithoutContent: true });
    // And again.
    await usePolicyStore.getState().refresh(ADA);
    expect(usePolicyStore.getState().byAccount[ADA].pushWithoutContent).toBe(true);
    // Written at once, for the push task that reads it from AsyncStorage.
    await vi.waitFor(async () => {
      const stored = JSON.parse((await AsyncStorage.getItem('org-policy-cache'))!);
      expect(stored.state.byAccount[ADA].pushWithoutContent).toBe(true);
    });

    publicScope = false;
    policies[WEBMAIL] = withRule(false);
    await usePolicyStore.getState().refresh(ADA);
    expect(usePolicyStore.getState().byAccount[ADA].pushWithoutContent).toBeUndefined();
  });

  it('isn\'t made up by a public answer after a full policy without it', async () => {
    policies[WEBMAIL] = withRule(false);
    await usePolicyStore.getState().refresh(ADA);
    publicScope = true;
    await usePolicyStore.getState().refresh(ADA);
    expect(usePolicyStore.getState().byAccount[ADA]).toMatchObject({ partial: true });
    expect(usePolicyStore.getState().byAccount[ADA].pushWithoutContent).toBeUndefined();
  });

  it('holds when an answer without the public marker leaves out the organisation part', async () => {
    policies[WEBMAIL] = withRule(true);
    await usePolicyStore.getState().refresh(ADA);
    // A proxy or maintenance page answering 200 with JSON, or a policy without organisation settings.
    for (const answer of [{}, { restrictions: {}, features: {} }, { ...withRule(true), organisation: null }]) {
      policies[WEBMAIL] = answer;
      await usePolicyStore.getState().refresh(ADA);
      expect(usePolicyStore.getState().byAccount[ADA], JSON.stringify(answer)).toMatchObject({ partial: false, pushWithoutContent: true });
    }
    // A full answer, which says what the rule is, decides.
    policies[WEBMAIL] = withRule(false);
    await usePolicyStore.getState().refresh(ADA);
    expect(usePolicyStore.getState().byAccount[ADA].pushWithoutContent).toBeUndefined();
  });

  it('holds when an answer\'s organisation part is empty or has no device settings', async () => {
    policies[WEBMAIL] = withRule(true);
    await usePolicyStore.getState().refresh(ADA);
    for (const answer of [{ organisation: {} }, { ...withRule(true), organisation: { signatures: {} } }, { organisation: { devices: {} } }]) {
      policies[WEBMAIL] = answer;
      await usePolicyStore.getState().refresh(ADA);
      expect(usePolicyStore.getState().byAccount[ADA].pushWithoutContent, JSON.stringify(answer)).toBe(true);
    }
  });

  it('scopes by the address the session names when the registry holds only a user name', async () => {
    useAccountStore.getState().updateAccount(ADA, { email: 'ada' });
    client.currentSession = {
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1' },
      accounts: { a1: { name: 'ada@example.com', isPersonal: true } },
    };
    policies[WEBMAIL] = {
      ...withRule(false),
      scopes: [{ id: 'd', match: { domains: ['example.com'] }, policy: { organisation: { devices: { pushWithoutContent: true } } } }],
    };
    await usePolicyStore.getState().refresh(ADA);
    publicScope = true;
    policies[WEBMAIL] = { restrictions: {}, features: {}, defaults: {}, themePolicy: {} };
    await usePolicyStore.getState().refresh(ADA);
    // The full policy turned the rule on for example.com, so the public answer keeps it.
    expect(usePolicyStore.getState().byAccount[ADA].pushWithoutContent).toBe(true);
  });
});

describe('settingKeyFor', () => {
  it('maps the webmail names of settings to the app keys', () => {
    expect(settingKeyFor('firstDayOfWeek')).toBe('calendarFirstDayOfWeek');
    expect(settingKeyFor('density')).toBe('density');
    expect(settingKeyFor('calendarFirstDayOfWeek')).toBeNull();
    expect(settingKeyFor('trustedSenders')).toBeNull();
    expect(settingKeyFor('noSuchSetting')).toBeNull();
  });
});
