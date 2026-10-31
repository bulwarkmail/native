// The undo-send delay chips (and the other Composer choices), the Files sort
// sheet and the language list drew the picked option in another colour only:
// a screen reader heard every option alike and couldn't tell which was set.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { radioOptionA11y, RADIO_GROUP_A11Y } from '../radio-a11y';

const SRC = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').split('\r\n').join('\n');

describe('radioOptionA11y', () => {
  it('gives the picked option the radio role and the selected and checked state', () => {
    expect(radioOptionA11y(true)).toEqual({ accessibilityRole: 'radio', accessibilityState: { selected: true, checked: true } });
    expect(radioOptionA11y(false).accessibilityState).toEqual({ selected: false, checked: false });
    expect(RADIO_GROUP_A11Y.accessibilityRole).toBe('radiogroup');
  });
});

describe('option groups', () => {
  it('Composer chips (undo-send delay, autosave, signature) say which one is set', () => {
    const source = read('components/settings/ComposingSettings.tsx');
    const segmented = source.slice(source.indexOf('const segmented'), source.indexOf('return (\n    <SettingsSection'));
    expect(segmented).toContain('{...RADIO_GROUP_A11Y}');
    expect(segmented).toContain('{...radioOptionA11y(active)}');
  });

  it('the Files sort sheet says which order is set', () => {
    const source = read('screens/FilesScreen.tsx');
    expect(source).toContain('{...radioOptionA11y(sortKey === k)}');
    expect(source).toContain('{...radioOptionA11y(sortDir === d)}');
  });

  it('the language list says which language is set', () => {
    expect(read('components/settings/LanguageSettings.tsx')).toContain('{...radioOptionA11y(active)}');
  });
});
