// Text fields need a name a screen reader can say (webmail ef13556a0,
// dcc21acd0, 4e2affe40, f73643bbb). The search field of the folder list and
// the unified views, and the From/To/Subject/Body fields of the filter
// panel, had only a placeholder, which isn't read once the field holds
// text; the filter labels are separate Text beside the field. Same scan as
// components/__tests__/field-names.test.ts.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

/** `file:line` of every TextInput, Input or DebouncedFilterInput element without a name. */
function unnamedFields(file: string): string[] {
  const source = readFileSync(join(SRC, file), 'utf8');
  const out: string[] = [];
  for (const m of source.matchAll(/<(TextInput|Input|DebouncedFilterInput)\b/g)) {
    const element = source.slice(m.index!, elementEnd(source, m.index! + m[0].length));
    if (/\baccessibilityLabel=/.test(element)) continue;
    if (m[1] === 'Input' && /\blabel=/.test(element)) continue;
    out.push(`${file}:${source.slice(0, m.index!).split('\n').length}`);
  }
  return out;
}

describe('search field names', () => {
  it('every field of the mail list, its filter panel and the unified views has a name', () => {
    expect(['screens/EmailListScreen.tsx', 'screens/UnifiedInboxScreen.tsx'].flatMap(unnamedFields)).toEqual([]);
  });
});
