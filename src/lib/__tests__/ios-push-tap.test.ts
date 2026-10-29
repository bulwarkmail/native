import { beforeEach, describe, expect, it } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { iosTapPayload } from '../push-notifications';

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

  it('does nothing for a push without a message id', async () => {
    expect(await iosTapPayload({ kind: 'jmap-state-change', accountId: 'c', emailIds: [] })).toBeNull();
  });
});
