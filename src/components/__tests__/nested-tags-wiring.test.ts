import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Checked on the source: the suite has no React Native renderer. The rows
// themselves come from lib/keyword-nesting (keyword-nesting.test.ts); these
// check that the screens draw them.
const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', file), 'utf8');

describe('nested tags and tag visibility on screen', () => {
  it('draws the sidebar tags as a tree with the visibility settings applied', () => {
    const source = read('components/SidebarDrawer.tsx');
    expect(source).toMatch(/sidebarTagRows\(keywordDefs, nestedTags, tagCounts/);
    expect(source).toMatch(/depth=\{node\.depth\}/);
    expect(source).toMatch(/onToggleExpand=\{\(\) => toggleTagExpand\(node\.id\)\}/);
    expect(source).toMatch(/sidebar\.show_all_tags/);
  });

  it('indents nested tags in the tag sheet', () => {
    const source = read('components/TagSheet.tsx');
    expect(source).toMatch(/flattenKeywordTree\(buildKeywordTree\(keywords, nested\)\)/);
    expect(source).toMatch(/tagRowIndent\(kw\.depth\)/);
  });

  it('offers the nesting switch, a parent and the sidebar visibility in Settings > Tags', () => {
    const source = read('components/settings/KeywordSettings.tsx');
    expect(source).toMatch(/settings\.keywords\.nesting\.label/);
    expect(source).toMatch(/onChange=\{setNested\}/);
    expect(source).toMatch(/composeKeywordId\(parentId \|\| null, label\)/);
    expect(source).toMatch(/updateKeyword\(kw\.id, \{ visibility: value as KeywordVisibility \}\)/);
  });

  it('names a nested tag by its path in the list and the reader', () => {
    expect(read('screens/EmailListScreen.tsx')).toMatch(/formatKeyword\(id, keywordDefs, nestedTags\)/);
    expect(read('components/email/MessageHeader.tsx')).toMatch(/formatKeyword\(kw\.id, keywordDefs, nestedTags\)/);
  });
});
