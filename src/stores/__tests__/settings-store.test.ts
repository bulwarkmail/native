import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../api/identity', () => ({ getIdentities: vi.fn(async () => []) }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  useSettingsStore,
  discardSettingsEditsForTests,
  mergeWithDefaults,
  toExportShape,
  fromExportShape,
} from '../settings-store';

describe('settings-store', () => {
  beforeEach(async () => {
    // A failed read left by an earlier test would hold every write back.
    discardSettingsEditsForTests();
    useSettingsStore.setState({ settingsReadFailed: false, legacyCalendarColorNonReaders: [], legacyCalendarColorNonReadersReadFailed: false });
    await AsyncStorage.clear();
    useSettingsStore.getState().resetToDefaults();
  });

  describe('Files storage notice', () => {
    it('is not dismissed by default', () => {
      expect(useSettingsStore.getState().filesStabilityNoticeDismissed).toBe(false);
    });

    it('persists a dismissal and reads it back', () => {
      useSettingsStore.getState().updateSetting('filesStabilityNoticeDismissed', true);
      expect(useSettingsStore.getState().filesStabilityNoticeDismissed).toBe(true);
      expect(mergeWithDefaults({ filesStabilityNoticeDismissed: true }).filesStabilityNoticeDismissed).toBe(true);
    });

    it('falls back to not dismissed for a non-boolean value', () => {
      expect(mergeWithDefaults({ filesStabilityNoticeDismissed: 'yes' as never }).filesStabilityNoticeDismissed).toBe(false);
    });

    it('is app-only: never exported or imported', () => {
      expect('filesStabilityNoticeDismissed' in toExportShape(useSettingsStore.getState())).toBe(false);
      expect(fromExportShape({ filesStabilityNoticeDismissed: true })).toEqual({});
    });
  });

  describe('screen protection', () => {
    it('is off by default', () => {
      const s = useSettingsStore.getState();
      expect(s.blockScreenshots).toBe(false);
      expect(s.hideInRecents).toBe(false);
    });

    it('persists both toggles and reads them back', async () => {
      useSettingsStore.getState().updateSetting('blockScreenshots', true);
      useSettingsStore.getState().updateSetting('hideInRecents', true);
      const writes = vi.mocked(AsyncStorage.setItem).mock.calls.filter(([k]) => k === 'webmail:settings:v1');
      const stored = JSON.parse(writes[writes.length - 1][1]);
      const merged = mergeWithDefaults(stored);
      expect(merged.blockScreenshots).toBe(true);
      expect(merged.hideInRecents).toBe(true);
    });

    it('falls back to off for a non-boolean value', () => {
      const merged = mergeWithDefaults({ blockScreenshots: 'yes' as never, hideInRecents: 1 as never });
      expect(merged.blockScreenshots).toBe(false);
      expect(merged.hideInRecents).toBe(false);
    });

    it('is app-only: never exported or imported', () => {
      const shape = toExportShape(useSettingsStore.getState());
      expect('blockScreenshots' in shape).toBe(false);
      expect('hideInRecents' in shape).toBe(false);
      expect(fromExportShape({ blockScreenshots: true, hideInRecents: true })).toEqual({});
    });
  });

  describe('calendar working hours and days (#1164)', () => {
    it('defaults to limiting the view to 08:00-20:00 on weekdays', () => {
      const s = useSettingsStore.getState();
      expect(s.calendarLimitHours).toBe(true);
      expect(s.calendarDayStartHour).toBe(8);
      expect(s.calendarDayEndHour).toBe(20);
      expect(s.calendarHideNonWorkingDays).toBe(false);
      expect(s.calendarWorkingDays).toEqual([1, 2, 3, 4, 5]);
    });

    it('falls back to the defaults for an invalid persisted pair or day list', () => {
      const merged = mergeWithDefaults({
        calendarDayStartHour: 22, calendarDayEndHour: 6, calendarWorkingDays: [],
      } as never);
      expect(merged).toMatchObject({
        calendarDayStartHour: 8, calendarDayEndHour: 20, calendarWorkingDays: [1, 2, 3, 4, 5],
      });
      const ok = mergeWithDefaults({ calendarDayStartHour: 6, calendarDayEndHour: 18, calendarWorkingDays: [0, 6] } as never);
      expect(ok).toMatchObject({ calendarDayStartHour: 6, calendarDayEndHour: 18, calendarWorkingDays: [0, 6] });
    });

    it('rejects out-of-range hours and duplicate or out-of-range days', () => {
      expect(mergeWithDefaults({ calendarDayStartHour: 24, calendarDayEndHour: 24 } as never))
        .toMatchObject({ calendarDayStartHour: 8, calendarDayEndHour: 20 });
      expect(mergeWithDefaults({ calendarDayStartHour: 0, calendarDayEndHour: 0 } as never))
        .toMatchObject({ calendarDayStartHour: 8, calendarDayEndHour: 20 });
      expect(mergeWithDefaults({ calendarWorkingDays: [1, 1] } as never).calendarWorkingDays).toEqual([1, 2, 3, 4, 5]);
      expect(mergeWithDefaults({ calendarWorkingDays: [7] } as never).calendarWorkingDays).toEqual([1, 2, 3, 4, 5]);
    });

    it('falls back to both defaults when a lone persisted hour clashes with the other default', () => {
      expect(mergeWithDefaults({ calendarDayStartHour: 21 } as never)).toMatchObject({
        calendarDayStartHour: 8, calendarDayEndHour: 20,
      });
    });
  });

  describe('defaults', () => {
    it('match the webmail where behaviour is identical', () => {
      const s = useSettingsStore.getState();
      expect(s.includeGroupInUnified).toBe(true);
      expect(s.autoSelectReplyIdentity).toBe(false);
      expect(s.replyIdentityMatch).toBe('domain');
      expect(s.showBirthdayCalendar).toBe(false);
      expect(s.birthdayCalendarColor).toBe('#eab308');
      expect(s.attachmentReminderKeywords).toContain('anhang');
      expect(s.attachmentReminderKeywords).toContain('添付');
    });
  });

  describe('mergeWithDefaults', () => {
    it('keeps a valid birthday calendar colour and drops anything else', () => {
      expect(mergeWithDefaults({ birthdayCalendarColor: '#3B82F6' }).birthdayCalendarColor).toBe('#3B82F6');
      for (const bad of ['blue', '#12', 'url(x)', '#12345g', 5]) {
        expect(mergeWithDefaults({ birthdayCalendarColor: bad as never }).birthdayCalendarColor).toBe('#eab308');
      }
    });

    it('rejects values outside the allowed set', () => {
      const out = mergeWithDefaults({
        density: 'x' as never,
        swipeLeftAction: 'foo' as never,
        sendDelaySeconds: 17,
        emailsPerPage: -4,
        theme: 'dark',
      });
      expect(out.density).toBe('regular');
      expect(out.swipeLeftAction).toBe('archive');
      expect(out.sendDelaySeconds).toBe(0);
      expect(out.emailsPerPage).toBe(25);
      expect(out.theme).toBe('dark');
    });

    it('keeps valid values and normalises the quick-action bar', () => {
      const out = mergeWithDefaults({
        sendDelaySeconds: 30,
        bottomQuickActions: ['delete', 'delete', 'bogus' as never],
      });
      expect(out.sendDelaySeconds).toBe(30);
      expect(out.bottomQuickActions).toEqual(['delete', 'reply', 'replyAll']);
    });

    it('accepts only the known reply identity match modes', () => {
      expect(mergeWithDefaults({ replyIdentityMatch: 'exact' }).replyIdentityMatch).toBe('exact');
      expect(mergeWithDefaults({ replyIdentityMatch: 'loose' as never }).replyIdentityMatch).toBe('domain');
    });

    it('fills missing debug categories from the default', () => {
      const out = mergeWithDefaults({ debugCategories: { push: false } as never });
      expect(out.debugCategories.push).toBe(false);
      expect(out.debugCategories.jmap).toBe(true);
    });
  });

  describe('trusted senders', () => {
    it('strips a display name in angle form', () => {
      const s = useSettingsStore.getState();
      s.addTrustedSender('Alice Example <Alice@Example.com>');
      expect(useSettingsStore.getState().trustedSenders).toEqual(['alice@example.com']);
      expect(useSettingsStore.getState().isSenderTrusted('alice@example.com')).toBe(true);
      expect(useSettingsStore.getState().isSenderTrusted('"Alice" <ALICE@example.com>')).toBe(true);
      useSettingsStore.getState().removeTrustedSender('Alice <alice@example.com>');
      expect(useSettingsStore.getState().trustedSenders).toEqual([]);
    });
  });

  describe('export / import', () => {
    it('renames keys to the webmail names and drops device-local keys', () => {
      const shape = toExportShape({
        ...useSettingsStore.getState(),
        calendarFirstDayOfWeek: 0,
        emailExportTemplate: 'x',
        swipeMode: 'reveal',
      } as never);
      expect(shape.firstDayOfWeek).toBe(0);
      expect(shape.emailDownloadTemplate).toBe('x');
      expect(shape).not.toHaveProperty('calendarFirstDayOfWeek');
      expect(shape).not.toHaveProperty('swipeMode');
      expect(shape).not.toHaveProperty('offlineCacheDays');
    });

    it('imports a webmail export, ignoring unknown and invalid keys', () => {
      const ok = useSettingsStore.getState().importSettings(JSON.stringify({
        firstDayOfWeek: 0,
        density: 'compact',
        sendDelaySeconds: 99,
        messageListOrder: [{ property: 'receivedAt' }],
        swipeMode: 'reveal',
        unknownKey: 'whatever',
      }));
      expect(ok).toBe(true);
      const s = useSettingsStore.getState();
      expect(s.calendarFirstDayOfWeek).toBe(0);
      expect(s.density).toBe('compact');
      expect(s.sendDelaySeconds).toBe(0);
      expect(s.swipeMode).toBe('instant');
    });

    // Per-account keys name the app account (user@server): only the shown
    // account's go in the file, in the shape webmail reads.
    it('exports the shown account\'s shared calendar colours under the old key, and no other account\'s', () => {
      const set = useSettingsStore.getState().setSharedCalendarColor;
      set('a@one.example|team|c1', '#000001');
      set('b@two.example|team|c2', '#000002');
      set('team|c3', '#000003');
      const exported = JSON.parse(useSettingsStore.getState().exportSettings('a@one.example'));
      expect(exported.sharedCalendarColors).toEqual({ 'team|c1': '#000001', 'team|c3': '#000003' });
      // The stored overrides themselves are untouched.
      expect(Object.keys(useSettingsStore.getState().sharedCalendarColors)).toHaveLength(3);
      // No account shown: no colour at all (the old keys may be anyone's).
      expect(JSON.parse(useSettingsStore.getState().exportSettings()).sharedCalendarColors).toEqual({});
    });

    it('exports the old keys only while the shown account may still read them', () => {
      const s = useSettingsStore.getState();
      s.setSharedCalendarColor('a@one.example|team|c1', '#000001');
      s.setSharedCalendarColor('team|c3', '#000003');
      s.seedLegacyCalendarColorReaders(['b@two.example']);
      expect(JSON.parse(s.exportSettings('a@one.example')).sharedCalendarColors).toEqual({ 'team|c1': '#000001' });
      expect(JSON.parse(s.exportSettings('b@two.example')).sharedCalendarColors).toEqual({ 'team|c3': '#000003' });
    });

    it('round-trips through exportSettings', () => {
      useSettingsStore.getState().updateSetting('fontSize', 'large');
      const json = useSettingsStore.getState().exportSettings();
      useSettingsStore.getState().resetToDefaults();
      expect(useSettingsStore.getState().fontSize).toBe('medium');
      expect(useSettingsStore.getState().importSettings(json)).toBe(true);
      expect(useSettingsStore.getState().fontSize).toBe('large');
    });

    it('defaults colorfulSidebarIcons to true and round-trips it through export/import', () => {
      expect(useSettingsStore.getState().colorfulSidebarIcons).toBe(true);
      useSettingsStore.getState().updateSetting('colorfulSidebarIcons', false);
      const json = useSettingsStore.getState().exportSettings();
      expect(JSON.parse(json)).toHaveProperty('colorfulSidebarIcons', false);
      useSettingsStore.getState().resetToDefaults();
      expect(useSettingsStore.getState().colorfulSidebarIcons).toBe(true);
      expect(useSettingsStore.getState().importSettings(json)).toBe(true);
      expect(useSettingsStore.getState().colorfulSidebarIcons).toBe(false);
      expect(mergeWithDefaults({ colorfulSidebarIcons: 'no' } as never).colorfulSidebarIcons).toBe(true);
    });

    it('imports a Saturday first day of week', () => {
      expect(useSettingsStore.getState().importSettings(JSON.stringify({ firstDayOfWeek: 6 }))).toBe(true);
      expect(useSettingsStore.getState().calendarFirstDayOfWeek).toBe(6);
      useSettingsStore.getState().importSettings(JSON.stringify({ firstDayOfWeek: 3 }));
      expect(useSettingsStore.getState().calendarFirstDayOfWeek).toBe(1);
    });

    it('imports the valid sidebar apps and drops the rest', () => {
      const ok = { id: 'a', name: 'A', url: 'HTTPS://a.example/x', openMode: 'tab', showOnMobile: true };
      expect(useSettingsStore.getState().importSettings(JSON.stringify({
        sidebarApps: [
          ok,
          { ...ok, id: 'b', url: 'http://x.example' },
          { ...ok, id: 'c', url: 'https://a.example\\@b.example' },
          { ...ok, id: 'd', name: 7 },
        ],
        fontSize: 'large',
      }))).toBe(true);
      const s = useSettingsStore.getState();
      expect(s.sidebarApps.map((a) => a.id)).toEqual(['a']);
      expect(s.sidebarApps[0].url).toBe('https://a.example/x');
      // The rest of the file still imports.
      expect(s.fontSize).toBe('large');
    });

    it('rejects non-object JSON', () => {
      expect(useSettingsStore.getState().importSettings('[1,2]')).toBe(false);
      expect(useSettingsStore.getState().importSettings('not json')).toBe(false);
    });

    it('imports a file\'s colours for the shown account only, keeping other accounts\' colours', () => {
      const s = useSettingsStore.getState();
      s.setSharedCalendarColor('B|team|c1', '#222222');
      s.importSettings(JSON.stringify({ sharedCalendarColors: { 'team|c1': '#00ff00' } }), 'A');
      expect(useSettingsStore.getState().sharedCalendarColors).toEqual({ 'B|team|c1': '#222222', 'A|team|c1': '#00ff00' });
    });

    it('stores no colour from a file when no account is shown, and never an old key', () => {
      const s = useSettingsStore.getState();
      s.setSharedCalendarColor('B|team|c1', '#222222');
      expect(s.importSettings(JSON.stringify({ sharedCalendarColors: { 'team|c1': '#00ff00' }, fontSize: 'large' }))).toBe(true);
      expect(useSettingsStore.getState().sharedCalendarColors).toEqual({ 'B|team|c1': '#222222' });
      expect(useSettingsStore.getState().fontSize).toBe('large');
      // A file with no colours, or a malformed map, leaves them alone.
      s.importSettings(JSON.stringify({ sharedCalendarColors: 'x' }), 'A');
      s.importSettings(JSON.stringify({ sharedCalendarColors: { 'team|c2': 7 } }), 'A');
      expect(useSettingsStore.getState().sharedCalendarColors).toEqual({ 'B|team|c1': '#222222' });
    });

    it('never exports or imports the legacy readers list', () => {
      const s = useSettingsStore.getState();
      s.setSharedCalendarColor('team|c1', '#00ff00');
      s.seedLegacyCalendarColorReaders(['A']);
      expect(JSON.parse(s.exportSettings('A'))).not.toHaveProperty('legacyCalendarColorReaders');
      s.importSettings(JSON.stringify({ legacyCalendarColorReaders: ['A', 'C'] }), 'A');
      expect(useSettingsStore.getState().legacyCalendarColorReaders).toEqual(['A']);
    });

    it('fromExportShape maps webmail names back', () => {
      expect(fromExportShape({ expandedFilterView: true, filenameLowercase: true })).toEqual({
        filtersExpandedView: true,
        exportLowercase: true,
      });
    });
  });

  // The old colour key names no app account, so it may only be read by the
  // accounts registered at the upgrade, each until its first full load.
  describe('legacy shared calendar colours', () => {
    const get = () => useSettingsStore.getState();
    const KEY = 'webmail:settings:v1';

    it('lets only the accounts registered at the upgrade read legacy colours, then drops them', () => {
      const s = get();
      s.setSharedCalendarColor('team|c1', '#00ff00');
      s.seedLegacyCalendarColorReaders(['A', 'B']);
      s.seedLegacyCalendarColorReaders(['A', 'B', 'C']); // seeded once
      expect(get().legacyCalendarColorReaders).toEqual(['A', 'B']);
      s.finishLegacyCalendarColors('A', { 'A|team|c1': '#00ff00' });
      expect(get().sharedCalendarColors['team|c1']).toBe('#00ff00'); // B has not claimed yet
      expect(get().legacyCalendarColorReaders).toEqual(['B']);
      s.finishLegacyCalendarColors('B', {});
      expect(get().sharedCalendarColors).toEqual({ 'A|team|c1': '#00ff00' });
      expect(get().legacyCalendarColorReaders).toEqual([]);
    });

    it('seeds nobody when there is no legacy colour', () => {
      const s = get();
      s.setSharedCalendarColor('A|team|c1', '#00ff00');
      s.seedLegacyCalendarColorReaders(['A', 'B']);
      expect(get().legacyCalendarColorReaders).toEqual([]);
      // An account registered later is never seeded.
      s.setSharedCalendarColor('team|c1', '#00ff00');
      s.seedLegacyCalendarColorReaders(['A', 'B', 'C']);
      expect(get().legacyCalendarColorReaders).toEqual([]);
    });

    it('drops the legacy colours at once when no account is registered at the upgrade', () => {
      const s = get();
      s.setSharedCalendarColor('team|c1', '#00ff00');
      s.setSharedCalendarColor('A|team|c1', '#111111');
      s.seedLegacyCalendarColorReaders([]);
      expect(get().legacyCalendarColorReaders).toEqual([]);
      expect(get().sharedCalendarColors).toEqual({ 'A|team|c1': '#111111' });
    });

    it('persists the readers and the claim in one write', () => {
      const s = get();
      s.setSharedCalendarColor('team|c1', '#00ff00');
      s.seedLegacyCalendarColorReaders(['A']);
      const spy = vi.spyOn(AsyncStorage, 'setItem');
      const before = spy.mock.calls.length;
      s.finishLegacyCalendarColors('A', { 'A|team|c1': '#00ff00' });
      const writes = spy.mock.calls.slice(before).filter(([k]) => k === 'webmail:settings:v1');
      expect(writes).toHaveLength(1);
      const stored = JSON.parse(writes[0][1] as string);
      expect(stored.legacyCalendarColorReaders).toEqual([]);
      expect(stored.sharedCalendarColors).toEqual({ 'A|team|c1': '#00ff00' });
      // And they come back on the next start.
      expect(mergeWithDefaults(stored).legacyCalendarColorReaders).toEqual([]);
    });

    it('a finish for an account that is no reader changes nothing', () => {
      const s = get();
      s.setSharedCalendarColor('team|c1', '#00ff00');
      s.seedLegacyCalendarColorReaders(['A']);
      s.finishLegacyCalendarColors('C', { 'C|team|c1': '#00ff00' });
      expect(get().sharedCalendarColors).toEqual({ 'team|c1': '#00ff00' });
      expect(get().legacyCalendarColorReaders).toEqual(['A']);
    });

    it('forgetting an account takes it off the readers list', async () => {
      // The settings are in memory already (forget reads them first otherwise).
      useSettingsStore.setState({ hydrated: true });
      const s = get();
      s.setSharedCalendarColor('team|c1', '#00ff00');
      s.setSharedCalendarColor('A|team|c2', '#111111');
      s.seedLegacyCalendarColorReaders(['A', 'B']);
      await s.forgetAccountCalendarColors('A');
      expect(get().legacyCalendarColorReaders).toEqual(['B']);
      expect(get().sharedCalendarColors).toEqual({ 'team|c1': '#00ff00' });
      await get().forgetAccountCalendarColors('B');
      expect(get().legacyCalendarColorReaders).toEqual([]);
      expect(get().sharedCalendarColors).toEqual({});
    });

    // A failed or corrupt read leaves the defaults in memory: a write then
    // would put them over every stored setting.
    it.each([
      ['corrupt JSON', '{corrupt', false],
      ['a row that is not an object', '7', false],
      ['a rejected read', JSON.stringify({ sharedCalendarColors: { 'team|c1': '#00ff00' } }), true],
    ])('seeds nothing, and writes nothing, after %s', async (_, stored, rejectRead) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await AsyncStorage.setItem(KEY, stored);
      if (rejectRead) vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('CursorWindow'));
      useSettingsStore.setState({ hydrated: false });
      await get().hydrate();
      expect(get().settingsReadFailed).toBe(true);
      useSettingsStore.setState({ sharedCalendarColors: { 'team|c1': '#00ff00' } });
      get().seedLegacyCalendarColorReaders(['A']);
      expect(get().legacyCalendarColorReaders).toBeNull();
      expect(await AsyncStorage.getItem(KEY)).toBe(stored);
      warn.mockRestore();
    });

    it('a clean read, or none at all, lets the seed run', async () => {
      useSettingsStore.setState({ hydrated: false });
      await get().hydrate();
      expect(get().settingsReadFailed).toBe(false);
      await AsyncStorage.setItem(KEY, JSON.stringify({ sharedCalendarColors: { 'team|c1': '#00ff00' } }));
      useSettingsStore.setState({ hydrated: false });
      await get().hydrate();
      expect(get().settingsReadFailed).toBe(false);
      get().seedLegacyCalendarColorReaders(['A']);
      expect(get().legacyCalendarColorReaders).toEqual(['A']);
    });

    it('leaves out of the seed the accounts signed in while it was unseeded, kept in their own row', async () => {
      const s = get();
      s.setSharedCalendarColor('team|c1', '#00ff00');
      await s.noteSignedInWhileColorReadersUnseeded('C');
      expect(JSON.parse((await AsyncStorage.getItem('bulwark:calendar-color-non-readers:v1'))!)).toEqual(['C']);
      useSettingsStore.setState({ hydrated: false, legacyCalendarColorNonReaders: [] });
      await get().hydrate();
      expect(get().legacyCalendarColorNonReaders).toEqual(['C']);
      get().seedLegacyCalendarColorReaders(['A', 'C']);
      expect(get().legacyCalendarColorReaders).toEqual(['A']);
      // Once seeded, a sign-in is not noted (it is no reader anyway).
      await get().noteSignedInWhileColorReadersUnseeded('D');
      expect(get().legacyCalendarColorNonReaders).toEqual(['C']);
      useSettingsStore.setState({ legacyCalendarColorNonReaders: [] });
    });

    it('seeds nothing, and leaves the row alone, when that row could not be read', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await AsyncStorage.setItem('bulwark:calendar-color-non-readers:v1', '{corrupt');
      useSettingsStore.setState({ hydrated: false, legacyCalendarColorNonReaders: [] });
      await get().hydrate();
      expect(get().legacyCalendarColorNonReadersReadFailed).toBe(true);
      get().setSharedCalendarColor('team|c1', '#00ff00');
      await get().noteSignedInWhileColorReadersUnseeded('C');
      expect(get().legacyCalendarColorNonReaders).toEqual(['C']);
      get().seedLegacyCalendarColorReaders(['A', 'C']);
      expect(get().legacyCalendarColorReaders).toBeNull();
      expect(await AsyncStorage.getItem('bulwark:calendar-color-non-readers:v1')).toBe('{corrupt');
      useSettingsStore.setState({ legacyCalendarColorNonReaders: [], legacyCalendarColorNonReadersReadFailed: false });
      warn.mockRestore();
    });

    it('rejects a malformed stored readers list', () => {
      expect(mergeWithDefaults({ legacyCalendarColorReaders: 'A' } as never).legacyCalendarColorReaders).toBeNull();
      expect(mergeWithDefaults({ legacyCalendarColorReaders: [1] } as never).legacyCalendarColorReaders).toBeNull();
      expect(mergeWithDefaults({ legacyCalendarColorReaders: ['A'] }).legacyCalendarColorReaders).toEqual(['A']);
    });
  });

  describe('resetToDefaults', () => {
    it('restores every persisted key', () => {
      const s = useSettingsStore.getState();
      s.updateSetting('density', 'compact');
      s.updateSetting('debugMode', true);
      s.addTrustedSender('x@y.z');
      useSettingsStore.getState().resetToDefaults();
      const after = useSettingsStore.getState();
      expect(after.density).toBe('regular');
      expect(after.debugMode).toBe(false);
      expect(after.trustedSenders).toEqual([]);
    });
  });
  describe('single-flight hydrate', () => {
    it('reads storage once for concurrent calls and does not revert a later change', async () => {
      await AsyncStorage.setItem('webmail:settings:v1', JSON.stringify({ density: 'compact' }));
      const spy = vi.spyOn(AsyncStorage, 'getItem');
      // The mock is shared: count only this case's reads.
      const before = spy.mock.calls.length;
      useSettingsStore.setState({ hydrated: false });
      const first = useSettingsStore.getState().hydrate();
      const second = useSettingsStore.getState().hydrate();
      await first;
      useSettingsStore.getState().setDensity('extra-compact');
      await second;
      const reads = spy.mock.calls.slice(before).filter(([k]) => k === 'webmail:settings:v1').length;
      spy.mockRestore();
      expect(reads).toBe(1);
      expect(useSettingsStore.getState().density).toBe('extra-compact');
      await useSettingsStore.getState().hydrate();
      expect(useSettingsStore.getState().density).toBe('extra-compact');
    });
  });
});

describe('restoreLastFolder', () => {
  it('is off by default and stays on this device', () => {
    expect(mergeWithDefaults({} as never).restoreLastFolder).toBe(false);
    expect(toExportShape(mergeWithDefaults({ restoreLastFolder: true } as never))).not.toHaveProperty('restoreLastFolder');
  });

  it('reads back what was stored and rejects a non-boolean', () => {
    expect(mergeWithDefaults({ restoreLastFolder: true } as never).restoreLastFolder).toBe(true);
    expect(mergeWithDefaults({ restoreLastFolder: 'yes' } as never).restoreLastFolder).toBe(false);
  });
});

describe('recipientMentionsEnabled', () => {
  it('is on by default and exported under the webmail name', () => {
    expect(mergeWithDefaults({} as never).recipientMentionsEnabled).toBe(true);
    expect(toExportShape(mergeWithDefaults({} as never))).toHaveProperty('recipientMentionsEnabled', true);
  });

  it('reads back what was stored and rejects a non-boolean', () => {
    expect(mergeWithDefaults({ recipientMentionsEnabled: false } as never).recipientMentionsEnabled).toBe(false);
    expect(mergeWithDefaults({ recipientMentionsEnabled: 'no' } as never).recipientMentionsEnabled).toBe(true);
  });
});
