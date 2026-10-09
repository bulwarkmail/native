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

// A read that keeps being refused (a row too big to read, a storage fault)
// until `unblock`. Other keys read as usual.
const realGetItem = vi.mocked(AsyncStorage.getItem).getMockImplementation()!;
let blocked = false;
function unblock() { blocked = false; }
async function failRead(stored: string) {
  await AsyncStorage.setItem(KEY, stored);
  blocked = true;
  useSettingsStore.setState({ hydrated: false, settingsReadFailed: false });
  await get().hydrate();
  expect(get().settingsReadFailed).toBe(true);
}
const STORED = JSON.stringify({ theme: 'dark', trustedSenders: ['a@example.com'] });

describe('settings writes over a failed read', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    blocked = false;
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) => {
      if (blocked && key === KEY) throw new Error('CursorWindow');
      return realGetItem(key);
    });
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    discardSettingsEditsForTests();
    useSettingsStore.setState({ settingsReadFailed: false, hydrated: true });
    await AsyncStorage.clear();
    get().resetToDefaults();
    await AsyncStorage.clear();
  });
  afterEach(() => {
    warn.mockRestore();
    vi.mocked(AsyncStorage.getItem).mockImplementation(realGetItem);
  });

  it('leaves a row it cannot read unchanged after an auto-assign, a trust add and an updateSetting', async () => {
    await failRead(STORED);
    // What CalendarScreen's auto-assign writes for a newly shared calendar.
    const assigned = missingSharedCalendarColors([shared], 'A', get().sharedCalendarColors, 'A', false);
    expect(Object.keys(assigned)).toEqual([sharedCalendarColorKey('A', shared)]);
    for (const [key, color] of Object.entries(assigned)) get().setSharedCalendarColor(key, color);
    await flush();
    expect(await realGetItem(KEY)).toBe(STORED);

    // The Outbox replay trusting the recipients of a sent reply.
    trustRecipients([{ email: 'bob@example.com' }], undefined, { syncToBook: false, exclude: [] });
    await flush();
    expect(get().trustedSenders).toContain('bob@example.com');
    expect(await realGetItem(KEY)).toBe(STORED);

    get().updateSetting('theme', 'light');
    await flush();
    expect(await realGetItem(KEY)).toBe(STORED);
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
    await failRead(JSON.stringify({ sharedCalendarColors: { 'A|team|c1': '#111111', 'B|team|c1': '#222222' } }));
    // The fault passes.
    unblock();
    await get().forgetAccountCalendarColors('A');
    await flush();
    await flush();
    expect(get().settingsReadFailed).toBe(false);
    expect(JSON.parse((await AsyncStorage.getItem(KEY))!).sharedCalendarColors).toEqual({ 'B|team|c1': '#222222' });
  });

  // A row that reads but is not settings can never be read: it is kept
  // aside, and the app goes on from the defaults.
  it.each([['corrupt JSON', '{corrupt'], ['a row that is not an object', '7']])(
    'moves %s aside byte for byte, then writes again, edits made before the read included', async (_, stored) => {
      await AsyncStorage.setItem(KEY, stored);
      useSettingsStore.setState({ hydrated: false, settingsReadFailed: false });
      get().addTrustedSender('bob@example.com');
      await get().hydrate();
      await flush();
      expect(get().settingsReadFailed).toBe(false);
      expect(await AsyncStorage.getItem(`${KEY}:corrupt`)).toBe(stored);
      expect(get().trustedSenders).toEqual(['bob@example.com']);
      expect(JSON.parse((await AsyncStorage.getItem(KEY))!).trustedSenders).toEqual(['bob@example.com']);
      get().updateSetting('theme', 'light');
      await flush();
      expect(JSON.parse((await AsyncStorage.getItem(KEY))!).theme).toBe('light');
    },
  );

  it('overwrites an earlier backup', async () => {
    await AsyncStorage.setItem(`${KEY}:corrupt`, 'older');
    await AsyncStorage.setItem(KEY, '{newer');
    useSettingsStore.setState({ hydrated: false, settingsReadFailed: false });
    await get().hydrate();
    expect(await AsyncStorage.getItem(`${KEY}:corrupt`)).toBe('{newer');
  });

  it('stays blocked, the row untouched, while the backup cannot be written', async () => {
    await AsyncStorage.setItem(KEY, '{corrupt');
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
    useSettingsStore.setState({ hydrated: false, settingsReadFailed: false });
    await get().hydrate();
    expect(get().settingsReadFailed).toBe(true);
    expect(await AsyncStorage.getItem(`${KEY}:corrupt`)).toBeNull();
    // The edit's retry backs it up this time, then writes the edit.
    get().updateSetting('theme', 'light');
    await flush();
    await flush();
    expect(get().settingsReadFailed).toBe(false);
    expect(await AsyncStorage.getItem(`${KEY}:corrupt`)).toBe('{corrupt');
    expect(JSON.parse((await AsyncStorage.getItem(KEY))!).theme).toBe('light');
  });

  it('a read that keeps being refused stays blocked, however often it is tried', async () => {
    await failRead(STORED);
    for (let i = 0; i < 5; i++) {
      get().updateSetting('theme', 'light');
      for (const fn of foreground) fn('active');
      await flush();
    }
    expect(get().settingsReadFailed).toBe(true);
    expect(await realGetItem(KEY)).toBe(STORED);
    expect(await AsyncStorage.getItem(`${KEY}:corrupt`)).toBeNull();
  });

  it('an edit made before the first read lands on the stored settings, not the defaults', async () => {
    await AsyncStorage.setItem(KEY, STORED);
    useSettingsStore.setState({ hydrated: false, settingsReadFailed: false });
    get().addTrustedSender('bob@example.com');
    // Nothing written before the stored settings are read.
    expect(await realGetItem(KEY)).toBe(STORED);
    await get().hydrate();
    await flush();
    expect(get().theme).toBe('dark');
    expect(get().trustedSenders).toEqual(['a@example.com', 'bob@example.com']);
    const written = JSON.parse((await AsyncStorage.getItem(KEY))!);
    expect(written.theme).toBe('dark');
    expect(written.trustedSenders).toEqual(['a@example.com', 'bob@example.com']);
  });
});
