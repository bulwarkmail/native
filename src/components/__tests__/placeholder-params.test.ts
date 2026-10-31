// A t() call whose catalog text has a {placeholder} but which passes no
// values shows the placeholder as it is: the New folder sheet labelled its
// parent picker with settings.folders.subfolder_of, the webmail's
// "Inside {name}" hint, and read "Inside {name}". The English fallback in the
// call ("Parent folder") hid it in review, since the catalog text wins.
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('expo-localization', () => ({ getLocales: () => [] }));

import { getDictionary } from '../../i18n';

const SRC = path.resolve(__dirname, '../..');

// The settings, filters, files and sheet code this check covers.
const SCOPE = [
  'components/settings',
  'components/filters',
  'components/files',
  'components/Dialog.tsx',
  'components/Input.tsx',
  'components/RadioGroup.tsx',
  'components/ToggleSwitch.tsx',
  'components/TagSheet.tsx',
  'components/NewTagRow.tsx',
  'components/MoveSheet.tsx',
  'components/IdentitySheet.tsx',
  'components/TemplateSheet.tsx',
  'screens/SettingsScreen.tsx',
  'screens/FilesScreen.tsx',
];

function files(rel: string): string[] {
  const p = path.join(SRC, rel);
  if (!fs.statSync(p).isDirectory()) return [p];
  return fs.readdirSync(p).flatMap((e) => (e === '__tests__' ? [] : files(path.join(rel, e))))
    .filter((f) => /\.tsx?$/.test(f));
}

function flatten(obj: Record<string, unknown>, prefix = '', out = new Map<string, string>()): Map<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v as Record<string, unknown>, key, out);
    else if (typeof v === 'string') out.set(key, v);
  }
  return out;
}

// t('key', 'fallback') or t('key', "fallback") closed right after the fallback.
const CALL_WITHOUT_VALUES = /\btr?\(\s*'([^']+)'\s*,\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*,?\s*\)/g;
// {name} or {count, plural, ...}; not the {{name}} template tokens.
const PLACEHOLDER = /(?<!\{)\{\s*\w+\s*[,}]/;

describe('t() calls without values', () => {
  it('use catalog texts that have no placeholders', () => {
    const en = flatten(getDictionary('en') as Record<string, unknown>);
    const offenders: string[] = [];
    for (const file of SCOPE.flatMap(files)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const m of source.matchAll(CALL_WITHOUT_VALUES)) {
        const text = en.get(m[1]);
        if (text && PLACEHOLDER.test(text)) offenders.push(`${m[1]} = ${text} (${path.relative(SRC, file)})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('spots a call that leaves a placeholder unfilled', () => {
    const calls = [..."t('settings.folders.subfolder_of', 'Parent folder')".matchAll(CALL_WITHOUT_VALUES)];
    expect(calls.map((m) => m[1])).toEqual(['settings.folders.subfolder_of']);
    expect(PLACEHOLDER.test('Inside {name}')).toBe(true);
    expect(PLACEHOLDER.test('Placeholders: {{recipient_name}}')).toBe(false);
    expect([..."t('a.b', 'x', { name })".matchAll(CALL_WITHOUT_VALUES)]).toEqual([]);
  });
});
