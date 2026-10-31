import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from '../../stores/settings-store';
import { toast, useToastStore } from '../../stores/toast-store';
import { setScreenReaderOnForTests } from '../screen-reader';
import { effectiveToastDuration, lastingToastDuration, userToastSeconds } from '../toast-duration';

// Toasts and the Undo bar left after a fixed 5 s, errors after 10 s, which
// is short for someone reaching the Undo button with a screen reader
// (webmail lib/toast-duration.ts, WCAG 2.2.1).

beforeEach(() => {
  setScreenReaderOnForTests(false);
  useSettingsStore.setState({ toastDuration: -1 });
  useToastStore.getState().clearToasts();
});

describe('notification duration', () => {
  it('is 5 s by default and 20 s while a screen reader is on', () => {
    expect(userToastSeconds()).toBe(5);
    setScreenReaderOnForTests(true);
    expect(userToastSeconds()).toBe(20);
    expect(lastingToastDuration(5000)).toBe(20_000);
  });

  it('follows the setting, never going below the time the caller picked', () => {
    useSettingsStore.setState({ toastDuration: 60 });
    expect(lastingToastDuration(5000)).toBe(60_000);
    useSettingsStore.setState({ toastDuration: 5 });
    expect(lastingToastDuration(10_000)).toBe(10_000);
  });

  it('keeps toasts until they are closed when set to 0', () => {
    useSettingsStore.setState({ toastDuration: 0 });
    expect(lastingToastDuration(5000)).toBe(0);
  });

  it('lengthens toasts with an action and errors, not plain notices', () => {
    useSettingsStore.setState({ toastDuration: 20 });
    expect(effectiveToastDuration({ type: 'success', action: { label: 'Undo' } })).toBe(20_000);
    expect(effectiveToastDuration({ type: 'error' })).toBe(20_000);
    expect(effectiveToastDuration({ type: 'success' })).toBe(5000);
  });

  it('is what the toast store gives a new toast', () => {
    setScreenReaderOnForTests(true);
    toast.success('Archived', { action: { label: 'Undo', onPress: () => undefined } });
    toast.error('Could not move');
    toast.info('Copied');
    expect(useToastStore.getState().toasts.map((t) => t.duration)).toEqual([20_000, 20_000, 5000]);
  });
});
