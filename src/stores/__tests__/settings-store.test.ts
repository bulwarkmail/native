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

  describe('defaults', () => {
    it('match the webmail where behaviour is identical', () => {
      const s = useSettingsStore.getState();
      expect(s.includeGroupInUnified).toBe(true);
      expect(s.autoSelectReplyIdentity).toBe(false);
      expect(s.replyIdentityMatch).toBe('domain');
      expect(s.showBirthdayCalendar).toBe(false);
      expect(s.attachmentReminderKeywords).toContain('anhang');
      expect(s.attachmentReminderKeywords).toContain('添付');
    });
  });

  describe('mergeWithDefaults', () => {
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
});
