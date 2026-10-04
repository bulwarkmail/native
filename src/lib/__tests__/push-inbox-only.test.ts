import { describe, it, expect, vi } from 'vitest';

vi.mock('../../api/jmap-client', () => ({ jmapClient: { username: 'u', serverUrl: 'https://m' } }));
vi.mock('../push-notifications', () => ({
  getStoredRelayBaseUrl: vi.fn(),
  hasNotificationPermission: vi.fn(),
  resyncPushNotifications: vi.fn(),
}));
vi.mock('../push-renewal', () => ({ markPushRenewed: vi.fn() }));

import { shouldResyncForInboxOnly } from '../push-inbox-only';

const s = (pushNotifyInboxOnly: boolean, emailNotificationsEnabled = true) => ({ pushNotifyInboxOnly, emailNotificationsEnabled });

describe('shouldResyncForInboxOnly', () => {
  it('re-syncs when the value changes', () => {
    expect(shouldResyncForInboxOnly(s(true), s(false))).toBe(true);
    expect(shouldResyncForInboxOnly(s(false), s(true))).toBe(true);
  });
  it('does nothing when the value is unchanged', () => {
    expect(shouldResyncForInboxOnly(s(true), s(true))).toBe(false);
  });
  it('does nothing while notifications are off', () => {
    expect(shouldResyncForInboxOnly(s(true, false), s(false, false))).toBe(false);
  });
});
