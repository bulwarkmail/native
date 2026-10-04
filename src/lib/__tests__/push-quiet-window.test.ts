import { describe, it, expect, beforeEach, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QUIET_WINDOW_MS, recordAlert, shouldStaySilent } from '../push-quiet-window';

const T0 = Date.parse('2026-09-30T10:00:00Z');

describe('push quiet window', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await AsyncStorage.clear();
  });

  it('rings when nothing has alerted yet', async () => {
    expect(await shouldStaySilent('a', T0)).toBe(false);
  });

  it('a second account within 30 s is silent', async () => {
    await recordAlert('a', T0);
    expect(await shouldStaySilent('b', T0 + 5_000)).toBe(true);
  });

  it('the same account still rings', async () => {
    await recordAlert('a', T0);
    expect(await shouldStaySilent('a', T0 + 10_000)).toBe(false);
  });

  it('after 30 s it rings again', async () => {
    await recordAlert('a', T0);
    expect(await shouldStaySilent('b', T0 + QUIET_WINDOW_MS - 1)).toBe(true);
    expect(await shouldStaySilent('b', T0 + QUIET_WINDOW_MS)).toBe(false);
  });

  it('a silent alert does not extend the window', async () => {
    await recordAlert('a', T0);
    // Account b stays silent at +5 s and so records nothing; at +31 s it rings.
    expect(await shouldStaySilent('b', T0 + 5_000)).toBe(true);
    expect(await shouldStaySilent('b', T0 + 31_000)).toBe(false);
  });

  it('rings when storage fails', async () => {
    await recordAlert('a', T0);
    vi.spyOn(AsyncStorage, 'getItem').mockRejectedValue(new Error('storage unavailable'));
    expect(await shouldStaySilent('b', T0 + 1_000)).toBe(false);
  });

  it('rings when the stored record is unreadable', async () => {
    await AsyncStorage.setItem('push:lastAlert:v1', 'not json');
    expect(await shouldStaySilent('b', T0)).toBe(false);
  });

  it('does not throw when the alert cannot be recorded', async () => {
    vi.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('storage unavailable'));
    await expect(recordAlert('a', T0)).resolves.toBeUndefined();
  });
});
