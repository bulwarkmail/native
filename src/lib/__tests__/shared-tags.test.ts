import { describe, it, expect } from 'vitest';
import { keywordColorFromPalette, mergeSharedTags, parseSharedTags } from '../shared-tags';

describe('parseSharedTags', () => {
  // The map shape the webmail writes (lib/shared-tags.ts).
  it('reads the map by tag id, sorted by name, keeping unknown fields out', () => {
    expect(parseSharedTags({
      tags: {
        urgent: { label: 'Urgent', color: 'red-dark', visibility: 'show', by: 'x' },
        billing: { label: '  Billing  ', color: 'teal' },
        unnamed: { color: 'blue' },
      },
      version: 2,
    })).toEqual([
      { id: 'billing', label: 'Billing', color: 'teal' },
      { id: 'unnamed', label: 'unnamed', color: 'blue' },
      { id: 'urgent', label: 'Urgent', color: 'red' },
    ]);
  });

  it('reads the earlier list and bare-array shapes, once per id', () => {
    const list = [{ id: 'a', label: 'A', color: 'green' }, { id: 'A', label: 'dup' }, { label: 'no id' }];
    expect(parseSharedTags({ list })).toEqual([{ id: 'a', label: 'A', color: 'green' }]);
    expect(parseSharedTags(list)).toEqual([{ id: 'a', label: 'A', color: 'green' }]);
  });

  it('drops ids no keyword can hold and caps long names', () => {
    const tags = parseSharedTags({
      tags: { 'has space': { label: 'x' }, 'a*b': { label: 'y' }, ok: { label: 'z'.repeat(50) } },
    });
    expect(tags.map((t) => t.id)).toEqual(['ok']);
    expect(tags[0].label).toHaveLength(30);
  });

  it('reads nothing from junk', () => {
    expect(parseSharedTags(undefined)).toEqual([]);
    expect(parseSharedTags('tags')).toEqual([]);
    expect(parseSharedTags({ tags: [1, 2] })).toEqual([]);
  });
});

describe('keywordColorFromPalette', () => {
  it("maps the webmail's shades onto the app's colours and unknown ones to grey", () => {
    expect(keywordColorFromPalette('blue-light')).toBe('blue');
    expect(keywordColorFromPalette('amber')).toBe('amber');
    expect(keywordColorFromPalette('magenta')).toBe('gray');
    expect(keywordColorFromPalette(7)).toBe('gray');
  });
});

describe('mergeSharedTags', () => {
  it('lets the shared definition name a tag and keeps the own ones nobody shared', () => {
    const shared = [{ id: 'Red', label: 'Escalated', color: 'red' as const }];
    const personal = [
      { id: 'red', label: 'Red', color: 'red' as const },
      { id: 'blue', label: 'Blue', color: 'blue' as const },
    ];
    expect(mergeSharedTags(shared, personal)).toEqual([
      { id: 'Red', label: 'Escalated', color: 'red' },
      { id: 'blue', label: 'Blue', color: 'blue' },
    ]);
    expect(mergeSharedTags([], personal)).toBe(personal);
  });
});
