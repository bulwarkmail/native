import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../api/identity', () => ({ getIdentities: vi.fn(async () => []) }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { useSettingsStore, discardSettingsEditsForTests } from '../settings-store';
import { missingSharedCalendarColors, sharedCalendarColorKey } from '../../lib/calendar-utils';
import { trustRecipients } from '../../lib/trust-recipients';
import type { Calendar } from '../../api/types';

// A settings row that could not be read must never be written over: the
// in-memory defaults would replace every stored setting.
const KEY = 'webmail:settings:v1';
const get = () => useSettingsStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

// Registered on the first failed read; this file's own module instance.
const foreground: ((state: string) => void)[] = [];
const listen = vi.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, fn: (state: string) => void) => {
  foreground.push(fn);
  return { remove: () => undefined };
}) as never);

const shared = { id: 'c1', name: 'Team', color: '#000000', isShared: true } as unknown as Calendar;

async function failRead(stored: string) {
  await AsyncStorage.setItem(KEY, stored);
  useSettingsStore.setState({ hydrated: false, settingsReadFailed: false });
  await get().hydrate();
  expect(get().settingsReadFailed).toBe(true);
}

describe('settings writes over a failed read', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    discardSettingsEditsForTests();
    useSettingsStore.setState({ settingsReadFailed: false, hydrated: true });
    await AsyncStorage.clear();
    get().resetToDefaults();
    await AsyncStorage.clear();
  });
  afterEach(() => warn.mockRestore());

  it('leaves a corrupt row unchanged after an auto-assign, a trust add and an updateSetting', async () => {
    await failRead('{corrupt');
    // What CalendarScreen's auto-assign writes for a newly shared calendar.
    const assigned = missingSharedCalendarColors([shared], 'A', get().sharedCalendarColors, 'A', false);
    expect(Object.keys(assigned)).toEqual([sharedCalendarColorKey('A', shared)]);
    for (const [key, color] of Object.entries(assigned)) get().setSharedCalendarColor(key, color);
    await flush();
    expect(await AsyncStorage.getItem(KEY)).toBe('{corrupt');

    // The Outbox replay trusting the recipients of a sent reply.
    trustRecipients([{ email: 'bob@example.com' }], undefined, { syncToBook: false, exclude: [] });
    await flush();
    expect(get().trustedSenders).toContain('bob@example.com');
    expect(await AsyncStorage.getItem(KEY)).toBe('{corrupt');

    get().updateSetting('theme', 'light');
    await flush();
    expect(await AsyncStorage.getItem(KEY)).toBe('{corrupt');
  });

  it('leaves a row whose read was rejected unchanged', async () => {
    const stored = JSON.stringify({ theme: 'dark', trustedSenders: ['a@example.com'] });
    await AsyncStorage.setItem(KEY, stored);
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('CursorWindow'));
    useSettingsStore.setState({ hydrated: false, settingsReadFailed: false });
    await get().hydrate();
    expect(get().settingsReadFailed).toBe(true);
    // The retry this edit starts fails too.
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('CursorWindow'));
    get().addTrustedSender('bob@example.com');
    await flush();
    expect(await AsyncStorage.getItem(KEY)).toBe(stored);
    expect(get().settingsReadFailed).toBe(true);
  });

  it('a successful retry applies the edits made meanwhile on top of the stored row, then writes again', async () => {
    const stored = JSON.stringify({ theme: 'dark', trustedSenders: ['a@example.com'], sharedCalendarColors: { 'A|team|c9': '#123456' } });
    await AsyncStorage.setItem(KEY, stored);
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('CursorWindow'));
    useSettingsStore.setState({ hydrated: false, settingsReadFailed: false });
    await get().hydrate();
    expect(get().settingsReadFailed).toBe(true);
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('CursorWindow'));
    get().addTrustedSender('bob@example.com');
    get().updateSetting('fontSize', 'large');
    await flush();
    expect(await AsyncStorage.getItem(KEY)).toBe(stored);

    // Back in the foreground the read works.
    expect(listen).toHaveBeenCalled();
    for (const fn of foreground) fn('active');
    await flush();
    await flush();
    expect(get().settingsReadFailed).toBe(false);
    expect(get().theme).toBe('dark');
    expect(get().fontSize).toBe('large');
    expect(get().trustedSenders).toEqual(['a@example.com', 'bob@example.com']);
    const written = JSON.parse((await AsyncStorage.getItem(KEY))!);
    expect(written.theme).toBe('dark');
    expect(written.fontSize).toBe('large');
    expect(written.trustedSenders).toEqual(['a@example.com', 'bob@example.com']);
    expect(written.sharedCalendarColors).toEqual({ 'A|team|c9': '#123456' });

    get().updateSetting('density', 'compact');
    await flush();
    expect(JSON.parse((await AsyncStorage.getItem(KEY))!).density).toBe('compact');
  });

  it('the next write retries the read, and a forget made meanwhile still lands', async () => {
    await failRead('{corrupt');
    // The row is readable again (rewritten elsewhere, or a transient fault).
    await AsyncStorage.setItem(KEY, JSON.stringify({ sharedCalendarColors: { 'A|team|c1': '#111111', 'B|team|c1': '#222222' } }));
    await get().forgetAccountCalendarColors('A');
    await flush();
    await flush();
    expect(get().settingsReadFailed).toBe(false);
    expect(JSON.parse((await AsyncStorage.getItem(KEY))!).sharedCalendarColors).toEqual({ 'B|team|c1': '#222222' });
  });
});
