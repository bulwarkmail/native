import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../api/identity', () => ({ getIdentities: vi.fn(async () => []) }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  useSettingsStore,
  mergeWithDefaults,
  toExportShape,
  fromExportShape,
} from '../settings-store';

describe('settings-store', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    useSettingsStore.getState().resetToDefaults();
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

    it('round-trips through exportSettings', () => {
      useSettingsStore.getState().updateSetting('fontSize', 'large');
      const json = useSettingsStore.getState().exportSettings();
      useSettingsStore.getState().resetToDefaults();
      expect(useSettingsStore.getState().fontSize).toBe('medium');
      expect(useSettingsStore.getState().importSettings(json)).toBe(true);
      expect(useSettingsStore.getState().fontSize).toBe('large');
    });

    it('rejects non-object JSON', () => {
      expect(useSettingsStore.getState().importSettings('[1,2]')).toBe(false);
      expect(useSettingsStore.getState().importSettings('not json')).toBe(false);
    });

    it('fromExportShape maps webmail names back', () => {
      expect(fromExportShape({ expandedFilterView: true, filenameLowercase: true })).toEqual({
        filtersExpandedView: true,
        exportLowercase: true,
      });
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
      useSettingsStore.setState({ hydrated: false });
      const first = useSettingsStore.getState().hydrate();
      const second = useSettingsStore.getState().hydrate();
      await first;
      useSettingsStore.getState().setDensity('extra-compact');
      await second;
      const reads = spy.mock.calls.filter(([k]) => k === 'webmail:settings:v1').length;
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
