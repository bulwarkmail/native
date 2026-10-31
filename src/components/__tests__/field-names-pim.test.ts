// Text fields need a name a screen reader can say (file 11 "Form fields
// have no name for screen readers"; field-names.test.ts covers Settings and
// sign-in). The contact form, the event editor and the calendar, contacts
// and files sheets had fields whose only name was their placeholder, or
// their value (the custom reminder's "30"). Scanned so a bare field doesn't
// creep back in.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..');

function elementEnd(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (depth === 0 && (ch === '>' || (ch === '/' && source[i + 1] === '>'))) return i;
  }
  return source.length;
}

/** `file:line` of every TextInput element without an accessibilityLabel. */
function unnamedFields(file: string): string[] {
  const source = readFileSync(join(SRC, file), 'utf8');
  const out: string[] = [];
  // `<TextInput>` as a type argument (useRef<TextInput>) is not an element.
  for (const m of source.matchAll(/<TextInput(?=\s)/g)) {
    const element = source.slice(m.index!, elementEnd(source, m.index! + m[0].length));
    if (/\baccessibilityLabel=/.test(element)) continue;
    out.push(`${file}:${source.slice(0, m.index!).split('\n').length}`);
  }
  return out;
}

const dir = (rel: string) => readdirSync(join(SRC, rel))
  .filter((name) => name.endsWith('.tsx'))
  .map((name) => `${rel}/${name}`);

const FILES = [
  ...dir('components/calendar'),
  ...dir('components/contacts'),
  ...dir('components/files'),
  ...dir('components/sharing'),
  'components/settings/VacationSettings.tsx',
  'screens/CalendarScreen.tsx',
  'screens/ContactFormScreen.tsx',
  'screens/ContactsScreen.tsx',
  'screens/ContactDetailScreen.tsx',
  'screens/FilesScreen.tsx',
];

describe('field names in calendar, contacts and files', () => {
  it('every field has a name', () => {
    expect(FILES.flatMap(unnamedFields)).toEqual([]);
  });
});
