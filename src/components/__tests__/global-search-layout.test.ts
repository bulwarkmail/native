// The global search sheet put its type chips mid-screen, with empty bands
// above and below, and started the results at about 60% of the height: the
// chips' horizontal ScrollView grew like flex: 1 in the sheet's column.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(__dirname, '../search/GlobalSearchSheet.tsx'), 'utf8');

function styleBody(name: string): string {
  const m = new RegExp(`\\n\\s+${name}: \\{([^}]*)\\}`).exec(src);
  expect(m, `style ${name}`).not.toBeNull();
  return m![1];
}

describe('global search sheet layout', () => {
  it('keeps the chip row to its own height', () => {
    const scroll = /<ScrollView\s+horizontal([\s\S]*?)>/.exec(src);
    expect(scroll).not.toBeNull();
    const style = /\sstyle=\{styles\.(\w+)\}/.exec(scroll![1]);
    expect(style, 'the horizontal ScrollView needs its own style').not.toBeNull();
    const body = styleBody(style![1]);
    expect(body).toMatch(/flexGrow: 0/);
    expect(body).toMatch(/flexShrink: 0/);
  });

  it('gives the rest of the sheet to the results', () => {
    expect(styleBody('results')).toMatch(/flex: 1/);
  });
});
