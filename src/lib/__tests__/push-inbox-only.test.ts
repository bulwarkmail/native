import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JMAPSession } from '../../api/types';

const h = vi.hoisted(() => ({
  serves: true,
  active: 'u@https://m' as string | null,
  emailNotificationsEnabled: true,
  fetchMailboxes: vi.fn(async () => undefined),
}));

vi.mock('../../api/jmap-client', () => ({ jmapClient: { username: 'u', serverUrl: 'https://m' } }));
vi.mock('../push-notifications', () => ({
  getStoredRelayBaseUrl: vi.fn(),
  hasNotificationPermission: vi.fn(),
  resyncPushNotifications: vi.fn(),
}));
vi.mock('../push-renewal', () => ({ markPushRenewed: vi.fn() }));
vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: {
    getState: () => ({ emailNotificationsEnabled: h.emailNotificationsEnabled }),
    subscribe: vi.fn(() => () => undefined),
  },
}));
vi.mock('../../stores/email-store', () => ({
  useEmailStore: { getState: () => ({ fetchMailboxes: h.fetchMailboxes }) },
}));
vi.mock('../active-client-account', () => ({
  clientServesAccount: (id: string) => h.serves && id === h.active,
  activeAppAccountId: () => h.active,
}));

import { gainedMailAccounts, resyncPushAfterSessionChange, shouldResyncForInboxOnly } from '../push-inbox-only';
import { getStoredRelayBaseUrl, hasNotificationPermission, resyncPushNotifications } from '../push-notifications';
import { markPushRenewed } from '../push-renewal';

const s = (pushNotifyInboxOnly: boolean, emailNotificationsEnabled = true, hydrated = true) => ({ pushNotifyInboxOnly, emailNotificationsEnabled, hydrated });

describe('shouldResyncForInboxOnly', () => {
  it('re-syncs when the value changes', () => {
    expect(shouldResyncForInboxOnly(s(true), s(false))).toBe(true);
    expect(shouldResyncForInboxOnly(s(false), s(true))).toBe(true);
  });
  it('does nothing when the value is unchanged', () => {
    expect(shouldResyncForInboxOnly(s(true), s(true))).toBe(false);
  });
  it('ignores the change hydration makes', () => {
    expect(shouldResyncForInboxOnly(s(true, true, true), s(false, true, false))).toBe(false);
    expect(shouldResyncForInboxOnly(s(true, true, false), s(false, true, false))).toBe(false);
  });
  it('does nothing while notifications are off', () => {
    expect(shouldResyncForInboxOnly(s(true, false), s(false, false))).toBe(false);
  });
});

const MAIL = 'urn:ietf:params:jmap:mail';
const CALENDARS = 'urn:ietf:params:jmap:calendars';
const session = (accounts: Record<string, string[]>): JMAPSession => ({
  apiUrl: '', downloadUrl: '', uploadUrl: '', eventSourceUrl: '', primaryAccounts: {}, capabilities: {}, state: '',
  accounts: Object.fromEntries(Object.entries(accounts).map(([id, caps]) => [
    id,
    { name: id, isPersonal: id === 'me', isReadOnly: false, accountCapabilities: Object.fromEntries(caps.map((c) => [c, {}])) },
  ])) as JMAPSession['accounts'],
});

describe('gainedMailAccounts', () => {
  it('notices a mail account the refreshed session gained, and nothing else', () => {
    expect(gainedMailAccounts(session({ me: [MAIL] }), session({ me: [MAIL], team: [MAIL] }))).toBe(true);
    expect(gainedMailAccounts(session({ me: [MAIL], team: [MAIL] }), session({ me: [MAIL] }))).toBe(false);
    expect(gainedMailAccounts(session({ me: [MAIL] }), session({ me: [MAIL], cal: [CALENDARS] }))).toBe(false);
    expect(gainedMailAccounts(null, session({ me: [MAIL] }))).toBe(true);
  });
});

describe('resyncPushAfterSessionChange', () => {
  const ID = 'u@https://m';
  beforeEach(() => {
    h.serves = true;
    h.active = ID;
    h.emailNotificationsEnabled = true;
    h.fetchMailboxes.mockReset().mockResolvedValue(undefined);
    vi.mocked(getStoredRelayBaseUrl).mockReset().mockResolvedValue('https://relay');
    vi.mocked(hasNotificationPermission).mockReset().mockResolvedValue(true);
    vi.mocked(resyncPushNotifications).mockReset().mockResolvedValue(null);
    vi.mocked(markPushRenewed).mockReset();
  });

  it('resyncs push after the folders load, only while the client still serves the account', async () => {
    let loaded!: () => void;
    h.fetchMailboxes.mockImplementation(() => new Promise<undefined>((r) => { loaded = () => r(undefined); }));
    const done = resyncPushAfterSessionChange(ID);
    await Promise.resolve();
    // The filter is built from the folder list: nothing before it loads.
    expect(resyncPushNotifications).not.toHaveBeenCalled();
    loaded();
    await done;
    expect(resyncPushNotifications).toHaveBeenCalledWith({ relayBaseUrl: 'https://relay', accountLabel: 'u' });
    expect(markPushRenewed).toHaveBeenCalledWith(ID);

    // A switch lands while the folders load: the resync is dropped.
    vi.mocked(resyncPushNotifications).mockClear();
    vi.mocked(markPushRenewed).mockClear();
    h.fetchMailboxes.mockImplementation(async () => { h.active = 'other@https://m'; return undefined; });
    await resyncPushAfterSessionChange(ID);
    // And while the relay lookup runs.
    h.active = ID;
    h.fetchMailboxes.mockResolvedValue(undefined);
    vi.mocked(hasNotificationPermission).mockImplementation(async () => { h.serves = false; return true; });
    await resyncPushAfterSessionChange(ID);
    expect(resyncPushNotifications).not.toHaveBeenCalled();
    expect(markPushRenewed).not.toHaveBeenCalled();
  });

  it('does not resync while email notifications are off, or with no relay stored', async () => {
    h.emailNotificationsEnabled = false;
    await resyncPushAfterSessionChange(ID);
    h.emailNotificationsEnabled = true;
    vi.mocked(getStoredRelayBaseUrl).mockResolvedValue(null);
    await resyncPushAfterSessionChange(ID);
    vi.mocked(getStoredRelayBaseUrl).mockResolvedValue('https://relay');
    vi.mocked(hasNotificationPermission).mockResolvedValue(false);
    await resyncPushAfterSessionChange(ID);
    expect(resyncPushNotifications).not.toHaveBeenCalled();
    expect(markPushRenewed).not.toHaveBeenCalled();
  });

  it('never throws when the folder load or the resync fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.fetchMailboxes.mockRejectedValueOnce(new Error('offline'));
    await expect(resyncPushAfterSessionChange(ID)).resolves.toBeUndefined();
    expect(resyncPushNotifications).not.toHaveBeenCalled();
    vi.mocked(resyncPushNotifications).mockRejectedValueOnce(new Error('relay down'));
    await expect(resyncPushAfterSessionChange(ID)).resolves.toBeUndefined();
    expect(markPushRenewed).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
