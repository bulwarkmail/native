import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-notifications', () => ({
  setBadgeCountAsync: vi.fn(async () => true),
}));

import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { appBadgeCount, setAppBadge } from '../app-badge';
import type { Mailbox } from '../../api/types';

const setBadge = Notifications.setBadgeCountAsync as unknown as ReturnType<typeof vi.fn>;
const platform = Platform as { OS: string };

function mailbox(id: string, extra: Partial<Mailbox>): Mailbox {
  return {
    id,
    name: id,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    ...extra,
  } as Mailbox;
}

afterEach(() => {
  platform.OS = 'android';
  setBadge.mockClear();
});

describe('appBadgeCount', () => {
  it("counts the own inbox's unread, not a shared inbox listed first", () => {
    const mailboxes = [
      mailbox('team:inbox', { role: 'inbox', isShared: true, unreadEmails: 40 }),
      mailbox('inbox', { role: 'inbox', isShared: false, unreadEmails: 3 }),
      mailbox('lists', { unreadEmails: 12 }),
    ];
    expect(appBadgeCount(mailboxes, true)).toBe(3);
  });

  it('is 0 when the setting is off or there is no inbox yet', () => {
    expect(appBadgeCount([mailbox('inbox', { role: 'inbox', unreadEmails: 3 })], false)).toBe(0);
    expect(appBadgeCount([], true)).toBe(0);
  });
});

describe('setAppBadge', () => {
  it('sets and clears the badge on iOS', async () => {
    platform.OS = 'ios';
    await setAppBadge(5);
    await setAppBadge(0);
    expect(setBadge.mock.calls).toEqual([[5], [0]]);
  });

  it('never touches the badge on Android, where a 0 cancels every notification', async () => {
    await setAppBadge(5);
    await setAppBadge(0);
    expect(setBadge).not.toHaveBeenCalled();
  });

  it('swallows a failing native call', async () => {
    platform.OS = 'ios';
    setBadge.mockRejectedValueOnce(new Error('no permission'));
    await expect(setAppBadge(2)).resolves.toBeUndefined();
  });
});
