import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../ToggleSwitch', () => ({ default: () => null }));
vi.mock('../../icons', () => ({}));
vi.mock('../../../stores/locale-store', () => ({ useLocaleStore: () => undefined }));
vi.mock('../../../theme/colors', () => ({ useColors: () => ({}) }));
vi.mock('../search-highlight', () => ({ useSearchHighlight: () => ({}) }));
vi.mock('../../../lib/modal-orientations', () => ({ MODAL_ORIENTATIONS: [] }));
vi.mock('react-native', () => ({ StyleSheet: { create: (s: unknown) => s } }));

import { switchRowPress } from '../settings-section';

// Tapping the "Colour-blind-safe colours" label did nothing: only the switch
// itself flipped the setting.

describe('a settings row with a switch', () => {
  it('flips the switch when the row is tapped', () => {
    const onChange = vi.fn();
    switchRowPress(false, onChange)!();
    expect(onChange).toHaveBeenLastCalledWith(true);
    switchRowPress(true, onChange)!();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('leaves a disabled switch alone', () => {
    expect(switchRowPress(false, vi.fn(), true)).toBeNull();
  });

  it('hands the switch to its row, which presses it unless the setting is locked', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'settings-section.tsx'), 'utf8');
    expect(src).toMatch(/rowToggle\.current = switchRowPress\(checked, onChange, disabled\);/);
    expect(src).toMatch(/onPress=\{\(\) => \{ if \(!locked\) rowToggle\.current\?\.\(\); \}\}/);
    expect(src).toMatch(/<SettingToggleContext\.Provider value=\{rowToggle\}>/);
    // The colour-blind row is such a row.
    const a11y = fs.readFileSync(path.resolve(__dirname, '..', 'AccessibilitySettings.tsx'), 'utf8');
    expect(a11y).toMatch(/label=\{t\('settings\.accessibility\.cvd_palette\.label'[\s\S]{0,300}<ToggleSwitch\s+checked=\{colorBlindPalette\}/);
  });
});
