// Settings panes whose every user-visible string goes through t(). A literal
// English label, description or option label sneaking back in stays English
// in every locale, so this scans the source for the prop shapes the panes use.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TRANSLATED_PANES = ['ReadingSettings.tsx'];

// `label="Foo"`, `description='Foo'`, `placeholder="Foo"` and `{ label: 'Foo' }`
// with a letter in the text (numeric option labels such as '25' are fine).
const LITERAL_RE = /\b(label|description|title|placeholder)(=|:\s*)(["'`])[^"'`]*[A-Za-z][^"'`]*\3/g;

describe('translated settings panes', () => {
  for (const file of TRANSLATED_PANES) {
    it(`${file} has no hard-coded English labels`, () => {
      const source = readFileSync(join(__dirname, '..', 'settings', file), 'utf8');
      const literals = [...source.matchAll(LITERAL_RE)].map((m) => m[0]);
      expect(literals).toEqual([]);
    });
  }
});
