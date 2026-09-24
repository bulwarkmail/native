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
