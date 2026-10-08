import { describe, expect, it } from 'vitest';
import {
  MAX_KEYWORD_ID_LENGTH,
  buildKeywordTree,
  composeKeywordId,
  countKeywordNodes,
  descendantIds,
  effectiveParentId,
  filterKeywordTree,
  keywordVisibility,
  moveKeyword,
  normalizeKeywordLevel,
  resolvedParentId,
  labelInUse,
  type KeywordNode,
} from '../keyword-nesting';
import type { KeywordDef } from '../../stores/keywords-store';

const kw = (id: string, extra: Partial<KeywordDef> = {}): KeywordDef => ({ id, label: id, color: 'blue', ...extra });
const ids = (nodes: KeywordNode[]) => nodes.map((n) => n.id);

describe('buildKeywordTree', () => {
  it('nests by an explicit parentId without changing the id', () => {
    const tree = buildKeywordTree([
      { id: 'work', label: 'Work', color: 'blue' },
      { id: 'acme', label: 'Acme', color: 'red', parentId: 'work' },
    ]);
    expect(ids(tree)).toEqual(['work']);
    expect(ids(tree[0].children)).toEqual(['acme']);
    expect(tree[0].children[0].depth).toBe(1);
  });

  it('nests webmail-style ids (work/clients) under their defined parent', () => {
    const tree = buildKeywordTree([kw('work/clients'), kw('work'), kw('work/clients/acme')]);
    expect(ids(tree)).toEqual(['work']);
    expect(ids(tree[0].children)).toEqual(['work/clients']);
    expect(ids(tree[0].children[0].children)).toEqual(['work/clients/acme']);
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });

  it('keeps a slash id whose parent is not defined at the root', () => {
    expect(ids(buildKeywordTree([kw('home/bills')]))).toEqual(['home/bills']);
  });

  it('parentId null keeps a slash id at the root', () => {
    const tree = buildKeywordTree([kw('work'), kw('work/clients', { parentId: null })]);
    expect(ids(tree)).toEqual(['work', 'work/clients']);
  });

  it('places a tag whose parent is gone, or whose parents loop, at the root once', () => {
    const defs = [kw('a', { parentId: 'b' }), kw('b', { parentId: 'a' })];
    const tree = buildKeywordTree(defs);
    expect(countKeywordNodes(tree)).toBe(2);
    expect(ids(tree).sort()).toEqual(['a', 'b']);

    const orphan = buildKeywordTree([kw('x', { parentId: 'gone' }), kw('y')]);
    expect(ids(orphan)).toEqual(['x', 'y']);

    // A tag pointing at itself, and one hanging below a loop.
    const self = buildKeywordTree([kw('s', { parentId: 's' }), kw('c', { parentId: 'a' }), ...defs]);
    expect(countKeywordNodes(self)).toBe(4);
  });

  it('keeps the array order within a level', () => {
    const tree = buildKeywordTree([kw('p'), kw('z', { parentId: 'p' }), kw('q'), kw('a', { parentId: 'p' })]);
    expect(ids(tree)).toEqual(['p', 'q']);
    expect(ids(tree[0].children)).toEqual(['z', 'a']);
  });
});

describe('effectiveParentId', () => {
  const defined = new Set(['work', 'work/clients']);
  it('follows an explicit parent, the id-derived parent, or the root', () => {
    expect(effectiveParentId(kw('acme', { parentId: 'work' }), defined)).toBe('work');
    expect(effectiveParentId(kw('acme', { parentId: 'gone' }), defined)).toBeNull();
    expect(effectiveParentId(kw('work/clients'), defined)).toBe('work');
    expect(effectiveParentId(kw('work/clients', { parentId: null }), defined)).toBeNull();
    expect(effectiveParentId(kw('home/bills'), defined)).toBeNull();
  });
});

describe('resolvedParentId', () => {
  it('gives the parent the tree shows, a loop cut to the top level', () => {
    const defs = [kw('a', { parentId: 'b' }), kw('b', { parentId: 'a' }), kw('c', { parentId: 'a' })];
    expect(resolvedParentId(defs, 'a')).toBeNull();
    expect(resolvedParentId(defs, 'b')).toBeNull();
    expect(resolvedParentId(defs, 'c')).toBe('a');
    expect(resolvedParentId(defs, 'gone')).toBeNull();
  });
});

describe('filterKeywordTree', () => {
  it('keeps a hidden parent when a child is shown', () => {
    const tree = buildKeywordTree([kw('work', { visibility: 'hide' }), kw('acme', { parentId: 'work' }), kw('old', { visibility: 'hide' })]);
    const shown = filterKeywordTree(tree, (n) => keywordVisibility(n) !== 'hide');
    expect(ids(shown)).toEqual(['work']);
    expect(ids(shown[0].children)).toEqual(['acme']);
  });
});

describe('keywordVisibility', () => {
  it('defaults to show', () => {
    expect(keywordVisibility(kw('a'))).toBe('show');
    expect(keywordVisibility(kw('a', { visibility: 'unread' }))).toBe('unread');
  });
});

describe('composeKeywordId', () => {
  it('composes a child id under its parent and caps the length at 248', () => {
    expect(composeKeywordId('work', 'Big Client')).toBe('work/big-client');
    expect(composeKeywordId(null, 'Big Client')).toBe('big-client');
    expect(normalizeKeywordLevel('  A/B  ')).toBe('a-b');
    expect(MAX_KEYWORD_ID_LENGTH).toBe(248);
    // The id is never cut short: an over-long one is for the caller to refuse,
    // since a truncated id could collide with another tag.
    expect(composeKeywordId('p'.repeat(240), 'Long name').length).toBeGreaterThan(MAX_KEYWORD_ID_LENGTH);
  });
});

describe('moveKeyword', () => {
  const defs = [kw('work'), kw('a', { parentId: 'work' }), kw('home'), kw('h1', { parentId: 'home' }), kw('b', { parentId: 'work' })];

  it("moves a tag past its sibling only, skipping other parents' children when nested", () => {
    const up = moveKeyword(defs, 'b', 'up', true);
    expect(up.map((d) => d.id)).toEqual(['work', 'b', 'home', 'h1', 'a']);
    const down = moveKeyword(defs, 'work', 'down', true);
    expect(down.map((d) => d.id)).toEqual(['home', 'a', 'work', 'h1', 'b']);
    expect(buildKeywordTree(down).map((n) => n.id)).toEqual(['home', 'work']);
  });

  it('swaps with the adjacent entry when not nested', () => {
    expect(moveKeyword(defs, 'b', 'up', false).map((d) => d.id)).toEqual(['work', 'a', 'home', 'b', 'h1']);
  });

  it('returns the same array at an edge or for an unknown id', () => {
    expect(moveKeyword(defs, 'work', 'up', true)).toBe(defs);
    expect(moveKeyword(defs, 'b', 'down', true)).toBe(defs);
    expect(moveKeyword(defs, 'b', 'down', false)).toBe(defs);
    expect(moveKeyword(defs, 'a', 'up', true)).toBe(defs);
    expect(moveKeyword(defs, 'nope', 'up', false)).toBe(defs);
  });
});

describe('descendantIds', () => {
  it('excludes a tag and its descendants from its own parent choices', () => {
    const defs = [kw('work'), kw('work/clients'), kw('acme', { parentId: 'work/clients' }), kw('home')];
    const below = descendantIds(defs, 'work');
    expect([...below].sort()).toEqual(['acme', 'work/clients']);
    const choices = defs.filter((d) => d.id !== 'work' && !below.has(d.id)).map((d) => d.id);
    expect(choices).toEqual(['home']);
  });
});

describe('labelInUse', () => {
  const defs = [kw('work', { label: 'Work' }), kw('home', { label: 'Home' })];
  it('finds another tag with the same name, ignoring case and outer spaces', () => {
    expect(labelInUse(defs, ' work ', null)).toBe(true);
    expect(labelInUse(defs, 'Play', null)).toBe(false);
    expect(labelInUse(defs, '', null)).toBe(false);
  });
  it('does not count the tag being edited', () => {
    expect(labelInUse(defs, 'Work', 'work')).toBe(false);
    expect(labelInUse(defs, 'Home', 'work')).toBe(true);
  });
});
