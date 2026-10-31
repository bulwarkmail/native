import { describe, it, expect, beforeEach, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  useSettingsStore,
  resetPolicyRulesForTests,
  setPolicyLockedWriteListener,
  isSettingLockedByPolicy,
  legacyExplicitSettings,
} from '../settings-store';
import type { SettingsRules } from '../../lib/org-policy';

// The settings side of the organisation policy (webmail #1248): defaults for
// what the user hasn't chosen, locks whatever they chose, and a policy that
// arrives before the stored settings were read.

const rules = (r: Partial<SettingsRules>): SettingsRules => ({ defaults: {}, locks: {}, restrictions: {}, blocked: {}, hidden: [], ...r });

beforeEach(async () => {
  resetPolicyRulesForTests();
  await AsyncStorage.clear();
  useSettingsStore.setState({ hydrated: false });
  useSettingsStore.getState().resetToDefaults();
  useSettingsStore.setState({ hydrated: false });
});

describe('explicitSettings', () => {
  it('marks a setting the user changes, and only plain values', () => {
    useSettingsStore.setState({ hydrated: true });
    useSettingsStore.getState().updateSetting('density', 'compact');
    useSettingsStore.getState().setTheme('dark');
    useSettingsStore.getState().updateSetting('trustedSenders', ['a@example.org']);
    expect(useSettingsStore.getState().explicitSettings).toEqual(['density', 'theme']);
  });

  it('counts values other than the default as chosen in settings stored before it existed', () => {
    expect(legacyExplicitSettings({ density: 'compact', theme: 'system', trustedSenders: ['x'] })).toEqual(['density']);
  });

  it('works that out on hydrate, so a policy default does not replace an old choice', async () => {
    await AsyncStorage.setItem('webmail:settings:v1', JSON.stringify({ density: 'compact' }));
    useSettingsStore.getState().applyPolicyRules(rules({ defaults: { density: 'comfortable', markAsReadDelay: 2000 } }));
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState()).toMatchObject({ density: 'compact', markAsReadDelay: 2000, explicitSettings: ['density'] });
  });
});

describe('settings saved before a default changed', () => {
  // Older versions saved the full snapshot, so senderFavicons: true (the old
  // default) sits in it whether or not the user ever turned it on.
  it('does not count an old default as chosen', () => {
    expect(legacyExplicitSettings({ senderFavicons: true, showBirthdayCalendar: true, density: 'compact' })).toEqual(['density']);
  });

  it('moves an old default to the new one on upgrade, and lets a policy default apply', async () => {
    await AsyncStorage.setItem('webmail:settings:v1', JSON.stringify({
      senderFavicons: true,
      includeGroupInUnified: false,
      autoSelectReplyIdentity: true,
      showBirthdayCalendar: true,
      density: 'compact',
    }));
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState()).toMatchObject({
      senderFavicons: false,
      includeGroupInUnified: true,
      autoSelectReplyIdentity: false,
      showBirthdayCalendar: false,
      density: 'compact',
      explicitSettings: ['density'],
    });

    resetPolicyRulesForTests();
    await AsyncStorage.setItem('webmail:settings:v1', JSON.stringify({ senderFavicons: true, density: 'compact' }));
    useSettingsStore.setState({ hydrated: false });
    useSettingsStore.getState().applyPolicyRules(rules({ defaults: { senderFavicons: true, density: 'comfortable' } }));
    await useSettingsStore.getState().hydrate();
    // The organisation's default reaches the setting nobody chose.
    expect(useSettingsStore.getState()).toMatchObject({ senderFavicons: true, density: 'compact', explicitSettings: ['density'] });
  });

  it('keeps settings saved with explicitSettings as they are', async () => {
    await AsyncStorage.setItem('webmail:settings:v1', JSON.stringify({ senderFavicons: true, explicitSettings: ['senderFavicons'] }));
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState()).toMatchObject({ senderFavicons: true, explicitSettings: ['senderFavicons'] });
  });

  it('treats an old default in an imported file the same way', () => {
    useSettingsStore.setState({ hydrated: true });
    expect(useSettingsStore.getState().importSettings(JSON.stringify({ senderFavicons: true, dateFormat: 'full' }))).toBe(true);
    expect(useSettingsStore.getState()).toMatchObject({ senderFavicons: false, dateFormat: 'full' });
    expect(useSettingsStore.getState().explicitSettings).not.toContain('senderFavicons');
  });
});

describe('applyPolicyRules', () => {
  it('does not write the defaults over stored settings it has not read yet', async () => {
    await AsyncStorage.setItem('webmail:settings:v1', JSON.stringify({ theme: 'dark', explicitSettings: ['theme'] }));
    useSettingsStore.getState().applyPolicyRules(rules({ locks: { density: 'compact' } }));
    expect(JSON.parse((await AsyncStorage.getItem('webmail:settings:v1'))!)).toEqual({ theme: 'dark', explicitSettings: ['theme'] });
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState()).toMatchObject({ theme: 'dark', density: 'compact' });
  });

  it('refuses changes to a locked setting and to a blocked value', () => {
    useSettingsStore.setState({ hydrated: true });
    const refused = vi.fn();
    setPolicyLockedWriteListener(refused);
    useSettingsStore.getState().applyPolicyRules(rules({ locks: { density: 'compact' }, blocked: { activeThemeId: ['builtin-nord'] } }));
    expect(isSettingLockedByPolicy('density')).toBe(true);
    useSettingsStore.getState().setDensity('comfortable');
    useSettingsStore.getState().updateSetting('activeThemeId', 'builtin-nord');
    expect(useSettingsStore.getState()).toMatchObject({ density: 'compact', activeThemeId: null });
    expect(refused.mock.calls.map(([key]) => key)).toEqual(['density', 'activeThemeId']);
  });

  it('keeps locks over a reset and an import', () => {
    useSettingsStore.setState({ hydrated: true });
    useSettingsStore.getState().applyPolicyRules(rules({ locks: { density: 'compact' }, defaults: { markAsReadDelay: 2000 } }));
    useSettingsStore.getState().resetToDefaults();
    expect(useSettingsStore.getState()).toMatchObject({ density: 'compact', markAsReadDelay: 2000, explicitSettings: [] });
    expect(useSettingsStore.getState().importSettings(JSON.stringify({ density: 'comfortable', markAsReadDelay: 0, dateFormat: 'full' }))).toBe(true);
    // The file chose dateFormat; markAsReadDelay at its default counts as not chosen.
    expect(useSettingsStore.getState()).toMatchObject({ density: 'compact', markAsReadDelay: 2000, dateFormat: 'full' });
  });

  it('lets go of what the next rules no longer impose', () => {
    useSettingsStore.setState({ hydrated: true });
    useSettingsStore.getState().applyPolicyRules(rules({ locks: { density: 'compact' }, defaults: { theme: 'dark' } }));
    expect(useSettingsStore.getState()).toMatchObject({ density: 'compact', theme: 'dark' });
    useSettingsStore.getState().applyPolicyRules(rules({}));
    expect(useSettingsStore.getState()).toMatchObject({ density: 'regular', theme: 'system' });
    useSettingsStore.getState().setDensity('comfortable');
    expect(useSettingsStore.getState().density).toBe('comfortable');
  });
});
