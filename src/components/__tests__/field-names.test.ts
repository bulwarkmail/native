// Text fields need a name a screen reader can say (webmail ef13556a0,
// dcc21acd0, 4e2affe40, f73643bbb). The password, code and new-password
// fields under Security had none: no label prop, no placeholder, no
// accessibilityLabel. Settings and the sign-in steps are scanned so that a
// bare field doesn't creep back in; Input itself names its field from its
// label, then its placeholder.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inputAccessibility } from '../input-a11y';

const SRC = join(__dirname, '..', '..');

function elementEnd(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '/' && depth === 0 && source[i + 1] === '>') return i;
  }
  return source.length;
}

/** `file:line` of every TextInput or Input element without a name. */
function unnamedFields(file: string): string[] {
  const source = readFileSync(join(SRC, file), 'utf8');
  const out: string[] = [];
  for (const m of source.matchAll(/<(TextInput|Input)\b/g)) {
    const element = source.slice(m.index!, elementEnd(source, m.index! + m[0].length));
    if (/\baccessibilityLabel=/.test(element)) continue;
    if (m[1] === 'Input' && /\blabel=/.test(element)) continue;
    out.push(`${file}:${source.slice(0, m.index!).split('\n').length}`);
  }
  return out;
}

const SETTINGS = readdirSync(join(SRC, 'components', 'settings'))
  .filter((name) => name.endsWith('.tsx'))
  // The calendar pass owns the auto-reply editor.
  .filter((name) => name !== 'VacationSettings.tsx')
  .map((name) => `components/settings/${name}`);

const FILES = [
  ...SETTINGS,
  'screens/SettingsScreen.tsx',
  'screens/login/EmailStep.tsx',
  'screens/login/PasswordStep.tsx',
  'screens/login/ServerStep.tsx',
];

describe('field names', () => {
  it('every field in Settings and the sign-in steps has a name', () => {
    expect(FILES.flatMap(unnamedFields)).toEqual([]);
  });
});

describe('inputAccessibility', () => {
  it('names the field after its label', () => {
    expect(inputAccessibility({ label: 'Folder name', placeholder: 'Receipts' })).toEqual({ accessibilityLabel: 'Folder name' });
  });

  it('falls back to the placeholder, and lets an explicit name win', () => {
    expect(inputAccessibility({ placeholder: 'Search' })).toEqual({ accessibilityLabel: 'Search' });
    expect(inputAccessibility({ label: 'Name', accessibilityLabel: 'Display name' })).toEqual({ accessibilityLabel: 'Display name' });
  });

  it('reads the error as the hint', () => {
    expect(inputAccessibility({ label: 'Email', error: 'Not an address' })).toEqual({
      accessibilityLabel: 'Email',
      accessibilityHint: 'Not an address',
    });
  });
});
