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

import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules } from 'react-native';
import { jmapClient } from '../../api/jmap-client';
import { secureFetch } from '../client-cert';
import {
  carriesNoMail,
  matchAccountsForPush,
  parseRelayPushData,
  pushBackgroundTask,
  selectNotifiableEmails,
  senderFaviconsAllowed,
} from '../push-background-task';
import type { Email } from '../../api/types';

describe('parseRelayPushData', () => {
  it('decodes the relay FCM data payload (all values are strings)', () => {
    const parsed = parseRelayPushData({
      kind: 'jmap-email-push',
      accountLabel: 'alice',
      accountId: 'a1',
      emailIds: JSON.stringify(['m1', 'm2']),
      changed: JSON.stringify({ a1: { EmailDelivery: 's1' } }),
    });
    expect(parsed).toEqual({
      kind: 'jmap-email-push',
      accountLabel: 'alice',
      jmapAccountId: 'a1',
      emailIds: ['m1', 'm2'],
      changed: { a1: { EmailDelivery: 's1' } },
    });
  });

  it('falls back to the first key of `changed` for the account id', () => {
    const parsed = parseRelayPushData({
      kind: 'jmap-state-change',
      emailIds: '[]',
      changed: JSON.stringify({ a9: { Email: 'x' } }),
    });
    expect(parsed.jmapAccountId).toBe('a9');
    expect(parsed.emailIds).toEqual([]);
  });

  it('tolerates garbage', () => {
    expect(parseRelayPushData(null).emailIds).toEqual([]);
    expect(parseRelayPushData({ emailIds: '{not json' }).emailIds).toEqual([]);
    expect(parseRelayPushData({ kind: 'weird' }).kind).toBeNull();
  });
});

describe('matchAccountsForPush', () => {
  const accounts = ['alice@mail.example.com', 'bob@mail.example.com'];
  const registry = [
    { id: 'alice@mail.example.com', username: 'alice' },
    { id: 'bob@mail.example.com', username: 'bob' },
  ];

  it('matches on the recorded JMAP account id first', () => {
    const payload = parseRelayPushData({ accountId: 'jb', accountLabel: 'alice' });
    expect(matchAccountsForPush(payload, accounts, { 'bob@mail.example.com': 'jb' }, registry))
      .toEqual(['bob@mail.example.com']);
  });

  it('falls back to the relay accountLabel (username)', () => {
    const payload = parseRelayPushData({ accountId: 'unknown', accountLabel: 'alice' });
    expect(matchAccountsForPush(payload, accounts, {}, registry)).toEqual(['alice@mail.example.com']);
  });

  it('checks every account when nothing matches', () => {
    const payload = parseRelayPushData({ accountId: 'unknown', accountLabel: 'carol' });
    expect(matchAccountsForPush(payload, accounts, {}, registry)).toEqual(accounts);
  });
});

describe('pushBackgroundTask notifications', () => {
  const LOCAL = 'alice@mail.example.com';
  const showNotification = vi.fn(async () => undefined);
  let emailGetAccount: string | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem('push:accountIds:v1', JSON.stringify([LOCAL]));
    await AsyncStorage.setItem('push:jmapAccountIds:v1', JSON.stringify({ [LOCAL]: 'jmap-primary' }));
    (NativeModules as Record<string, unknown>).BulwarkFcm = { showNotification };
    (jmapClient.getStoredCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
      serverUrl: 'https://mail.example.com',
      username: 'alice',
      password: 'secret',
    });
    emailGetAccount = null;
    (secureFetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url.endsWith('/.well-known/jmap')) {
        return {
          ok: true,
          json: async () => ({
            apiUrl: 'https://mail.example.com/jmap/',
            primaryAccounts: { 'urn:ietf:params:jmap:mail': 'jmap-primary' },
            accounts: { 'jmap-primary': {}, team: {} },
          }),
        };
      }
      const [[, args]] = JSON.parse(init?.body ?? '{}').methodCalls;
      emailGetAccount = args.accountId;
      return {
        ok: true,
        json: async () => ({
          methodResponses: [[
            'Email/get',
            { list: [{ id: 'm1', threadId: 't1', keywords: {}, subject: 'Hi', from: [{ email: 'bob@example.com' }] }] },
            '0',
          ]],
        }),
      };
    });
  });

  afterEach(() => {
    delete (NativeModules as Record<string, unknown>).BulwarkFcm;
  });

  it('tags a group mailbox notification with the JMAP account the message lives in (#839)', async () => {
    await pushBackgroundTask({
      kind: 'jmap-email-push',
      accountLabel: 'alice',
      accountId: 'team',
      emailIds: JSON.stringify(['m1']),
    });

    expect(emailGetAccount).toBe('team');
    expect(showNotification).toHaveBeenCalledWith(
      expect.objectContaining({ emailId: 'm1', accountId: LOCAL, jmapAccountId: 'team' }),
    );
  });

  it('tags the user\'s own mail with the primary account', async () => {
    await pushBackgroundTask({
      kind: 'jmap-email-push',
      accountLabel: 'alice',
      accountId: 'jmap-primary',
      emailIds: JSON.stringify(['m1']),
    });

    expect(showNotification).toHaveBeenCalledWith(
      expect.objectContaining({ emailId: 'm1', accountId: LOCAL, jmapAccountId: 'jmap-primary' }),
    );
  });

  it("says a message has no subject in the app's language", async () => {
    await AsyncStorage.setItem('webmail:locale:v1', JSON.stringify({ override: 'de' }));
    (secureFetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => (url.endsWith('/.well-known/jmap')
        ? {
          apiUrl: 'https://mail.example.com/jmap/',
          primaryAccounts: { 'urn:ietf:params:jmap:mail': 'jmap-primary' },
          accounts: { 'jmap-primary': {} },
        }
        : {
          methodResponses: [[
            'Email/get',
            { list: [{ id: 'm1', threadId: 't1', keywords: {}, subject: '', from: [{ email: 'bob@example.com' }] }] },
            '0',
          ]],
        }),
    }));

    await pushBackgroundTask({
      kind: 'jmap-email-push',
      accountLabel: 'alice',
      accountId: 'jmap-primary',
      emailIds: JSON.stringify(['m1']),
    });

    expect(showNotification).toHaveBeenCalledWith(expect.objectContaining({ emailId: 'm1', body: '(Kein Betreff)' }));
  });
});

describe('pushBackgroundTask when the new mail cannot be looked up', () => {
  const LOCAL = 'alice@mail.example.com';
  const showNotification = vi.fn(async () => undefined);
  let jmapPost: (body: { methodCalls: Array<[string, Record<string, unknown>, string]> }) => unknown;

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem('push:accountIds:v1', JSON.stringify([LOCAL]));
    await AsyncStorage.setItem('push:jmapAccountIds:v1', JSON.stringify({ [LOCAL]: 'jmap-primary' }));
    (NativeModules as Record<string, unknown>).BulwarkFcm = { showNotification };
    (jmapClient.getStoredCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
      serverUrl: 'https://mail.example.com',
      username: 'alice',
      password: 'secret',
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
      return jmapPost(JSON.parse(init?.body ?? '{}'));
    });
  });

  afterEach(() => {
    delete (NativeModules as Record<string, unknown>).BulwarkFcm;
  });

  const push = {
    kind: 'jmap-email-push',
    accountLabel: 'Work',
    accountId: 'jmap-primary',
    emailIds: JSON.stringify(['m1']),
  };

  it('shows a generic notification when the message lookup fails', async () => {
    jmapPost = () => ({
      ok: true,
      json: async () => ({ methodResponses: [['error', { type: 'serverFail' }, '0']] }),
    });

    await pushBackgroundTask(push);

    expect(showNotification).toHaveBeenCalledTimes(1);
    const shown = (showNotification.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(shown).toMatchObject({
      notificationId: `mail-generic:${LOCAL}`,
      title: 'New email',
      body: 'Work',
      accountId: LOCAL,
      groupKey: `bulwark-mail:${LOCAL}`,
    });
    expect(shown.emailId).toBeUndefined();
  });

  it('shows a generic notification when the request fails', async () => {
    jmapPost = () => ({ ok: false, status: 503 });

    await pushBackgroundTask(push);

    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledWith(
      expect.objectContaining({ notificationId: `mail-generic:${LOCAL}`, body: 'Work' }),
    );
  });

  it('never shows another message in place of the one that arrived', async () => {
    const methods: string[] = [];
    jmapPost = ({ methodCalls }) => {
      methods.push(methodCalls[0][0]);
      return {
        ok: true,
        json: async () => ({
          methodResponses: [[
            'Email/get',
            { list: [], notFound: ['m1'] },
            '0',
          ]],
        }),
      };
    };

    await pushBackgroundTask(push);

    expect(methods).toEqual(['Email/get']);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledWith(
      expect.objectContaining({ notificationId: `mail-generic:${LOCAL}` }),
    );
  });

  it('shows a generic notification when the legacy look-up for unread mail fails', async () => {
    jmapPost = () => ({
      ok: true,
      json: async () => ({ methodResponses: [['error', { type: 'serverFail' }, '0']] }),
    });

    await pushBackgroundTask({ kind: 'jmap-state-change', accountLabel: 'Work', accountId: 'jmap-primary' });

    expect(showNotification).toHaveBeenCalledWith(
      expect.objectContaining({ notificationId: `mail-generic:${LOCAL}` }),
    );
  });

  it('stays silent when the inbox simply has nothing unread', async () => {
    jmapPost = ({ methodCalls }) => ({
      ok: true,
      json: async () => ({
        methodResponses: [
          methodCalls[0][0] === 'Mailbox/get'
            ? ['Mailbox/get', { list: [{ id: 'inbox', role: 'inbox' }] }, '0']
            : ['Email/query', { ids: [] }, '0'],
        ],
      }),
    });

    await pushBackgroundTask({ kind: 'jmap-state-change', accountLabel: 'Work', accountId: 'jmap-primary' });

    expect(showNotification).not.toHaveBeenCalled();
  });
});

describe('pushes for device sync (#34)', () => {
  const LOCAL = 'alice@mail.example.com';
  const showNotification = vi.fn(async () => undefined);
  const stateChange = (changed: Record<string, Record<string, string>>) => ({
    kind: 'jmap-state-change',
    accountLabel: 'alice',
    accountId: Object.keys(changed)[0],
    emailIds: '[]',
    changed: JSON.stringify(changed),
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem('push:accountIds:v1', JSON.stringify([LOCAL]));
    await AsyncStorage.setItem('push:jmapAccountIds:v1', JSON.stringify({ [LOCAL]: 'jmap-primary' }));
    (NativeModules as Record<string, unknown>).BulwarkFcm = { showNotification };
    (jmapClient.getStoredCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
      serverUrl: 'https://mail.example.com',
      username: 'alice',
      password: 'secret',
    });
    (secureFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 500 });
  });

  afterEach(() => {
    delete (NativeModules as Record<string, unknown>).BulwarkFcm;
  });

  it('tells contact and calendar changes from new mail', () => {
    expect(carriesNoMail(parseRelayPushData(stateChange({ a: { ContactCard: 's1', AddressBook: 's2' } })))).toBe(true);
    expect(carriesNoMail(parseRelayPushData(stateChange({ a: { CalendarEvent: 'e1' }, b: { Calendar: 'c1' } })))).toBe(true);
    // Mail in any account of the map, an EmailPush, or a map it can't read: as before.
    expect(carriesNoMail(parseRelayPushData(stateChange({ a: { ContactCard: 's1' }, b: { EmailDelivery: 'm1' } })))).toBe(false);
    expect(carriesNoMail(parseRelayPushData({ kind: 'jmap-email-push', accountId: 'a', emailIds: '["m1"]' }))).toBe(false);
    expect(carriesNoMail(parseRelayPushData({ kind: 'jmap-state-change', emailIds: '[]', changed: '{}' }))).toBe(false);
    expect(carriesNoMail(parseRelayPushData({ kind: 'jmap-state-change', emailIds: '[]' }))).toBe(false);
  });

  it('neither looks for mail nor notifies for a change without new mail', async () => {
    await pushBackgroundTask(stateChange({ 'jmap-primary': { ContactCard: 's1' }, team: { CalendarEvent: 'e1' } }));
    expect(jmapClient.getStoredCredentials).not.toHaveBeenCalled();
    expect(secureFetch).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('still checks for mail when the map carries new mail', async () => {
    await pushBackgroundTask(stateChange({ 'jmap-primary': { EmailDelivery: 'm1', ContactCard: 's1' } }));
    expect(jmapClient.getStoredCredentials).toHaveBeenCalledWith(LOCAL);
  });

  // kind (undefined: none), changed (undefined: none) → whether the push may
  // carry mail. The same table as "reads a push the same way as the push task"
  // in PushRoutingTest.kt, whose startMailTask must agree.
  const STATE = 'jmap-state-change';
  const EMAIL_PUSH = 'jmap-email-push';
  const MAIL_CASES: Array<[string | undefined, string | undefined, boolean]> = [
    // No readable map: as before device sync.
    [STATE, undefined, true],
    [STATE, '', true],
    [STATE, 'not json', true],
    [STATE, '[1]', true],
    [STATE, '{}', true],
    // A map that names no type is read like a missing one.
    [STATE, '{"c":{}}', true],
    [STATE, '{"c":{},"team":{}}', true],
    // An account entry that can't be read may be mail.
    [STATE, '{"c":null}', true],
    [STATE, '{"c":"garbled","team":{"ContactCard":"s"}}', true],
    [STATE, '{"c":[],"team":{"ContactCard":"s"}}', true],
    [STATE, '{"c":5}', true],
    // Mail types anywhere in the map.
    [STATE, '{"c":{"EmailDelivery":"s"}}', true],
    [STATE, '{"c":{"Email":"s"}}', true],
    [STATE, '{"c":{"Mailbox":"s"}}', true],
    [STATE, '{"c":{"ContactCard":"s1"},"team":{"EmailDelivery":"s2"}}', true],
    // Only a StateChange can say it carries no mail.
    [undefined, '{"c":{"ContactCard":"s"}}', true],
    [EMAIL_PUSH, '{"c":{"EmailDelivery":"s"}}', true],
    [EMAIL_PUSH, undefined, true],
    // Contact and calendar changes, and types that say nothing about mail.
    [STATE, '{"c":{"ContactCard":"s1","AddressBook":"s2"}}', false],
    [STATE, '{"c":{"CalendarEvent":"e1"},"team":{"Calendar":"c1"}}', false],
    [STATE, '{"c":{"ContactCard":"s"},"team":{}}', false],
    [STATE, '{"elsewhere":{"ContactCard":"s"}}', false],
    [STATE, '{"c":{"Thread":"t1","ContactCard":"s1"}}', false],
  ];

  it('reads a push the same way as the native router', () => {
    for (const [kind, changed, mail] of MAIL_CASES) {
      const data: Record<string, string> = { accountLabel: 'alice', accountId: 'c', emailIds: '[]' };
      if (kind !== undefined) data.kind = kind;
      if (changed !== undefined) data.changed = changed;
      expect(carriesNoMail(parseRelayPushData(data)), `kind=${kind} changed=${changed}`).toBe(!mail);
    }
    // Native code hands `changed` over as a string; a map that is not an
    // object is unreadable in any form.
    expect(carriesNoMail(parseRelayPushData({ kind: STATE, changed: [{ ContactCard: 's' }] }))).toBe(false);
  });

  it("looks for mail when it can't read an account's entry, as the native router does", async () => {
    for (const changed of ['{"jmap-primary":null}', '{"jmap-primary":{}}']) {
      vi.clearAllMocks();
      await pushBackgroundTask({ kind: STATE, accountLabel: 'alice', accountId: 'jmap-primary', emailIds: '[]', changed });
      expect(jmapClient.getStoredCredentials, changed).toHaveBeenCalledWith(LOCAL);
    }
  });

  it('takes an Email or Mailbox change for possible mail, as a subscription from an older build sends it', () => {
    expect(carriesNoMail(parseRelayPushData(stateChange({ a: { Email: 's1', Mailbox: 's2' } })))).toBe(false);
    expect(carriesNoMail(parseRelayPushData(stateChange({ a: { Email: 's1' } })))).toBe(false);
    expect(carriesNoMail(parseRelayPushData(stateChange({ a: { Mailbox: 's1' } })))).toBe(false);
    expect(carriesNoMail(parseRelayPushData(stateChange({ a: { CalendarEvent: 'e1' }, b: { Email: 's1' } })))).toBe(false);
    // Types that are neither mail nor device sync say nothing about mail.
    expect(carriesNoMail(parseRelayPushData(stateChange({ a: { Thread: 't1', ContactCard: 's1' } })))).toBe(true);
  });

  it('notifies new mail from a subscription that listens to Email and Mailbox', async () => {
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
      // The legacy path: the inbox, its newest unread ids, then the messages.
      const [[name]] = JSON.parse(init?.body ?? '{}').methodCalls;
      const body = name === 'Mailbox/get'
        ? { list: [{ id: 'inbox', role: 'inbox' }] }
        : name === 'Email/query'
          ? { ids: ['m1'] }
          : { list: [{ id: 'm1', threadId: 't1', keywords: {}, subject: 'Hi', from: [{ email: 'bob@example.com' }] }] };
      return { ok: true, json: async () => ({ methodResponses: [[name, body, '0']] }) };
    });

    await pushBackgroundTask(stateChange({ 'jmap-primary': { Email: 's1', Mailbox: 's2' } }));

    expect(showNotification).toHaveBeenCalledWith(expect.objectContaining({ emailId: 'm1', accountId: LOCAL }));
  });
});

describe('selectNotifiableEmails', () => {
  const email = (id: string, keywords: Record<string, boolean> = {}): Email =>
    ({ id, threadId: 't', keywords, mailboxIds: {}, size: 0, receivedAt: '', hasAttachment: false } as Email);

  it('drops read, junk and already-notified messages', () => {
    const out = selectNotifiableEmails(
      [email('a'), email('b', { $seen: true }), email('c', { $junk: true }), email('d')],
      ['d'],
    );
    expect(out.map((e) => e.id)).toEqual(['a']);
  });
});

describe('senderFaviconsAllowed', () => {
  const KEY = 'webmail:settings:v1';

  it('follows the "Sender Favicons" setting the settings store persisted', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({ senderFavicons: false }));
    expect(await senderFaviconsAllowed()).toBe(false);
    await AsyncStorage.setItem(KEY, JSON.stringify({ senderFavicons: true }));
    expect(await senderFaviconsAllowed()).toBe(true);
  });

  it('defaults to on like the store, but skips icons when the settings are unreadable', async () => {
    await AsyncStorage.removeItem(KEY);
    expect(await senderFaviconsAllowed()).toBe(true);
    await AsyncStorage.setItem(KEY, '{not json');
    expect(await senderFaviconsAllowed()).toBe(false);
    await AsyncStorage.removeItem(KEY);
  });
});
