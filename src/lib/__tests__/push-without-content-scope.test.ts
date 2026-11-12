// The organisation rule devices.pushWithoutContent on Android, in more
// settings: a domain scope while the registry holds only a user name (the
// session names the address), a lookup that fails under the rule, and an
// organisation without the rule.
//
// The policy is given the way the app caches it (policy-store persists
// `org-policy-cache`, the account registry names the webmail it came from).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    accountId: 'jmap-primary',
    getStoredCredentials: vi.fn(async () => null),
    setStoredCredentials: vi.fn(async () => undefined),
  },
}));
vi.mock('../client-cert', () => ({ secureFetch: vi.fn(async () => ({ ok: false, status: 500 })) }));
vi.mock('../oauth', () => ({ refreshOAuthAccessToken: vi.fn(async (t: unknown) => t) }));
// The tray as expo-notifications lists it: the app's own message
// notifications are foreign ones there, named by tag and id.
vi.mock('expo-notifications', () => ({
  getPresentedNotificationsAsync: vi.fn(async () => []),
  dismissNotificationAsync: vi.fn(async () => undefined),
  scheduleNotificationAsync: vi.fn(async () => 'id'),
  cancelScheduledNotificationAsync: vi.fn(async () => undefined),
  getAllScheduledNotificationsAsync: vi.fn(async () => []),
  setNotificationHandler: vi.fn(),
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules } from 'react-native';
import * as Notifications from 'expo-notifications';
import { jmapClient } from '../../api/jmap-client';
import { secureFetch } from '../client-cert';
import { pushBackgroundTask } from '../push-background-task';
import { pushWithoutContentFor } from '../push-notifications';

const LOCAL = 'alice@mail.example.com';
const WEBMAIL = 'https://webmail.example.com';
const SECRET_SUBJECT = 'Quarterly numbers before the announcement';
const SECRET_PREVIEW = 'Revenue is down 14 percent, do not forward';
const SENDER_NAME = 'Dana Finance';
const SENDER_ADDRESS = 'dana@corp.example';
describe('the rule with a username-only registry, a failed lookup and without the rule', () => {
  const showNotification = vi.fn(async (_opts: Record<string, unknown>) => undefined);
  const OTHER = 'alice@mail.other.org';
  let sessionAccounts: Record<string, unknown>;
  let emails: Array<Record<string, unknown>>;
  let emailGets: Array<Record<string, unknown>>;

  const message = (id: string, subject: string) => ({
    id, threadId: `t-${id}`, keywords: {}, receivedAt: new Date().toISOString(),
    subject, preview: SECRET_PREVIEW, from: [{ name: SENDER_NAME, email: SENDER_ADDRESS }],
  });
  const orgPolicy = (organisation: Record<string, unknown> | undefined, scopes: unknown[] = []) => ({
    restrictions: {}, features: {}, defaults: {}, forceEnabledThemes: [], themePolicy: {}, scopes,
    ...(organisation ? { organisation } : {}),
  });
  const cacheEntry = (policy: unknown, extra: Record<string, unknown> = {}) => ({
    policy, partial: false, fetchedAt: Date.now(), webmailUrl: WEBMAIL, ...extra,
  });
  const seedCache = (byAccount: Record<string, unknown>) => AsyncStorage.setItem('org-policy-cache', JSON.stringify({
    state: { byAccount, configByAccount: {} }, version: 0,
  }));
  const registry = (accounts: Array<Record<string, unknown>>) => AsyncStorage.setItem('account-registry', JSON.stringify({
    state: { accounts }, version: 0,
  }));
  const alice = { id: LOCAL, username: 'alice', email: 'alice@corp.example', serverUrl: 'https://mail.example.com', webmailUrl: WEBMAIL };
  const push = (emailIds: string[], accountId = 'jmap-primary') => pushBackgroundTask({
    kind: 'jmap-email-push', accountLabel: 'alice', accountId, emailIds: JSON.stringify(emailIds),
  });
  const shownText = () => JSON.stringify(showNotification.mock.calls);

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem('push:accountIds:v1', JSON.stringify([LOCAL]));
    await AsyncStorage.setItem('push:jmapAccountIds:v1', JSON.stringify({ [LOCAL]: 'jmap-primary' }));
    await registry([alice]);
    (NativeModules as Record<string, unknown>).BulwarkFcm = { showNotification };
    sessionAccounts = { 'jmap-primary': { name: 'alice@corp.example', isPersonal: true } };
    emails = [message('m1', SECRET_SUBJECT)];
    emailGets = [];
    (jmapClient.getStoredCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
      serverUrl: 'https://mail.example.com', username: 'alice', password: 'not-a-real-password',
    });
    (secureFetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url.endsWith('/.well-known/jmap')) {
        return {
          ok: true,
          json: async () => ({
            apiUrl: 'https://mail.example.com/jmap/',
            primaryAccounts: { 'urn:ietf:params:jmap:mail': 'jmap-primary' },
            accounts: sessionAccounts,
          }),
        };
      }
      const calls = JSON.parse(init?.body ?? '{}').methodCalls as Array<[string, Record<string, unknown>, string]>;
      return {
        ok: true,
        json: async () => ({
          methodResponses: calls.map(([name, args, id]) => {
            if (name === 'Email/get') emailGets.push(args);
            return [name, { list: name === 'Email/get' ? emails.filter((e) => (args.ids as string[]).includes(e.id as string)) : [] }, id];
          }),
        }),
      };
    });
  });

  afterEach(() => {
    delete (NativeModules as Record<string, unknown>).BulwarkFcm;
  });

  it('a domain scope applies while the registry has no address yet (username only, session names the address)', async () => {
    await registry([{ id: LOCAL, username: 'alice', serverUrl: 'https://mail.example.com', webmailUrl: WEBMAIL }]);
    sessionAccounts = { 'jmap-primary': { name: 'alice@corp.example', isPersonal: true } };
    await seedCache({ [LOCAL]: cacheEntry(orgPolicy({ devices: { pushWithoutContent: false } }, [{
      id: 'corp', match: { domains: ['corp.example'] }, policy: { organisation: { devices: { pushWithoutContent: true } } },
    }])) });
    await push(['m1']);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(shownText()).not.toContain(SECRET_SUBJECT);
  });

  it('a lookup that fails under the rule still shows nothing about the message', async () => {
    await seedCache({ [LOCAL]: cacheEntry(orgPolicy({ devices: { pushWithoutContent: true } })) });
    vi.mocked(secureFetch).mockImplementation(async (url: string) => {
      if (String(url).endsWith('/.well-known/jmap')) {
        return { ok: true, json: async () => ({ apiUrl: 'https://mail.example.com/jmap/', primaryAccounts: { 'urn:ietf:params:jmap:mail': 'jmap-primary' }, accounts: sessionAccounts }) } as never;
      }
      return { ok: false, status: 500, json: async () => ({}) } as never;
    });
    await push(['m1']);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0][0]).toMatchObject({ emailId: '', threadId: '' });
    expect(shownText()).not.toContain(SECRET_SUBJECT);
  });

  it('a lookup that fails has the group summary built without lines under the rule, and with them without it', async () => {
    const failLookup = () => vi.mocked(secureFetch).mockImplementation(async (url: string) => {
      if (String(url).endsWith('/.well-known/jmap')) {
        return { ok: true, json: async () => ({ apiUrl: 'https://mail.example.com/jmap/', primaryAccounts: { 'urn:ietf:params:jmap:mail': 'jmap-primary' }, accounts: sessionAccounts }) } as never;
      }
      return { ok: false, status: 500, json: async () => ({}) } as never;
    });
    await seedCache({ [LOCAL]: cacheEntry(orgPolicy({ devices: { pushWithoutContent: true } })) });
    failLookup();
    await push(['m1']);
    expect(showNotification.mock.calls[0][0]).toMatchObject({ notificationId: `mail-unknown:${LOCAL}`, withoutContent: true });

    showNotification.mockClear();
    await seedCache({ [LOCAL]: cacheEntry(orgPolicy({ devices: { pushWithoutContent: false } })) });
    await push(['m2']);
    expect(showNotification.mock.calls[0][0]).toMatchObject({ notificationId: `mail-unknown:${LOCAL}` });
    expect(showNotification.mock.calls[0][0]).not.toHaveProperty('withoutContent');
  });

  it('nothing changes for an organisation without the rule: full notification with actions', async () => {
    await seedCache({ [LOCAL]: cacheEntry(orgPolicy({ devices: { pushWithoutContent: false } }, [{
      id: 'other', match: { groups: ['board@corp.example'] }, policy: { organisation: { devices: { noPrint: true } } },
    }])) });
    await push(['m1']);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0][0]).toMatchObject({ emailId: 'm1', title: SENDER_NAME, body: SECRET_SUBJECT });
    expect(showNotification.mock.calls[0][0]).toHaveProperty('markReadLabel');
    expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled();
  });
});

describe('the rule for an alias login, as the push task works it out', () => {
  // Signed in as ada@alias.example; the session names the login's own account
  // ada@example.com. The rule hides content, so a scope of either address
  // turns it on: the name signed in with (what the webmail's web push uses)
  // or the session's address.
  const ID = 'ada@alias.example@mail.example.com';
  const WEBMAIL_URL = 'https://webmail.example.com';
  const SESSION = { 'jmap-primary': { name: 'ada@example.com', isPersonal: true } };
  const policyScopedTo = (domain: string) => ({
    restrictions: {}, features: {}, defaults: {}, forceEnabledThemes: [], themePolicy: {},
    organisation: { devices: { pushWithoutContent: false } },
    scopes: [{ id: 'd', match: { domains: [domain] }, policy: { organisation: { devices: { pushWithoutContent: true } } } }],
  });
  async function ruleOn(domain: string, registryEntry: Record<string, unknown>, sessionUsername: string): Promise<boolean> {
    await AsyncStorage.setItem('account-registry', JSON.stringify({
      state: { accounts: [{ id: ID, serverUrl: 'https://mail.example.com', webmailUrl: WEBMAIL_URL, ...registryEntry }] }, version: 0,
    }));
    await AsyncStorage.setItem('org-policy-cache', JSON.stringify({
      state: { byAccount: { [ID]: { policy: policyScopedTo(domain), partial: false, fetchedAt: 1, webmailUrl: WEBMAIL_URL } }, configByAccount: {} },
      version: 0,
    }));
    return pushWithoutContentFor(ID, SESSION, 'jmap-primary', sessionUsername);
  }
  const alias = { username: 'ada@alias.example', email: 'ada@alias.example' };

  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('a domain rule on the alias only turns it on', async () => {
    expect(await ruleOn('alias.example', alias, 'ada@alias.example')).toBe(true);
  });

  it('a domain rule on the session\'s address only turns it on', async () => {
    expect(await ruleOn('example.com', alias, 'ada@alias.example')).toBe(true);
  });

  it('a domain rule on neither address leaves it off', async () => {
    expect(await ruleOn('other.example', alias, 'ada@alias.example')).toBe(false);
  });

  it('a bare local part counts as the name the server signed it in as', async () => {
    // Signed in as "ada"; the server names the login ada@alias.example.
    expect(await ruleOn('alias.example', { username: 'ada', email: 'ada@example.com' }, 'ada@alias.example')).toBe(true);
  });
});
