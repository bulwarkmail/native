import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fromExportShape, mergeWithDefaults, toExportShape, useSettingsStore } from '../settings-store';

// "Signature on new mail" and "Signature on replies & forwards" (webmail
// signatureNewMailEnabled / signatureReplyForwardEnabled, #1493): the app
// always inserted the identity's signature. Own file so agents working on
// settings in parallel don't edit the same test file.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('signature switches', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    useSettingsStore.getState().resetToDefaults();
  });

  it('are on by default', () => {
    expect(useSettingsStore.getState().signatureNewMailEnabled).toBe(true);
    expect(useSettingsStore.getState().signatureReplyForwardEnabled).toBe(true);
  });

  it('keep a stored value and travel under the webmail names', () => {
    expect(mergeWithDefaults({ signatureNewMailEnabled: false }).signatureNewMailEnabled).toBe(false);
    const exported = toExportShape({ ...useSettingsStore.getState(), signatureReplyForwardEnabled: false });
    expect(exported).toHaveProperty('signatureReplyForwardEnabled', false);
    expect(exported).toHaveProperty('signatureNewMailEnabled', true);
    expect(fromExportShape({ signatureNewMailEnabled: false, signatureReplyForwardEnabled: false }))
      .toEqual({ signatureNewMailEnabled: false, signatureReplyForwardEnabled: false });
  });

  it('have rows under Settings > Composing', () => {
    const src = read('components/settings/ComposingSettings.tsx');
    expect(src).toMatch(/<ToggleSwitch checked=\{signatureNewMailEnabled\} onChange=\{\(v\) => updateSetting\('signatureNewMailEnabled', v\)\} \/>/);
    expect(src).toMatch(/<ToggleSwitch checked=\{signatureReplyForwardEnabled\} onChange=\{\(v\) => updateSetting\('signatureReplyForwardEnabled', v\)\} \/>/);
  });

  it('gate the signature the composer inserts, per mode', () => {
    const src = read('screens/ComposeScreen.tsx');
    expect(src).toMatch(/const autoSignatureEnabled = mode === 'compose' \? signatureNewMailEnabled : signatureReplyForwardEnabled;/);
    const embed = src.slice(src.indexOf('const signatureEmbeddedRef'));
    expect(embed).toMatch(/^const signatureEmbeddedRef[^\n]*\r?\n[^\n]*\r?\n\s+React\.useEffect\(\(\) => \{\r?\n\s+if \(!primaryIdentity \|\| !autoSignatureEnabled\) return;/);
  });

  it('leave the own signature off a quick reply when replies are switched off', () => {
    const src = read('components/email/QuickReplyBox.tsx');
    expect(src).toMatch(/signPlainTextReply\(body, `\$\{header\.text\}\$\{quoted\}`, signatureReplyForwardEnabled \? signer : null, \{/);
    // The organisation's signature and disclaimer still go on.
    expect(src).toMatch(/\}, orgSetup, \{ separator: signatureSeparatorEnabled \}\)\.text,/);
  });
});
