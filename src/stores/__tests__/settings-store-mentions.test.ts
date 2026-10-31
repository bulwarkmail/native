import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fromExportShape, mergeWithDefaults, toExportShape, useSettingsStore } from '../settings-store';

// "@" mentions in the composer (webmail recipientMentionsEnabled and
// mentionAddsRecipientTo, stores/settings-store.ts and
// components/settings/composing-settings.tsx): could not be turned off, and
// a picked contact always joined To. Kept in its own file so agents working
// on settings in parallel don't edit the same test file.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('mention settings', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    useSettingsStore.getState().resetToDefaults();
  });

  it('defaults to mentions on, adding a picked contact to To', () => {
    expect(useSettingsStore.getState().recipientMentionsEnabled).toBe(true);
    expect(useSettingsStore.getState().mentionAddsRecipientTo).toBe('to');
  });

  it('keeps valid values and drops anything else', () => {
    expect(mergeWithDefaults({ recipientMentionsEnabled: false }).recipientMentionsEnabled).toBe(false);
    expect(mergeWithDefaults({ mentionAddsRecipientTo: 'cc' }).mentionAddsRecipientTo).toBe('cc');
    expect(mergeWithDefaults({ mentionAddsRecipientTo: 'off' }).mentionAddsRecipientTo).toBe('off');
    expect(mergeWithDefaults({ mentionAddsRecipientTo: 'bcc' as never }).mentionAddsRecipientTo).toBe('to');
  });

  it('exports and imports them under the webmail names', () => {
    const exported = toExportShape({ ...useSettingsStore.getState(), recipientMentionsEnabled: false, mentionAddsRecipientTo: 'cc' });
    expect(exported).toHaveProperty('recipientMentionsEnabled', false);
    expect(exported).toHaveProperty('mentionAddsRecipientTo', 'cc');
    expect(fromExportShape({ recipientMentionsEnabled: false, mentionAddsRecipientTo: 'off' }))
      .toEqual({ recipientMentionsEnabled: false, mentionAddsRecipientTo: 'off' });
  });

  it('has rows under Settings > Composing', () => {
    const src = read('components/settings/ComposingSettings.tsx');
    expect(src).toMatch(/<ToggleSwitch checked=\{recipientMentionsEnabled\} onChange=\{\(v\) => updateSetting\('recipientMentionsEnabled', v\)\} \/>/);
    expect(src).toMatch(/\{recipientMentionsEnabled && \(/);
    expect(src).toMatch(/segmented\(MENTION_ADDS_RECIPIENT, mentionAddsRecipientTo, \(v\) => updateSetting\('mentionAddsRecipientTo', v\)\)/);
  });

  it('drives the composer', () => {
    const src = read('screens/ComposeScreen.tsx');
    expect(src).toMatch(/mentions=\{recipientMentionsEnabled\}/);
    expect(src).toMatch(/if \(mentionQuery === null \|\| !recipientMentionsEnabled\) return \[\];/);
    expect(src).toMatch(/const contacts = mentionQuery && mentionAddsRecipientTo !== 'off'/);
    expect(src).toMatch(/mentionSuggestions\(mentionCandidates, contacts, mentionQuery, mentionAddsRecipientTo === 'cc' \? 'cc' : 'to'\)/);
    expect(src).toMatch(/if \(mentionAddsRecipientTo === 'off' \|\| !candidate\.addsTo\) \{/);
  });
});
