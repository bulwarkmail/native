import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => ({
  preventScreenCaptureAsync: vi.fn(async (_key?: string) => {}),
  allowScreenCaptureAsync: vi.fn(async (_key?: string) => {}),
  enableAppSwitcherProtectionAsync: vi.fn(async (_blur?: number) => {}),
  disableAppSwitcherProtectionAsync: vi.fn(async () => {}),
}));
vi.mock('expo-screen-capture', () => capture);
vi.mock('../../api/identity', () => ({ getIdentities: vi.fn(async () => []) }));

import { Platform } from 'react-native';
import { useSettingsStore, toExportShape, fromExportShape } from '../../stores/settings-store';
import { resetScreenPrivacyForTests, startScreenPrivacySync } from '../screen-privacy';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('block screenshots', () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    useSettingsStore.getState().resetToDefaults();
    resetScreenPrivacyForTests();
    Object.values(capture).forEach((fn) => fn.mockClear());
    (Platform as { OS: string }).OS = 'android';
  });

  afterEach(() => {
    stop?.();
    stop = null;
    (Platform as { OS: string }).OS = 'android';
  });

  it('is off by default and stays on this device', () => {
    expect(useSettingsStore.getState().blockScreenshots).toBe(false);
    expect(toExportShape({ ...useSettingsStore.getState(), blockScreenshots: true })).not.toHaveProperty('blockScreenshots');
    expect(fromExportShape({ blockScreenshots: true })).not.toHaveProperty('blockScreenshots');
  });

  it('leaves screen capture alone while the setting is off', async () => {
    stop = startScreenPrivacySync();
    await flush();
    expect(capture.preventScreenCaptureAsync).not.toHaveBeenCalled();
    expect(capture.allowScreenCaptureAsync).not.toHaveBeenCalled();
  });

  it('blocks capture when turned on and allows it again when turned off', async () => {
    stop = startScreenPrivacySync();
    useSettingsStore.getState().updateSetting('blockScreenshots', true);
    await flush();
    expect(capture.preventScreenCaptureAsync).toHaveBeenCalledTimes(1);
    const key = capture.preventScreenCaptureAsync.mock.calls[0][0];

    useSettingsStore.getState().updateSetting('blockScreenshots', false);
    await flush();
    expect(capture.allowScreenCaptureAsync).toHaveBeenCalledWith(key);
    // Android hides the recents thumbnail through FLAG_SECURE already.
    expect(capture.enableAppSwitcherProtectionAsync).not.toHaveBeenCalled();
  });

  it('applies a saved "on" at launch', async () => {
    useSettingsStore.setState({ blockScreenshots: true });
    stop = startScreenPrivacySync();
    await flush();
    expect(capture.preventScreenCaptureAsync).toHaveBeenCalledTimes(1);
  });

  it('blurs the app switcher on iOS', async () => {
    (Platform as { OS: string }).OS = 'ios';
    stop = startScreenPrivacySync();
    useSettingsStore.getState().updateSetting('blockScreenshots', true);
    await flush();
    expect(capture.preventScreenCaptureAsync).toHaveBeenCalledTimes(1);
    expect(capture.enableAppSwitcherProtectionAsync).toHaveBeenCalledTimes(1);

    useSettingsStore.getState().updateSetting('blockScreenshots', false);
    await flush();
    expect(capture.disableAppSwitcherProtectionAsync).toHaveBeenCalledTimes(1);
  });

  it('tries again on the next change when the native call fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    capture.preventScreenCaptureAsync.mockRejectedValueOnce(new Error('no window'));
    stop = startScreenPrivacySync();
    useSettingsStore.getState().updateSetting('blockScreenshots', true);
    await flush();
    useSettingsStore.getState().updateSetting('blockScreenshots', false);
    await flush();
    // The failed "on" never took effect, so "off" has nothing to undo.
    expect(capture.allowScreenCaptureAsync).not.toHaveBeenCalled();
    useSettingsStore.getState().updateSetting('blockScreenshots', true);
    await flush();
    expect(capture.preventScreenCaptureAsync).toHaveBeenCalledTimes(2);
  });
});
