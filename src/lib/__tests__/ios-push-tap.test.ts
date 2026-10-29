import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

vi.mock('../ios-push-shared', () => ({
  apnsEnvironment: () => 'production',
  writeIosPushAccount: vi.fn(async () => undefined),
  removeIosPushAccount: vi.fn(async () => undefined),
}));

import { iosTapPayload, shareAccountWithExtension } from '../push-notifications';
import { removeIosPushAccount, writeIosPushAccount } from '../ios-push-shared';

// The extension's entry for a pushed account is keyed by the JMAP account id
// alone (NotificationService.swift reads bulwark_push_account__<id>).
describe('shareAccountWithExtension', () => {
  const API = 'https://mail.example.org/jmap/';

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    (Platform as { OS: string }).OS = 'ios';
  });

  afterEach(() => {
    (Platform as { OS: string }).OS = 'android';
  });

  it('shares the login whose push setup recorded the JMAP account id', async () => {
    await AsyncStorage.setItem('push:jmapAccountIds:v1', JSON.stringify({ 'ada@mail.example.org': 'c' }));
    await shareAccountWithExtension('ada@mail.example.org', 'c', API);
    expect(writeIosPushAccount).toHaveBeenCalledWith('c', { credentialsKey: expect.any(String), apiUrl: API });
  });

  it('shares neither of two logins with the same JMAP account id, so the extension shows its placeholder', async () => {
    await AsyncStorage.setItem('push:jmapAccountIds:v1', JSON.stringify({
      'ada@mail.example.org': 'c',
      'bea@other.example.net': 'c',
    }));
    await shareAccountWithExtension('bea@other.example.net', 'c', 'https://other.example.net/jmap/');
    expect(writeIosPushAccount).not.toHaveBeenCalled();
    expect(removeIosPushAccount).toHaveBeenCalledWith('c');
  });
});

// A tapped iOS mail notification: the relay's ids arrive as the
// notification's data (APNs `body`), the notification extension adds the
// message it showed, and the app opens that message under the account whose
// push setup recorded the JMAP account id.

describe('iosTapPayload', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem('push:jmapAccountIds:v1', JSON.stringify({ 'ada@mail.example.org': 'c' }));
  });

  it('opens the message the extension showed, in the right account', async () => {
    const payload = await iosTapPayload({
      kind: 'jmap-email-push',
      accountId: 'c',
      emailIds: ['e1', 'e2'],
      emailId: 'e2',
      threadId: 't2',
    });
    expect(payload).toEqual({ emailId: 'e2', threadId: 't2', accountId: 'ada@mail.example.org', jmapAccountId: 'c' });
  });

  it('falls back to the first pushed id when the extension could not fetch', async () => {
    const payload = await iosTapPayload({ kind: 'jmap-email-push', accountId: 'c', emailIds: ['e1'] });
    expect(payload?.emailId).toBe('e1');
    expect(payload?.threadId).toBe('');
  });

  it('leaves calendar reminders and other local notifications alone', async () => {
    expect(await iosTapPayload({ eventId: 'ev1', calendarId: 'cal' })).toBeNull();
    expect(await iosTapPayload(null)).toBeNull();
  });

  it('tells two logins with the same JMAP account id apart by the relay label, or opens nothing', async () => {
    await AsyncStorage.setItem('push:jmapAccountIds:v1', JSON.stringify({
      'ada@mail.example.org': 'c',
      'bea@other.example.net': 'c',
    }));
    const push = { kind: 'jmap-email-push', accountId: 'c', emailIds: ['e1'] };
    expect((await iosTapPayload({ ...push, accountLabel: 'bea' }))?.accountId).toBe('bea@other.example.net');
    // Opening e1 in either login is a guess: the app opens as it is.
    expect(await iosTapPayload({ ...push, accountLabel: 'carl' })).toBeNull();
    expect(await iosTapPayload(push)).toBeNull();
  });

  it('does nothing for a push without a message id', async () => {
    expect(await iosTapPayload({ kind: 'jmap-state-change', accountId: 'c', emailIds: [] })).toBeNull();
  });
});
