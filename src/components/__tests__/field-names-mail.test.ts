// Text fields need a name a screen reader can say (parity 11 "Form fields
// have no name for screen readers"; field-names.test.ts covers Settings and
// the sign-in steps). The composer, quick reply, folder prompt and template
// search had fields named only by their placeholder, or by nothing.
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
    else if (ch === '/' && depth === 0 && source[i + 1] === '>') return i;
  }
  return source.length;
}

/** `file:line` of every TextInput element without an accessibilityLabel. */
function unnamedFields(file: string): string[] {
  const source = readFileSync(join(SRC, file), 'utf8');
  const out: string[] = [];
  // `<TextInput` opening a JSX element, not `useRef<TextInput>`.
  for (const m of source.matchAll(/<TextInput(?=[\s/])/g)) {
    const element = source.slice(m.index!, elementEnd(source, m.index! + m[0].length));
    if (/\baccessibilityLabel=/.test(element)) continue;
    out.push(`${file}:${source.slice(0, m.index!).split('\n').length}`);
  }
  return out;
}

const COMPOSE = readdirSync(join(SRC, 'components', 'compose'))
  .filter((name) => name.endsWith('.tsx'))
  .map((name) => `components/compose/${name}`);

const FILES = [
  'screens/ComposeScreen.tsx',
  'components/email/QuickReplyBox.tsx',
  'components/SidebarDrawer.tsx',
  'components/TemplateSheet.tsx',
  ...COMPOSE,
];

describe('field names in mail and the composer', () => {
  it('every field has a name', () => {
    expect(FILES.flatMap(unnamedFields)).toEqual([]);
  });

  it('finds the composer fields at all', () => {
    const source = readFileSync(join(SRC, 'screens/ComposeScreen.tsx'), 'utf8');
    expect([...source.matchAll(/<TextInput(?=[\s/])/g)].length).toBeGreaterThanOrEqual(8);
  });
});
