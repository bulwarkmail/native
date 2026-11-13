import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/identity', () => ({ getIdentities: vi.fn(async () => []) }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { NetworkError, jmapClient, type JMAPClient } from '../../api/jmap-client';
import { resetBulwarkMetadata } from '../../api/bulwark-metadata';
import { EMPTY_SETTINGS_RULES } from '../../lib/org-policy';
import { shardKey, shardOf, UNKNOWN_AGE } from '../../lib/settings-sync';
import { useAccountStore, type AccountEntry } from '../account-store';
import { useNetworkStore } from '../network-store';
import { usePolicyStore } from '../policy-store';
import { DEFAULT_PERSISTED, resetPolicyRulesForTests, useSettingsStore } from '../settings-store';
import {
  resetSettingsSyncForTests, setSettingsSyncClientFactory, settingsSyncStampsForTests, startSettingsSync,
  useSettingsSyncStore,
} from '../settings-sync-store';
import { useToastStore } from '../toast-store';
import { FakeMetadataServer, FakeSyncClient } from './fake-metadata-server';

// Settings sync against an account's private Inbox metadata as Stalwart
// 1.1.0 keeps it (#117). The other device is played by writing to the fake account.

const account = (id: string): AccountEntry => ({
  id, serverUrl: 'https://mail.example.org', username: id, displayName: id, email: `${id}@example.org`,
  avatarColor: '#000', lastLoginAt: 1, isConnected: true, hasError: false, isDefault: false,
});

let server: FakeMetadataServer;
let stop: () => void;

const settings = () => useSettingsStore.getState();
const sync = () => useSettingsSyncStore.getState();
const plain = (name: string) => server.entry(shardKey(shardOf(name)))?.[name];
/** Store a plain setting in the account as another device would. */
function otherDeviceSets(name: string, stored: Record<string, unknown>): void {
  const key = shardKey(shardOf(name));
  server.put(key, { ...(server.entry(key) ?? {}), [name]: stored });
}
/** Let the timers and the round they start run to the end. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(2000);
  await sync().syncNow();
};

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
  await AsyncStorage.clear();
  resetBulwarkMetadata();
  resetPolicyRulesForTests();
  resetSettingsSyncForTests();
  FakeSyncClient.reset();
  server = new FakeMetadataServer();
  FakeSyncClient.servers = { first: server };
  setSettingsSyncClientFactory(() => new FakeSyncClient() as unknown as JMAPClient);
  useAccountStore.setState({ accounts: [account('first')], activeAccountId: 'first', defaultAccountId: 'first' });
  useNetworkStore.setState({ online: true });
  // The organisation policy of the active account has been applied.
  await usePolicyStore.persist.rehydrate();
  usePolicyStore.setState({ accountId: 'first' });
  useToastStore.setState({ toasts: [] });
  useSettingsStore.getState().resetToDefaults();
  useSettingsStore.setState({ hydrated: true, settingsSyncEnabled: true, settingsSyncAccountId: null });
  stop = startSettingsSync();
  await vi.advanceTimersByTimeAsync(0);
});

afterEach(() => {
  stop();
  setSettingsSyncClientFactory(null);
  vi.useRealTimers();
});

describe('the first round of a device', () => {
  it('takes what the account holds, and counts it as chosen', async () => {
    otherDeviceSets('showPreview', { v: false, at: 500 });
    otherDeviceSets('firstDayOfWeek', { v: 6, at: 500 });
    const apps = [{ id: 'app-1', name: 'Docs', url: 'https://docs.example.org' }];
    server.put('settings.value.sidebar-apps', { k: 'sidebarApps', v: apps, at: 500 });

    await settle();

    expect(settings().showPreview).toBe(false);
    // The webmail's name for the app's calendarFirstDayOfWeek.
    expect(settings().calendarFirstDayOfWeek).toBe(6);
    expect(settings().sidebarApps).toEqual(apps);
    expect(settings().explicitSettings).toEqual(expect.arrayContaining(['showPreview', 'calendarFirstDayOfWeek']));
    expect(sync().status).toBe('synced');
    expect(sync().replaced).toBeNull();
    // Taking is not a change made here: nothing goes back.
    expect(server.patches).toEqual([]);
  });

  it('survives a restart: the values taken are in storage', async () => {
    otherDeviceSets('showPreview', { v: false, at: 500 });
    await settle();
    const stored = JSON.parse((await AsyncStorage.getItem('webmail:settings:v1'))!);
    expect(stored.showPreview).toBe(false);
    expect(JSON.parse((await AsyncStorage.getItem('settings-sync:v1'))!).stamps.showPreview).toBe(500);
  });

  it('sends what was chosen on this device before sync existed, and nothing else', async () => {
    useSettingsStore.setState({
      density: 'compact', attachmentReminderKeywords: ['invoice'],
      // Settings of this device and of the accounts on it: never sent.
      swipeMode: 'reveal', readingPane: 'off', offlineCacheEnabled: true,
      trustedSenders: ['ada@example.org'], preferredIdentityIds: { a: 'id-1' }, sharedCalendarColors: { c: '#ff0000' },
      emailNotificationsEnabled: false, debugMode: true,
      explicitSettings: ['density', 'emailNotificationsEnabled', 'debugMode'],
    });

    await settle();

    expect(plain('density')).toEqual({ v: 'compact', at: UNKNOWN_AGE });
    expect(server.entry('settings.value.attachment-reminder-keywords'))
      .toEqual({ k: 'attachmentReminderKeywords', v: ['invoice'], at: UNKNOWN_AGE });
    const stored = JSON.stringify(server.metadata);
    for (const local of [
      'swipeMode', 'readingPane', 'offlineCacheEnabled', 'settingsSyncEnabled', 'settingsSyncAccountId', 'explicitSettings',
      'trustedSenders', 'preferredIdentityIds', 'sharedCalendarColors', 'emailNotificationsEnabled', 'debugMode',
    ]) {
      expect(stored).not.toContain(local);
    }
    // Defaults nobody chose stay out of the account.
    expect(stored).not.toContain('showPreview');
    expect(Object.keys(server.metadata).every((namespace) => namespace.startsWith('org.bulwarkmail.settings.'))).toBe(true);
  });

  it('gives way to the account where both chose, says so, and can take it back', async () => {
    useSettingsStore.setState({ density: 'compact', explicitSettings: ['density'] });
    otherDeviceSets('density', { v: 'comfortable', at: UNKNOWN_AGE });

    await settle();

    expect(settings().density).toBe('comfortable');
    expect(sync().replaced).toEqual({ density: 'compact' });
    await vi.dynamicImportSettled();
    expect(useToastStore.getState().toasts).toHaveLength(1);

    vi.setSystemTime(new Date('2026-11-13T12:05:00Z'));
    sync().keepReplaced();
    await settle();

    expect(settings().density).toBe('compact');
    expect(sync().replaced).toBeNull();
    expect(plain('density')).toEqual({ v: 'compact', at: Date.parse('2026-11-13T12:05:00Z') });
  });

  it('keeps the offer across a restart of the app, until it is taken or closed', async () => {
    useSettingsStore.setState({ density: 'compact', explicitSettings: ['density'] });
    otherDeviceSets('density', { v: 'comfortable', at: UNKNOWN_AGE });
    await settle();
    expect(sync().replaced).toEqual({ density: 'compact' });

    // The toast was missed and Android stopped the app.
    stop();
    resetSettingsSyncForTests();
    stop = startSettingsSync();
    await settle();
    expect(sync().replaced).toEqual({ density: 'compact' });

    sync().dismissReplaced();
    stop();
    resetSettingsSyncForTests();
    stop = startSettingsSync();
    await settle();
    expect(sync().replaced).toBeNull();
    expect(settings().density).toBe('comfortable');
  });

  it('notes the first account as the one that holds the settings', async () => {
    await settle();
    expect(settings().settingsSyncAccountId).toBe('first');
    expect(sync().accountId).toBe('first');
    // The note is not a setting change to send, and starts no round of its own.
    const requests = server.requests;
    await vi.advanceTimersByTimeAsync(5000);
    expect(server.requests).toBe(requests);
  });
});

describe('a change made on this device', () => {
  beforeEach(settle);

  it('goes to the account shortly after, as one member of its shard', async () => {
    settings().updateSetting('showPreview', false);
    expect(server.patches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1400);
    expect(server.patches).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);

    const now = Date.parse('2026-11-13T12:00:00Z');
    expect(plain('showPreview')).toMatchObject({ v: false });
    expect((plain('showPreview') as { at: number }).at).toBeGreaterThanOrEqual(now);

    // The shard exists now: the next change patches its member alone.
    server.patches = [];
    otherDeviceSets('anotherClientsSetting', { v: 1, at: 5 });
    const shard = shardKey(shardOf('showPreview'));
    server.put(shard, { ...server.entry(shard), neighbour: { v: 'kept', at: 7 } });
    settings().updateSetting('showPreview', true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.patches).toHaveLength(1);
    expect(Object.keys(server.patches[0])).toEqual([`privateMetadata/org.bulwarkmail.${shard}/showPreview`]);
    expect(server.entry(shard)?.neighbour).toEqual({ v: 'kept', at: 7 });
    expect(plain('anotherClientsSetting')).toEqual({ v: 1, at: 5 });
  });

  it('sends a burst of changes in one update', async () => {
    settings().updateSetting('showPreview', false);
    settings().updateSetting('density', 'compact');
    settings().updateSetting('timeFormat', '12h');
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.patches).toHaveLength(1);
    expect(plain('density')).toMatchObject({ v: 'compact' });
    expect(plain('timeFormat')).toMatchObject({ v: '12h' });
  });

  it('sends lists and maps to entries of their own', async () => {
    settings().setAttachmentReminderKeywords(['invoice', 'attached']);
    settings().addSidebarApp({ name: 'Docs', url: 'https://docs.example.org', icon: 'file' } as never);
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.entry('settings.value.attachment-reminder-keywords'))
      .toMatchObject({ k: 'attachmentReminderKeywords', v: ['invoice', 'attached'] });
    expect((server.entry('settings.value.sidebar-apps')?.v as unknown[])).toHaveLength(1);
  });

  it('sends a setting under the webmail name', async () => {
    settings().updateSetting('calendarShowWeekNumbers', true);
    settings().updateSetting('filtersExpandedView', true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(plain('showWeekNumbers')).toMatchObject({ v: true });
    expect(plain('expandedFilterView')).toMatchObject({ v: true });
    expect(JSON.stringify(server.metadata)).not.toContain('calendarShowWeekNumbers');
  });

  it('does not send a device setting, nor start a round for one', async () => {
    const requests = server.requests;
    settings().updateSetting('swipeMode', 'reveal');
    settings().updateSetting('readingPane', 'off');
    await vi.advanceTimersByTimeAsync(5000);
    expect(server.requests).toBe(requests);
  });

  it('keeps notifications, trusted senders and what belongs to the accounts here on this device', async () => {
    const requests = server.requests;
    settings().updateSetting('emailNotificationsEnabled', false);
    settings().updateSetting('calendarNotificationsEnabled', false);
    settings().updateSetting('pushNotifyInboxOnly', true);
    settings().updateSetting('appIconUnreadBadge', false);
    settings().updateSetting('debugMode', true);
    settings().updateSetting('preferredIdentityIds', { a: 'id-1' });
    settings().setSharedCalendarColor('cal-1', '#ff0000');
    settings().addTrustedSender('ada@example.org');
    settings().updateSetting('messageListOrderScope', 'all');
    await settings().forgetPreferredIdentities(['a']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(server.requests).toBe(requests);
    // Nor does a round take them from an account that has them (an older build's, another client's).
    otherDeviceSets('emailNotificationsEnabled', { v: true, at: Date.now() + 1000 });
    server.put('settings.value.trusted-senders', { k: 'trustedSenders', v: ['eve@example.org'], at: Date.now() + 1000 });
    await settle();
    expect(settings().emailNotificationsEnabled).toBe(false);
    expect(settings().trustedSenders).toEqual(['ada@example.org']);
    expect(settings().preferredIdentityIds).toEqual({});
  });

  it('stamps a change made before the stamps were read from storage', async () => {
    stop();
    resetSettingsSyncForTests();
    await AsyncStorage.setItem('settings-sync:v1', JSON.stringify({ holder: 'first', stamps: { showPreview: 5 }, resets: {} }));
    stop = startSettingsSync();
    settings().updateSetting('density', 'compact');
    await vi.advanceTimersByTimeAsync(2000);
    expect(plain('density')).toMatchObject({ v: 'compact' });
    expect(settingsSyncStampsForTests().showPreview).toBe(5);
  });

  it('sends an imported file as the choices it holds; what it names without a choice goes up as the default', async () => {
    settings().updateSetting('density', 'compact');
    await vi.advanceTimersByTimeAsync(2000);
    vi.setSystemTime(new Date('2026-11-13T12:10:00Z'));
    // A file from another install: one choice, and two settings at their default that it did not choose.
    settings().importSettings(JSON.stringify({
      showPreview: false, timeFormat: '24h', density: 'regular', explicitSettings: ['showPreview'],
    }));
    await vi.advanceTimersByTimeAsync(2000);
    const at = Date.parse('2026-11-13T12:10:00Z');
    expect(plain('showPreview')).toEqual({ v: false, at });
    expect(plain('timeFormat')).toEqual({ at });
    // Chosen on this device before: an import keeps that mark, so the imported value is a choice.
    expect(plain('density')).toEqual({ v: 'regular', at });
  });

  it('keeps an overlong text on this device and sends the other settings', async () => {
    settings().updateSetting('emailExportTemplate', 'x'.repeat(2000));
    settings().updateSetting('density', 'compact');
    await vi.advanceTimersByTimeAsync(2000);
    expect(plain('emailDownloadTemplate')).toBeUndefined();
    expect(plain('density')).toMatchObject({ v: 'compact' });
    expect(sync().tooLarge).toEqual(['emailExportTemplate']);
    expect(sync().status).toBe('synced');
  });

  it('wins over the value it replaces even when that came from a device with a fast clock', async () => {
    const future = Date.parse('2027-06-01T00:00:00Z');
    otherDeviceSets('density', { v: 'comfortable', at: future });
    await settle();
    expect(settings().density).toBe('comfortable');

    settings().updateSetting('density', 'compact');
    await vi.advanceTimersByTimeAsync(2000);
    expect(plain('density')).toEqual({ v: 'compact', at: future + 1 });
  });

  it('sends a change made while a round was writing in a round after it', async () => {
    settings().updateSetting('showPreview', false);
    let changed = false;
    server.beforeRequest = (calls) => {
      if (changed || calls[0][0] !== 'Mailbox/set') return;
      changed = true;
      // The round planned its writes before this.
      settings().updateSetting('density', 'compact');
    };
    await sync().syncNow();
    expect(plain('showPreview')).toMatchObject({ v: false });
    expect(plain('density')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    expect(plain('density')).toMatchObject({ v: 'compact' });
  });
});

describe('a change made on another device', () => {
  beforeEach(settle);

  it('replaces an older value here and leaves a newer one, which is sent back', async () => {
    settings().updateSetting('density', 'compact');
    settings().updateSetting('timeFormat', '12h');
    await vi.advanceTimersByTimeAsync(2000);
    const mine = (plain('timeFormat') as { at: number }).at;

    otherDeviceSets('density', { v: 'comfortable', at: mine + 60_000 });
    otherDeviceSets('timeFormat', { v: '24h', at: mine - 60_000 });
    await settle();

    expect(settings().density).toBe('comfortable');
    expect(settings().timeFormat).toBe('12h');
    expect(plain('timeFormat')).toEqual({ v: '12h', at: mine });
  });

  it('arrives when the mailboxes of the account change, not more than once in thirty seconds', async () => {
    const { dispatchStateChange } = await import('../../lib/state-change-bus');
    await vi.advanceTimersByTimeAsync(60_000);
    otherDeviceSets('density', { v: 'compact', at: Date.now() });
    dispatchStateChange({ changed: { acct: { Mailbox: 's2' } } } as never);
    await vi.advanceTimersByTimeAsync(2000);
    expect(settings().density).toBe('compact');

    // New mail changes the mailboxes too: no round for each message.
    const requests = server.requests;
    for (let i = 0; i < 5; i++) dispatchStateChange({ changed: { acct: { Mailbox: `s${3 + i}` } } } as never);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(server.requests).toBe(requests);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(server.requests).toBe(requests + 1);

    // Another account's mailboxes are not this one's business.
    dispatchStateChange({ changed: { other: { Mailbox: 's9' } } } as never);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.requests).toBe(requests + 1);
  });

  it('is not applied when this version does not know the value, and is not written over', async () => {
    otherDeviceSets('density', { v: 'spacious', at: Date.now() + 1000 });
    otherDeviceSets('emailsPerPage', { v: 'many', at: Date.now() + 1000 });
    otherDeviceSets('showPreview', { v: null, at: Date.now() + 1000 });
    await settle();
    expect(settings().density).toBe('regular');
    expect(settings().emailsPerPage).toBe(25);
    expect(settings().showPreview).toBe(true);
    expect(plain('density')).toMatchObject({ v: 'spacious' });
    expect(server.patches).toEqual([]);
  });

  it('takes "no theme" as a value', async () => {
    settings().updateSetting('activeThemeId', 'builtin-nord');
    await vi.advanceTimersByTimeAsync(2000);
    otherDeviceSets('activeThemeId', { v: null, at: Date.now() + 1000 });
    await settle();
    expect(settings().activeThemeId).toBeNull();
  });

  it('leaves the entries of other features and unknown settings alone', async () => {
    server.put('template.abc', { name: 'A template' });
    server.put('templates', { version: 1, deleted: {} });
    otherDeviceSets('aSettingOfTheWebmail', { v: 'x', at: 5 });
    settings().updateSetting('density', 'compact');
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.entry('template.abc')).toEqual({ name: 'A template' });
    expect(server.entry('templates')).toEqual({ version: 1, deleted: {} });
    expect(plain('aSettingOfTheWebmail')).toEqual({ v: 'x', at: 5 });
  });
});

describe('reset to defaults', () => {
  beforeEach(settle);

  it('reaches the other devices, and leaves sync as it was', async () => {
    settings().updateSetting('density', 'compact');
    settings().setAttachmentReminderKeywords(['invoice']);
    await vi.advanceTimersByTimeAsync(2000);

    vi.setSystemTime(new Date('2026-11-13T13:00:00Z'));
    settings().resetToDefaults();
    await vi.advanceTimersByTimeAsync(2000);

    const at = Date.parse('2026-11-13T13:00:00Z');
    expect(plain('density')).toEqual({ at });
    expect(server.entry('settings.value.attachment-reminder-keywords')).toEqual({ k: 'attachmentReminderKeywords', at });
    expect(settings().settingsSyncEnabled).toBe(true);
    expect(settings().settingsSyncAccountId).toBe('first');
  });

  it('made on another device puts the setting back here and no longer counts it as chosen', async () => {
    settings().updateSetting('density', 'compact');
    settings().setAttachmentReminderKeywords(['invoice']);
    await vi.advanceTimersByTimeAsync(2000);

    otherDeviceSets('density', { at: Date.now() + 5000 });
    server.put('settings.value.attachment-reminder-keywords', { k: 'attachmentReminderKeywords', at: Date.now() + 5000 });
    await settle();

    expect(settings().density).toBe('regular');
    expect(settings().attachmentReminderKeywords).toEqual(DEFAULT_PERSISTED.attachmentReminderKeywords);
    expect(settings().explicitSettings).not.toContain('density');
    expect(server.patches.filter((patch) => JSON.stringify(patch).includes('attachmentReminderKeywords'))).toHaveLength(1);
  });

  it('made on a device that keeps its settings to itself stays there, also once sync is on again', async () => {
    settings().updateSetting('density', 'compact');
    await vi.advanceTimersByTimeAsync(2000);
    const stored = structuredClone(plain('density'));

    settings().updateSetting('settingsSyncEnabled', false);
    vi.setSystemTime(new Date('2026-12-24T12:00:00Z'));
    settings().resetToDefaults();
    expect(settings().settingsSyncEnabled).toBe(false);
    expect(settings().density).toBe('regular');

    settings().updateSetting('settingsSyncEnabled', true);
    await vi.advanceTimersByTimeAsync(100);
    // The account keeps its value, and this device has it back.
    expect(plain('density')).toEqual(stored);
    expect(settings().density).toBe('compact');
  });
});

describe('the organisation policy', () => {
  beforeEach(settle);

  it('keeps a pinned setting out of both directions', async () => {
    settings().applyPolicyRules({ ...EMPTY_SETTINGS_RULES, locks: { density: 'compact' } });
    otherDeviceSets('density', { v: 'comfortable', at: Date.now() + 1000 });
    await settle();
    expect(settings().density).toBe('compact');
    expect(plain('density')).toEqual({ v: 'comfortable', at: expect.any(Number) });
    expect(server.patches).toEqual([]);

    // Released: the value of the other device comes in.
    settings().applyPolicyRules(EMPTY_SETTINGS_RULES);
    await settle();
    expect(settings().density).toBe('comfortable');
  });

  it('does not send the defaults an organisation sets', async () => {
    settings().applyPolicyRules({ ...EMPTY_SETTINGS_RULES, defaults: { density: 'compact' } });
    await settle();
    expect(settings().density).toBe('compact');
    expect(JSON.stringify(server.metadata)).not.toContain('density');
  });

  it('does not take a value the organisation does not allow here', async () => {
    settings().applyPolicyRules({ ...EMPTY_SETTINGS_RULES, blocked: { activeThemeId: ['builtin-nord'] } });
    otherDeviceSets('activeThemeId', { v: 'builtin-nord', at: Date.now() + 1000 });
    await settle();
    expect(settings().activeThemeId).toBeNull();
  });
});

describe('what the account cannot hold', () => {
  beforeEach(settle);

  it('keeps a list over 8 KB on this device, says so, and syncs the rest', async () => {
    settings().setAttachmentReminderKeywords(Array.from({ length: 400 }, (_, i) => `a keyword to look for, number ${i}`));
    settings().updateSetting('density', 'compact');
    await vi.advanceTimersByTimeAsync(2000);

    expect(server.entry('settings.value.attachment-reminder-keywords')).toBeUndefined();
    expect(plain('density')).toMatchObject({ v: 'compact' });
    expect(sync().tooLarge).toEqual(['attachmentReminderKeywords']);
    expect(sync().status).toBe('synced');

    // Not offered again until it changes.
    const patches = server.patches.length;
    await sync().syncNow();
    expect(server.patches).toHaveLength(patches);

    settings().setAttachmentReminderKeywords(['invoice']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.entry('settings.value.attachment-reminder-keywords')).toMatchObject({ v: ['invoice'] });
    expect(sync().tooLarge).toEqual([]);
  });

  it('says the account is full when its metadata has no room', async () => {
    // Something else of the user's fills the 16 KB their private metadata may hold.
    for (let i = 0; i < 2; i++) server.put(`other.filler${i}`, { body: 'x'.repeat(8160) });
    settings().updateSetting('density', 'compact');
    await vi.advanceTimersByTimeAsync(2000);
    expect(sync().status).toBe('full');
    expect(settings().density).toBe('compact');

    // Room again: the change is still waiting and goes out.
    for (let i = 0; i < 2; i++) server.put(`other.filler${i}`, null);
    await sync().syncNow();
    expect(sync().status).toBe('synced');
    expect(plain('density')).toMatchObject({ v: 'compact' });
  });
});

describe('where there is nothing to sync with', () => {
  it('does nothing on a server that keeps no private metadata', async () => {
    server.privateSupported = false;
    setSettingsSyncClientFactory(() => new FakeSyncClient() as unknown as JMAPClient);
    const requests = server.requests;
    settings().updateSetting('density', 'compact');
    await settle();
    expect(sync().status).toBe('unsupported');
    expect(server.requests).toBe(requests);
  });

  it('does not make an account the holder before its server has answered', async () => {
    stop();
    resetSettingsSyncForTests();
    useSettingsStore.setState({ settingsSyncAccountId: null });
    server.supported = false;
    setSettingsSyncClientFactory(() => new FakeSyncClient() as unknown as JMAPClient);
    stop = startSettingsSync();
    await settle();
    expect(sync().status).toBe('unsupported');
    expect(settings().settingsSyncAccountId).toBeNull();
  });

  it('keeps out of the shared metadata, where the templates are', async () => {
    server.shared = { 'org.bulwarkmail.template.abc': { name: 'A template' } };
    settings().updateSetting('density', 'compact');
    settings().addSidebarApp({ name: 'Docs', url: 'https://docs.example.org', icon: 'file' } as never);
    await settle();
    expect(server.shared).toEqual({ 'org.bulwarkmail.template.abc': { name: 'A template' } });
    expect(server.patches.flatMap((patch) => Object.keys(patch)).every((path) => path.startsWith('privateMetadata/'))).toBe(true);
  });

  it('does nothing on a server without metadata', async () => {
    server.supported = false;
    // A new client: the session it reads says what the server can do.
    setSettingsSyncClientFactory(() => new FakeSyncClient() as unknown as JMAPClient);
    const requests = server.requests;
    settings().updateSetting('density', 'compact');
    await settle();
    expect(sync().status).toBe('unsupported');
    expect(server.requests).toBe(requests);
  });

  it('waits while the server cannot be reached, and sends the change once it can', async () => {
    FakeSyncClient.loadError = new NetworkError('offline');
    setSettingsSyncClientFactory(() => new FakeSyncClient() as unknown as JMAPClient);
    settings().updateSetting('density', 'compact');
    await settle();
    expect(sync().status).toBe('unreachable');

    FakeSyncClient.loadError = null;
    useNetworkStore.setState({ online: false });
    useNetworkStore.setState({ online: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(sync().status).toBe('synced');
    expect(plain('density')).toMatchObject({ v: 'compact' });
  });

  it('makes no request while the device is offline', async () => {
    useNetworkStore.setState({ online: false });
    const requests = server.requests;
    FakeSyncClient.loads = [];
    settings().updateSetting('density', 'compact');
    await settle();
    expect(sync().status).toBe('unreachable');
    expect(FakeSyncClient.loads).toEqual([]);
    expect(server.requests).toBe(requests);
  });

  it('reports a failed write and sends it in a later round', async () => {
    await settle();
    server.beforeRequest = (calls) => {
      if (calls[0][0] === 'Mailbox/set') throw new NetworkError('connection lost');
    };
    settings().updateSetting('density', 'compact');
    await vi.advanceTimersByTimeAsync(2000);
    expect(sync().status).toBe('unreachable');

    server.beforeRequest = null;
    await sync().syncNow();
    expect(sync().status).toBe('synced');
    expect(plain('density')).toMatchObject({ v: 'compact' });
  });

  it('does nothing while switched off; switched on, this device meets the account as a new one would', async () => {
    await settle();
    settings().updateSetting('showPreview', false);
    await vi.advanceTimersByTimeAsync(2000);

    settings().updateSetting('settingsSyncEnabled', false);
    const requests = server.requests;
    settings().updateSetting('density', 'compact');       // the account has none
    settings().updateSetting('showPreview', true);         // the account has the older false
    otherDeviceSets('timeFormat', { v: '12h', at: Date.now() + 1000 });
    await settle();
    expect(server.requests).toBe(requests);
    expect(settings().timeFormat).toBe('24h');

    settings().updateSetting('settingsSyncEnabled', true);
    await vi.advanceTimersByTimeAsync(100);
    // What the account lacked is filled in; where it had a value, that one comes back, with the offer to keep this device's.
    expect(plain('density')).toEqual({ v: 'compact', at: UNKNOWN_AGE });
    expect(settings().timeFormat).toBe('12h');
    expect(settings().showPreview).toBe(false);
    expect(sync().replaced).toEqual({ showPreview: true });
  });

  it('waits for the organisation policy of the active account before the first round', async () => {
    stop();
    resetSettingsSyncForTests();
    usePolicyStore.setState({ accountId: null });
    const requests = server.requests;
    stop = startSettingsSync();
    settings().updateSetting('density', 'compact');
    await vi.advanceTimersByTimeAsync(5000);
    expect(server.requests).toBe(requests);

    usePolicyStore.setState({ accountId: 'first' });
    await vi.advanceTimersByTimeAsync(100);
    expect(plain('density')).toMatchObject({ v: 'compact' });
  });

  it('tries again by itself after a failed round, with the sign-in as it is then', async () => {
    await settle();
    FakeSyncClient.loads = [];
    server.beforeRequest = () => { throw new NetworkError('connection lost'); };
    settings().updateSetting('density', 'compact');
    await vi.advanceTimersByTimeAsync(2000);
    expect(sync().status).toBe('unreachable');

    server.beforeRequest = null;
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(sync().status).toBe('synced');
    expect(plain('density')).toMatchObject({ v: 'compact' });
    // A new client was opened: the old one may hold a password that was changed since.
    expect(FakeSyncClient.loads).toEqual(['first']);
  });

  it('does not sit out the pause after a failure when asked to sync now', async () => {
    await settle();
    let fail = true;
    server.beforeRequest = () => { if (fail) throw new NetworkError('connection lost'); };
    settings().updateSetting('density', 'compact');
    await vi.advanceTimersByTimeAsync(2000);
    expect(sync().status).toBe('unreachable');
    fail = false;
    await sync().syncNow();
    expect(sync().status).toBe('synced');
  });
});

describe('several accounts', () => {
  let second: FakeMetadataServer;
  beforeEach(async () => {
    second = new FakeMetadataServer('acct2');
    FakeSyncClient.servers = { first: server, second };
    useAccountStore.setState({ accounts: [account('first'), account('second')], activeAccountId: 'second' });
    usePolicyStore.setState({ accountId: 'second' });
    await settle();
  });

  it('syncs with the first account whichever one is active, through a client of its own', async () => {
    const live = vi.spyOn(jmapClient, 'request');
    settings().updateSetting('density', 'compact');
    await vi.advanceTimersByTimeAsync(2000);
    expect(plain('density')).toMatchObject({ v: 'compact' });
    expect(second.requests).toBe(0);
    expect(live).not.toHaveBeenCalled();
    expect(FakeSyncClient.loads).toEqual(['first']);
  });

  it('keeps to that account when the list is put in another order', async () => {
    useAccountStore.setState({ accounts: [account('second'), account('first')] });
    settings().updateSetting('density', 'compact');
    await vi.advanceTimersByTimeAsync(2000);
    expect(plain('density')).toMatchObject({ v: 'compact' });
    expect(second.requests).toBe(0);
  });

  it('moves to the account picked in settings, with the settings of this device', async () => {
    settings().updateSetting('density', 'compact');
    await vi.advanceTimersByTimeAsync(2000);
    second.put(shardKey(shardOf('timeFormat')), { timeFormat: { v: '12h', at: Date.now() + 1000 } });

    settings().updateSetting('settingsSyncAccountId', 'second');
    await vi.advanceTimersByTimeAsync(100);

    expect(sync().accountId).toBe('second');
    expect(sync().status).toBe('synced');
    expect(settings().timeFormat).toBe('12h');
    // The second account's copy has a history of its own: this device's choice fills its gap as one of unknown age.
    expect((second.entry(shardKey(shardOf('density'))) as Record<string, unknown>).density).toEqual({ v: 'compact', at: UNKNOWN_AGE });
    expect(plain('density')).toMatchObject({ v: 'compact' });
  });

  it('waits to be told when the account that held the settings signs out, and resumes when it is back', async () => {
    settings().updateSetting('density', 'compact');
    await vi.advanceTimersByTimeAsync(2000);

    useAccountStore.setState({ accounts: [account('second')], activeAccountId: 'second' });
    settings().updateSetting('showPreview', false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sync().status).toBe('signed-out');
    expect(settings().settingsSyncAccountId).toBe('first');
    // Nothing of the first account's settings goes into the second one's mailbox.
    expect(second.requests).toBe(0);

    useAccountStore.setState({ accounts: [account('second'), account('first')] });
    await vi.advanceTimersByTimeAsync(100);
    expect(sync().status).toBe('synced');
    expect(sync().accountId).toBe('first');
    expect(plain('showPreview')).toMatchObject({ v: false });
    expect(second.requests).toBe(0);
  });

  it('knows the holder again when it signs back in under another id', async () => {
    // An account signed in before ports were part of the id keeps its old one
    // until it signs out; signed in again it gets the id with the port.
    settings().updateSetting('density', 'compact');
    await vi.advanceTimersByTimeAsync(2000);
    const stamp = settingsSyncStampsForTests().density;

    useAccountStore.setState({ accounts: [account('second')], activeAccountId: 'second' });
    await vi.advanceTimersByTimeAsync(100);
    expect(sync().status).toBe('signed-out');

    FakeSyncClient.servers = { 'first:8443': server, second };
    useAccountStore.setState({ accounts: [account('second'), { ...account('first'), id: 'first:8443' }] });
    await vi.advanceTimersByTimeAsync(100);
    expect(sync().status).toBe('synced');
    expect(settings().settingsSyncAccountId).toBe('first:8443');
    // What this device knew of the account's copy still counts.
    expect(settingsSyncStampsForTests().density).toBe(stamp);
    expect(second.requests).toBe(0);

    // Another login that only shares the user name is not the holder.
    useAccountStore.setState({ accounts: [account('second'), { ...account('first'), id: 'x', serverUrl: 'https://elsewhere.example.org' }] });
    await vi.advanceTimersByTimeAsync(100);
    expect(sync().status).toBe('signed-out');
  });

  it('does not hand the settings of a signed-out user to the next account signed in', async () => {
    settings().updateSetting('density', 'compact');
    await vi.advanceTimersByTimeAsync(2000);
    stop();
    useAccountStore.setState({ accounts: [], activeAccountId: null });
    useAccountStore.setState({ accounts: [account('second')], activeAccountId: 'second' });
    stop = startSettingsSync();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sync().status).toBe('signed-out');
    expect(second.requests).toBe(0);
  });

  it('stops writing when the account is changed in the middle of a round', async () => {
    settings().updateSetting('density', 'compact');
    settings().addSidebarApp({ name: 'Docs', url: 'https://docs.example.org', icon: 'file' } as never);
    let switched = false;
    server.beforeRequest = (calls) => {
      if (calls[0][0] !== 'Mailbox/set' || switched) return;
      switched = true;
      useSettingsStore.setState({ settingsSyncAccountId: 'second' });
    };
    await sync().syncNow();
    // The update under way went through; the next one of that round did not.
    expect(server.patches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect((second.entry('settings.value.sidebar-apps')?.v as unknown[])).toHaveLength(1);
  });
});
