// With the organisation rule devices.pushWithoutContent on, a new-mail
// notification on Android carries neither the sender, the subject nor the
// preview (the Android push task; the iOS extension's share is in
// push-without-content-ios.test.ts).
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
import { showNotificationOnce } from './native-notified-ids';

const LOCAL = 'alice@mail.example.com';
const WEBMAIL = 'https://webmail.example.com';
const SECRET_SUBJECT = 'Quarterly numbers before the announcement';
const SECRET_PREVIEW = 'Revenue is down 14 percent, do not forward';
const SENDER_NAME = 'Dana Finance';
const SENDER_ADDRESS = 'dana@corp.example';

function policyCache(pushWithoutContent: boolean) {
  return JSON.stringify({
    state: {
      byAccount: {
        [LOCAL]: {
          policy: {
            restrictions: {}, features: {}, defaults: {}, forceEnabledThemes: [], scopes: [],
            themePolicy: {},
            organisation: { devices: { pushWithoutContent } },
          },
          partial: false,
          fetchedAt: Date.now(),
          webmailUrl: WEBMAIL,
        },
      },
      configByAccount: {},
    },
    version: 0,
  });
}

describe('new-mail notifications under devices.pushWithoutContent', () => {
  const showNotification = vi.fn(async (_opts: Record<string, unknown>) => undefined);

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem('push:accountIds:v1', JSON.stringify([LOCAL]));
    await AsyncStorage.setItem('push:jmapAccountIds:v1', JSON.stringify({ [LOCAL]: 'jmap-primary' }));
    await AsyncStorage.setItem('account-registry', JSON.stringify({
      state: { accounts: [{ id: LOCAL, username: 'alice', serverUrl: 'https://mail.example.com', webmailUrl: WEBMAIL }] },
      version: 0,
    }));
    (NativeModules as Record<string, unknown>).BulwarkFcm = { showNotification };
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
            accounts: { 'jmap-primary': {} },
          }),
        };
      }
      const calls = JSON.parse(init?.body ?? '{}').methodCalls as Array<[string, Record<string, unknown>, string]>;
      return {
        ok: true,
        json: async () => ({
          methodResponses: calls.map(([name, , id]) => [name, {
            list: [{
              id: 'm1', threadId: 't1', keywords: {}, receivedAt: new Date().toISOString(),
              subject: SECRET_SUBJECT, preview: SECRET_PREVIEW,
              from: [{ name: SENDER_NAME, email: SENDER_ADDRESS }],
            }],
          }, id]),
        }),
      };
    });
  });

  afterEach(() => {
    delete (NativeModules as Record<string, unknown>).BulwarkFcm;
  });

  const push = () => pushBackgroundTask({
    kind: 'jmap-email-push', accountLabel: 'alice', accountId: 'jmap-primary', emailIds: JSON.stringify(['m1']),
  });

  it('control: without the rule the notification names sender and subject', async () => {
    await AsyncStorage.setItem('org-policy-cache', policyCache(false));
    await push();
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(showNotification.mock.calls[0][0])).toContain(SECRET_SUBJECT);
  });

  it('with the rule on, the notification says only that there is new mail', async () => {
    await AsyncStorage.setItem('org-policy-cache', policyCache(true));
    await push();
    expect(showNotification).toHaveBeenCalledTimes(1);
    const shown = JSON.stringify(showNotification.mock.calls[0][0]);
    expect(shown).not.toContain(SECRET_SUBJECT);
    expect(shown).not.toContain(SECRET_PREVIEW);
    expect(shown).not.toContain(SENDER_NAME);
    expect(shown).not.toContain(SENDER_ADDRESS);
    expect(shown).not.toContain('duckduckgo'); // no sender favicon lookup either
  });
});

describe('the rule for groups, several messages, older notifications and the cache', () => {
  const showNotification = vi.fn(showNotificationOnce);
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

  it('does not ask the server for sender, subject or preview under the rule', async () => {
    await seedCache({ [LOCAL]: cacheEntry(orgPolicy({ devices: { pushWithoutContent: true } })) });
    await push(['m1']);
    expect(emailGets).toHaveLength(1);
    expect(emailGets[0].properties).not.toContain('from');
    expect(emailGets[0].properties).not.toContain('subject');
    expect(emailGets[0].properties).not.toContain('preview');
    // Without the rule it does.
    emails = [message('m2', SECRET_SUBJECT)];
    await seedCache({ [LOCAL]: cacheEntry(orgPolicy({ devices: { pushWithoutContent: false } })) });
    await push(['m2']);
    expect(emailGets[1].properties).toEqual(expect.arrayContaining(['from', 'subject', 'preview']));
  });

  it('shows one notification without any subject for several messages, and none of their ids', async () => {
    emails = [message('m1', 'First secret'), message('m2', 'Second secret'), message('m3', 'Third secret')];
    await seedCache({ [LOCAL]: cacheEntry(orgPolicy({ devices: { pushWithoutContent: true } })) });
    await push(['m1', 'm2', 'm3']);
    expect(showNotification).toHaveBeenCalledTimes(1);
    const shown = showNotification.mock.calls[0][0];
    expect(shownText()).not.toMatch(/secret/i);
    expect(shown).toMatchObject({ emailId: '', threadId: '', groupKey: `bulwark-mail:${LOCAL}` });
    expect(shown).not.toHaveProperty('markReadLabel');
    expect(shown).not.toHaveProperty('replyLabel');
    // The native side records the messages it stands for, newest first, as
    // it posts it, under the lock the native lookup posts with.
    expect(shown).toMatchObject({ notified: { accountId: LOCAL, ids: ['m3', 'm2', 'm1'] } });
    // They count as notified: the next push for them shows nothing more.
    await push(['m1', 'm2', 'm3']);
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('leaves recording the messages of the notification without content to the native side', async () => {
    // A native side that records nothing: whatever is in the ring after the
    // push, the push task wrote it.
    showNotification.mockImplementationOnce(async () => true);
    emails = [message('m1', 'First secret'), message('m2', 'Second secret')];
    await seedCache({ [LOCAL]: cacheEntry(orgPolicy({ devices: { pushWithoutContent: true } })) });
    await push(['m1', 'm2']);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0][0]).toMatchObject({ notified: { accountId: LOCAL, ids: ['m2', 'm1'] } });
    expect(await AsyncStorage.getItem(`push:notifiedIds:v1:${LOCAL}`)).toBeNull();
    expect(await AsyncStorage.getItem(`push:lastNotifiedEmailId:v2:${LOCAL}`)).toBeNull();
  });

  it('has the account\'s group summary built without lines from other notifications under the rule', async () => {
    // Android builds the summary from what is still in the group, which can
    // include message notifications whose removal hasn't landed yet.
    await seedCache({ [LOCAL]: cacheEntry(orgPolicy({ devices: { pushWithoutContent: true } })) });
    await push(['m1']);
    expect(showNotification.mock.calls[0][0]).toMatchObject({ groupKey: `bulwark-mail:${LOCAL}`, withoutContent: true });
    // Without the rule the summary lists the messages as before.
    emails = [message('m2', SECRET_SUBJECT)];
    showNotification.mockClear();
    await seedCache({ [LOCAL]: cacheEntry(orgPolicy({ devices: { pushWithoutContent: false } })) });
    await push(['m2']);
    expect(showNotification.mock.calls[0][0]).not.toHaveProperty('withoutContent');
  });

  it('applies a scope of one of the login\'s group accounts, also to a push for that group', async () => {
    const scoped = orgPolicy({ devices: { pushWithoutContent: false } }, [{
      id: 'board', match: { groups: ['board@corp.example'] }, policy: { organisation: { devices: { pushWithoutContent: true } } },
    }]);
    await seedCache({ [LOCAL]: cacheEntry(scoped) });
    // The login's session doesn't list the group: the scope isn't the login's.
    await push(['m1']);
    expect(shownText()).toContain(SECRET_SUBJECT);

    sessionAccounts = {
      'jmap-primary': { name: 'alice@corp.example', isPersonal: true },
      g1: { name: 'board@corp.example', isPersonal: false },
    };
    emails = [message('m2', SECRET_SUBJECT)];
    showNotification.mockClear();
    await push(['m2']);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(shownText()).not.toContain(SECRET_SUBJECT);

    // A message in the group account: the login's rule decides.
    emails = [message('g-m3', SECRET_SUBJECT)];
    showNotification.mockClear();
    await push(['g-m3'], 'g1');
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(shownText()).not.toContain(SECRET_SUBJECT);
  });

  it('keeps the rule while the webmail answers with the public part, and only a full policy ends it', async () => {
    await seedCache({ [LOCAL]: cacheEntry(orgPolicy(undefined), { partial: true, pushWithoutContent: true }) });
    await push(['m1']);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(shownText()).not.toContain(SECRET_SUBJECT);

    emails = [message('m2', SECRET_SUBJECT)];
    showNotification.mockClear();
    await seedCache({ [LOCAL]: cacheEntry(orgPolicy({ devices: { pushWithoutContent: false } })) });
    await push(['m2']);
    expect(shownText()).toContain(SECRET_SUBJECT);
  });

  it('shows content for a login without a cached policy or with one from another webmail', async () => {
    await push(['m1']);
    expect(shownText()).toContain(SECRET_SUBJECT);

    emails = [message('m2', SECRET_SUBJECT)];
    showNotification.mockClear();
    await seedCache({ [LOCAL]: cacheEntry(orgPolicy({ devices: { pushWithoutContent: true } }), { webmailUrl: 'https://old-webmail.example.com' }) });
    await push(['m2']);
    expect(shownText()).toContain(SECRET_SUBJECT);
  });

  it('holds content back when the policy cache can\'t be read, but not for a login without a webmail', async () => {
    await AsyncStorage.setItem('org-policy-cache', '{"state":{"byAccount":');
    await push(['m1']);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(shownText()).not.toContain(SECRET_SUBJECT);

    emails = [message('m2', SECRET_SUBJECT)];
    showNotification.mockClear();
    await registry([{ ...alice, webmailUrl: undefined }]);
    await push(['m2']);
    expect(shownText()).toContain(SECRET_SUBJECT);
  });

  it('takes the account\'s earlier message notifications out of the tray under the rule', async () => {
    await AsyncStorage.setItem('push:notifiedIds:v1:' + LOCAL, JSON.stringify(['old1', 'old2']));
    const foreign = (tag: string, id: number) => ({ request: { identifier: `expo-notifications://foreign_notifications?tag=${encodeURIComponent(tag)}&id=${id}` } });
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      foreign('mail:old1', 11),
      foreign('mail:somebody-elses', 12),
      foreign('bulwark-mail:' + LOCAL, 13),
      { request: { identifier: 'calendar-reminder-1' } },
    ] as never);
    await seedCache({ [LOCAL]: cacheEntry(orgPolicy({ devices: { pushWithoutContent: true } })) });
    await push(['m1']);
    expect(vi.mocked(Notifications.dismissNotificationAsync).mock.calls).toEqual([[foreign('mail:old1', 11).request.identifier]]);

    // Without the rule they stay.
    vi.mocked(Notifications.dismissNotificationAsync).mockClear();
    emails = [message('m2', SECRET_SUBJECT)];
    await seedCache({ [LOCAL]: cacheEntry(orgPolicy({ devices: { pushWithoutContent: false } })) });
    await push(['m2']);
    expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled();
  });

  it('stays plain for two logins with the same account id when one has the rule', async () => {
    await AsyncStorage.setItem('push:accountIds:v1', JSON.stringify([LOCAL, OTHER]));
    await AsyncStorage.setItem('push:jmapAccountIds:v1', JSON.stringify({ [LOCAL]: 'jmap-primary', [OTHER]: 'jmap-primary' }));
    await registry([alice, { id: OTHER, username: 'alice', email: 'alice@other.example', serverUrl: 'https://mail.other.org' }]);
    await seedCache({ [LOCAL]: cacheEntry(orgPolicy({ devices: { pushWithoutContent: true } })) });
    await push(['m1']);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(shownText()).not.toContain(SECRET_SUBJECT);
  });
});
