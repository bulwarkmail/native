// The folder list and the unified views show a search hit's excerpts in
// place of its subject and preview (webmail thread-list-item, b408b2597).
// They are drawn as spans of the row's own one- or two-line Text, so the
// row keeps its height when they arrive, and never as HTML. The screens
// aren't rendered in these tests, so their source is checked.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8').replace(/\r\n/g, '\n');

// The Text element that renders `expr` and the attributes it opens with.
function textAround(source: string, expr: string): string | null {
  const at = source.indexOf(`<SearchSnippetText snippet={${expr}} />`);
  if (at < 0) return null;
  const open = source.lastIndexOf('<Text ', at);
  return source.slice(open, source.indexOf('>', open) + 1);
}

describe.each([
  ['screens/EmailListScreen.tsx'],
  ['screens/UnifiedInboxScreen.tsx'],
])('%s', (file) => {
  const source = read(file);

  it('shows the subject excerpt on the one subject line', () => {
    expect(textAround(source, 'item.searchSnippet.subject')).toMatch(/numberOfLines=\{1\}/);
  });

  it('shows the body excerpt on the two preview lines', () => {
    expect(textAround(source, 'item.searchSnippet.preview')).toMatch(/numberOfLines=\{2\}/);
  });

  it('never renders the excerpt as HTML', () => {
    expect(source).not.toMatch(/dangerouslySet|innerHTML/);
  });
});
