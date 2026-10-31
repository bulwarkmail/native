// A text field with no label of its own is named by its placeholder. When
// the placeholder is an example, TalkBack read the filter rule's name field
// as "e.g., Sort newsletters" (and the size condition as "e.g., 1000000").
// Fields with an example placeholder get their label as the accessible name,
// as in the webmail's filter-rule-modal.tsx.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(p);
    return e.name.endsWith('.tsx') ? [p] : [];
  });
}

function openingTags(source: string, name: string): { tag: string; line: number }[] {
  const out: { tag: string; line: number }[] = [];
  const re = new RegExp(`<${name}\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let depth = 0;
    let i = m.index;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0 && source[i - 1] !== '=') break;
    }
    out.push({ tag: source.slice(m.index, i + 1), line: source.slice(0, m.index).split('\n').length });
  }
  return out;
}

const EXAMPLE_PLACEHOLDER = /placeholder=\{[^}]*'e\.g\.?,?\s/;
const NAMED = /accessibilityLabel=|\blabel=/;

describe('text fields with an example placeholder', () => {
  it('are named by a label', () => {
    const offenders = sourceFiles(SRC).flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return ['Input', 'TextInput'].flatMap((name) => openingTags(source, name))
        .filter(({ tag }) => EXAMPLE_PLACEHOLDER.test(tag) && !NAMED.test(tag))
        .map(({ line }) => `${path.relative(SRC, file)}:${line}`);
    });
    expect(offenders).toEqual([]);
  });

  it('spots an unnamed one', () => {
    const [tag] = openingTags("<Input value={name} placeholder={t('x', 'e.g., Sort newsletters')} />", 'Input');
    expect(EXAMPLE_PLACEHOLDER.test(tag.tag)).toBe(true);
    expect(NAMED.test(tag.tag)).toBe(false);
  });
});
