import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { presetChanges } from '../accessibility-presets';
import { EMPTY_SETTINGS_RULES, isLockedSetting, policyAllowsValue, type SettingsRules } from '../org-policy';

// Presets leave alone what the organisation pins or bounds (webmail
// lib/accessibility-presets.ts presetChanges with isSettingLocked and
// allowsValue). The app's presetChanges changed locked settings too.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('accessibility presets and the organisation policy', () => {
  const state = { fontSize: 'medium' as const, showToolbarLabels: false };

  it('skips a setting the organisation locked', () => {
    expect(presetChanges('low-vision', state, (key) => key === 'fontSize'))
      .toEqual([{ key: 'showToolbarLabels', from: false, to: true }]);
  });

  it('skips a value the organisation does not allow', () => {
    const rules: SettingsRules = {
      ...EMPTY_SETTINGS_RULES,
      restrictions: { fontSize: { allowedValues: ['medium', 'large'] } },
    };
    const changes = presetChanges(
      'low-vision',
      state,
      (key) => isLockedSetting(rules, key),
      (key, value) => policyAllowsValue(key, value, rules),
    );
    expect(changes).toEqual([{ key: 'showToolbarLabels', from: false, to: true }]);
  });

  it('changes everything without a policy', () => {
    expect(presetChanges('low-vision', state).map((c) => c.key)).toEqual(['fontSize', 'showToolbarLabels']);
  });

  it('passes the locks and bounds from Settings > Accessibility', () => {
    const src = read('components/settings/AccessibilitySettings.tsx');
    expect(src).toMatch(/presetChanges\(\s+id,\s+useSettingsStore\.getState\(\),\s+\(key\) => isLockedSetting\(rules, key\),\s+\(key, value\) => policyAllowsValue\(key, value, rules\),\s+\)/);
  });
});
