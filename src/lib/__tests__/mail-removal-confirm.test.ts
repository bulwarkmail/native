import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSettingsStore } from '../../stores/settings-store';
import { confirmMailRemoval, type AskFn } from '../mail-removal-confirm';

// "Confirm before deleting" and "Confirm before archiving" existed as
// settings but nothing asked: delete and archive went ahead from the open
// message, the selection bar and swipes (webmail lib/mail-removal-confirm.ts).

const t = (key: string, fallback?: string, params?: Record<string, string | number>) =>
  `${key}${params?.count !== undefined ? `:${params.count}` : ''}${fallback ? '' : ''}`;

describe('confirmMailRemoval', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    useSettingsStore.getState().resetToDefaults();
  });

  it('goes ahead without asking while the settings are off', async () => {
    const ask = vi.fn<AskFn>(async () => false);
    expect(await confirmMailRemoval('delete', 2, t, ask)).toBe(true);
    expect(await confirmMailRemoval('archive', 2, t, ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks before a delete when "Confirm before deleting" is on, and stops on no', async () => {
    useSettingsStore.setState({ confirmDelete: true });
    const no = vi.fn<AskFn>(async () => false);
    expect(await confirmMailRemoval('delete', 3, t, no)).toBe(false);
    expect(no).toHaveBeenCalledWith(expect.objectContaining({
      title: 'email_list.confirm_remove.delete_title:3', destructive: true,
    }));
    expect(await confirmMailRemoval('delete', 3, t, async () => true)).toBe(true);
    // Archiving has its own switch.
    expect(await confirmMailRemoval('archive', 3, t, no)).toBe(true);
    expect(no).toHaveBeenCalledTimes(1);
  });

  it('asks before an archive when "Confirm before archiving" is on', async () => {
    useSettingsStore.setState({ confirmArchive: true });
    const ask = vi.fn<AskFn>(async () => false);
    expect(await confirmMailRemoval('archive', 1, t, ask)).toBe(false);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: 'email_list.confirm_remove.archive_title:1', destructive: false }));
    expect(await confirmMailRemoval('archive', 0, t, ask)).toBe(true);
  });

  it('is asked from the open message, the selection bar and swipes, but not on top of the permanent delete question', () => {
    const src = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8');
    const thread = src('screens/EmailThreadScreen.tsx');
    expect(thread).toMatch(/confirmMailRemoval\('delete', 1, t\)/);
    expect(thread).toMatch(/confirmMailRemoval\('archive', 1, t\)/);
    const list = src('screens/EmailListScreen.tsx');
    // deleteIds (swipe) and the selection bar's delete, each in the
    // non-permanent branch only.
    expect(list.match(/\} else if \(!\(await confirmMailRemoval\('delete', ids\.length, t\)\)\) \{/g)).toHaveLength(2);
    expect(list).toMatch(/confirmMailRemoval\('archive', ids\.length, t\)/);
    expect(list).toMatch(/confirmMailRemoval\('archive', selectedMessageIds\.length, t\)/);
    const unified = src('screens/UnifiedInboxScreen.tsx');
    expect(unified).toMatch(/confirmMailRemoval\('archive', targets\.length, t\)/);
    expect(unified).toMatch(/confirmMailRemoval\('delete', targets\.length, t\)/);
  });
});
