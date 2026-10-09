import { describe, expect, it } from 'vitest';
import { tagRows } from '../tag-rows';
import type { KeywordDef } from '../../stores/keywords-store';

const kw = (id: string, extra: Partial<KeywordDef> = {}): KeywordDef => ({ id, label: id, color: 'blue', ...extra });
const base = { nested: true, counts: {}, selectedId: null, showAll: false, applyVisibility: true };
const ids = (r: ReturnType<typeof tagRows>) => r.rows.map((x) => x.def.id);

describe('tagRows', () => {
  it('hides a hidden tag, and counts it', () => {
    const r = tagRows([kw('a'), kw('h', { visibility: 'hide' })], base);
    expect(ids(r)).toEqual(['a']);
    expect(r.hiddenCount).toBe(1);
  });

  it('shows an unread-only tag until its count arrives, then only with unread mail', () => {
    const defs = [kw('u', { visibility: 'unread' })];
    expect(ids(tagRows(defs, base))).toEqual(['u']);
    expect(ids(tagRows(defs, { ...base, counts: { u: { unread: 0 } } }))).toEqual([]);
    expect(tagRows(defs, { ...base, counts: { u: { unread: 0 } } }).hiddenCount).toBe(1);
    expect(ids(tagRows(defs, { ...base, counts: { u: { unread: 2 } } }))).toEqual(['u']);
  });

  it('always shows the selected tag and, with showAll, every tag', () => {
    const defs = [kw('h', { visibility: 'hide' }), kw('u', { visibility: 'unread' })];
    const counts = { u: { unread: 0 } };
    expect(ids(tagRows(defs, { ...base, counts, selectedId: 'h' }))).toEqual(['h']);
    const all = tagRows(defs, { ...base, counts, showAll: true });
    expect(ids(all)).toEqual(['h', 'u']);
    expect(all.hiddenCount).toBe(0);
  });

  it('keeps a hidden parent when a visible child needs it, at their depths', () => {
    const defs = [
      kw('work', { visibility: 'hide' }),
      kw('acme', { parentId: 'work' }),
      kw('old', { parentId: 'work', visibility: 'hide' }),
      kw('home'),
    ];
    const r = tagRows(defs, base);
    expect(r.rows.map((x) => [x.def.id, x.depth])).toEqual([['work', 0], ['acme', 1], ['home', 0]]);
    expect(r.hiddenCount).toBe(1);
  });

  it('flattens to depth 0 when nesting is off', () => {
    const defs = [kw('work'), kw('acme', { parentId: 'work' }), kw('work/x')];
    const r = tagRows(defs, { ...base, nested: false });
    expect(r.rows.map((x) => [x.def.id, x.depth])).toEqual([['work', 0], ['acme', 0], ['work/x', 0]]);
  });

  it('lists a nested tree in tree order', () => {
    const defs = [kw('acme', { parentId: 'work' }), kw('home'), kw('work')];
    const r = tagRows(defs, base);
    expect(r.rows.map((x) => [x.def.id, x.depth])).toEqual([['home', 0], ['work', 0], ['acme', 1]]);
  });

  it('ignores visibility for the tag sheet', () => {
    const defs = [kw('h', { visibility: 'hide' }), kw('u', { visibility: 'unread' })];
    const r = tagRows(defs, { ...base, counts: { u: { unread: 0 } }, showAll: true, applyVisibility: false });
    expect(ids(r)).toEqual(['h', 'u']);
    expect(r.hiddenCount).toBe(0);
    expect(ids(tagRows(defs, { ...base, counts: { u: { unread: 0 } }, applyVisibility: false }))).toEqual(['h', 'u']);
    // The tag sheet names only the nesting: every tag, no counts needed.
    expect(ids(tagRows(defs, { nested: true }))).toEqual(['h', 'u']);
  });

  it('returns the stored definition, not a tree node', () => {
    const def = kw('a');
    expect(tagRows([def], base).rows[0].def).toBe(def);
  });

  describe('collapsed parents', () => {
    const defs = [kw('work'), kw('work/q3', { parentId: 'work' }), kw('home')];

    it('marks a parent expanded by default, and a leaf as having no children', () => {
      const { rows } = tagRows(defs, { nested: true });
      expect(rows.map((r) => r.def.id)).toEqual(['work', 'work/q3', 'home']);
      expect(rows[0]).toMatchObject({ hasChildren: true, expanded: true });
      expect(rows[1]).toMatchObject({ hasChildren: false });
    });

    it("hides a collapsed parent's children and marks the parent", () => {
      const { rows } = tagRows(defs, { nested: true, collapsed: new Set(['work']) });
      expect(rows.map((r) => r.def.id)).toEqual(['work', 'home']);
      expect(rows[0]).toMatchObject({ hasChildren: true, expanded: false });
    });

    it('keeps the path to the selected tag open', () => {
      expect(tagRows(defs, { nested: true, collapsed: new Set(['work']), selectedId: 'work/q3' }).rows.map((r) => r.def.id))
        .toContain('work/q3');
    });

    it('counts only visibility in hiddenCount, not collapsing', () => {
      expect(tagRows(defs, { ...base, collapsed: new Set(['work']) }).hiddenCount).toBe(0);
    });

    it('ignores collapsing when nesting is off', () => {
      const { rows } = tagRows(defs, { nested: false, collapsed: new Set(['work']) });
      expect(rows.map((r) => r.def.id)).toEqual(['work', 'work/q3', 'home']);
      expect(rows[0].hasChildren).toBe(false);
    });
  });
});
