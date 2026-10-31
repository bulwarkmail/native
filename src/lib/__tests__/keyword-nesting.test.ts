import { describe, it, expect } from 'vitest';
import type { KeywordDef } from '../../stores/keywords-store';
import {
  buildKeywordTree,
  filterKeywordTree,
  flattenKeywordTree,
  formatKeyword,
  getParentKeywordId,
  hasChildKeywords,
  isTagVisibleInSidebar,
  parentKeywordOptions,
  sidebarTagRows,
  treeRowLabel,
} from '../keyword-nesting';

// The webmail's DEV_KEYWORDS (stores/settings-store.ts).
const TAGS: KeywordDef[] = [
  { id: 'work', label: 'Work', color: 'blue' },
  { id: 'work/clients', label: 'Clients', color: 'teal' },
  { id: 'work/clients/acme', label: 'Acme', color: 'green' },
  { id: 'personal', label: 'Personal', color: 'purple' },
  { id: 'personal/finance', label: 'Finance', color: 'amber' },
  { id: 'receipts', label: 'Receipts', color: 'gray' },
];

describe('buildKeywordTree', () => {
  it('nests tags under the tag their id names as parent, keeping the order', () => {
    const tree = buildKeywordTree(TAGS);
    expect(tree.map((n) => n.id)).toEqual(['work', 'personal', 'receipts']);
    expect(tree[0].children.map((n) => n.id)).toEqual(['work/clients']);
    expect(tree[0].children[0].children[0]).toMatchObject({ id: 'work/clients/acme', depth: 2 });
  });

  it('keeps a tag whose parent is not defined at the root', () => {
    const tree = buildKeywordTree([{ id: 'team/urgent', label: 'Urgent', color: 'red' }]);
    expect(tree).toHaveLength(1);
    expect(tree[0].depth).toBe(0);
  });

  it('makes every tag a root with nesting off', () => {
    const tree = buildKeywordTree(TAGS, false);
    expect(tree).toHaveLength(TAGS.length);
    expect(tree.every((n) => n.depth === 0 && n.children.length === 0)).toBe(true);
  });
});

describe('names', () => {
  it('spells a nested tag out level by level with nesting on, by its own label with it off', () => {
    expect(formatKeyword('work/clients/acme', TAGS, true)).toBe('Work/Clients/Acme');
    expect(formatKeyword('work/clients/acme', TAGS, false)).toBe('Acme');
  });

  it('falls back to the raw level where a level has no definition', () => {
    expect(formatKeyword('work/other', TAGS, true)).toBe('Work/other');
    expect(formatKeyword('team/urgent', TAGS, false)).toBe('team/urgent');
  });

  it('names a root by its path and a child by its own label in a tree', () => {
    const all: KeywordDef[] = [...TAGS, { id: 'team/urgent', label: 'Urgent', color: 'red' }];
    const rows = flattenKeywordTree(buildKeywordTree(all));
    expect(treeRowLabel(rows.find((r) => r.id === 'work/clients')!, all, true)).toBe('Clients');
    expect(treeRowLabel(rows.find((r) => r.id === 'team/urgent')!, all, true)).toBe('team/Urgent');
  });
});

describe('hierarchy helpers', () => {
  it('finds the parent and children of a tag', () => {
    expect(getParentKeywordId('work/clients/acme')).toBe('work/clients');
    expect(getParentKeywordId('work')).toBeNull();
    expect(hasChildKeywords('work', TAGS)).toBe(true);
    expect(hasChildKeywords('receipts', TAGS)).toBe(false);
    // `work-old` is not under `work`.
    expect(hasChildKeywords('work', [{ id: 'work-old' }])).toBe(false);
  });

  it('offers every tag as a parent by its full path, in tree order', () => {
    expect(parentKeywordOptions(TAGS).map((o) => o.label)).toEqual([
      'Work', 'Work/Clients', 'Work/Clients/Acme', 'Personal', 'Personal/Finance', 'Receipts',
    ]);
    expect(parentKeywordOptions(TAGS, 'work').map((o) => o.id)).toEqual(['personal', 'personal/finance', 'receipts']);
  });

  it('keeps a hidden parent when a child below it stays', () => {
    const kept = filterKeywordTree(buildKeywordTree(TAGS), (n) => n.id === 'work/clients/acme');
    expect(kept.map((n) => n.id)).toEqual(['work']);
    expect(flattenKeywordTree(kept).map((n) => n.id)).toEqual(['work', 'work/clients', 'work/clients/acme']);
  });
});

describe('sidebar visibility', () => {
  it('hides a tag set to Hide, and one set to Show if unread once it has no unread mail', () => {
    const hide = { id: 'a', visibility: 'hide' as const };
    const unread = { id: 'b', visibility: 'unread' as const };
    expect(isTagVisibleInSidebar(hide, {})).toBe(false);
    expect(isTagVisibleInSidebar(unread, { b: { unread: 0 } })).toBe(false);
    expect(isTagVisibleInSidebar(unread, { b: { unread: 2 } })).toBe(true);
    // No count yet: shown rather than blinking out and back in.
    expect(isTagVisibleInSidebar(unread, {})).toBe(true);
    expect(isTagVisibleInSidebar({ id: 'c' }, {})).toBe(true);
  });

  it('shows a hidden tag while its tag view is open or "Show all" is on', () => {
    const hide = { id: 'a', visibility: 'hide' as const };
    expect(isTagVisibleInSidebar(hide, {}, { selectedId: 'a' })).toBe(true);
    expect(isTagVisibleInSidebar(hide, {}, { showAll: true })).toBe(true);
  });
});

describe('sidebarTagRows', () => {
  it('draws nested rows at their depth, and leaves out the children of a folded parent', () => {
    const { rows } = sidebarTagRows(TAGS, true, {});
    expect(rows.map((r) => [r.node.id, r.node.depth, r.label])).toEqual([
      ['work', 0, 'Work'],
      ['work/clients', 1, 'Clients'],
      ['work/clients/acme', 2, 'Acme'],
      ['personal', 0, 'Personal'],
      ['personal/finance', 1, 'Finance'],
      ['receipts', 0, 'Receipts'],
    ]);
    expect(rows[0]).toMatchObject({ hasChildren: true, expanded: true });
    const folded = sidebarTagRows(TAGS, true, {}, { collapsed: new Set(['work']) });
    expect(folded.rows.map((r) => r.node.id)).toEqual(['work', 'personal', 'personal/finance', 'receipts']);
    expect(folded.rows[0]).toMatchObject({ hasChildren: true, expanded: false });
  });

  it('draws a flat list named by label with nesting off', () => {
    const { rows } = sidebarTagRows(TAGS, false, {});
    expect(rows.every((r) => r.node.depth === 0 && !r.hasChildren)).toBe(true);
    expect(rows.map((r) => r.label)).toContain('Acme');
  });

  it('counts the tags the visibility settings hide, for "Show all (N)"', () => {
    const tags: KeywordDef[] = [
      ...TAGS.filter((t) => t.id !== 'receipts'),
      { id: 'receipts', label: 'Receipts', color: 'gray', visibility: 'hide' },
      { id: 'news', label: 'News', color: 'gray', visibility: 'unread' },
    ];
    const { rows, hiddenCount } = sidebarTagRows(tags, true, { news: { unread: 0 } });
    expect(rows.map((r) => r.node.id)).not.toContain('receipts');
    expect(rows.map((r) => r.node.id)).not.toContain('news');
    expect(hiddenCount).toBe(2);
    const all = sidebarTagRows(tags, true, { news: { unread: 0 } }, { showAll: true });
    expect(all.hiddenCount).toBe(0);
    expect(all.rows).toHaveLength(tags.length);
  });
});
