import { describe, it, expect } from 'vitest';
import { findUnrecognizedKeywords, suggestKeywordColor, suggestKeywordLabel } from '../keyword-discovery';

describe('keyword discovery (#658)', () => {
  it('proposes humanized labels', () => {
    expect(suggestKeywordLabel('q3-invoices')).toBe('Q3 Invoices');
    expect(suggestKeywordLabel('work/clients')).toBe('Work/Clients');
  });

  it('keeps a palette-named id on its own colour and spreads the rest', () => {
    expect(suggestKeywordColor('blue')).toBe('blue');
    const a = suggestKeywordColor('alpha');
    const b = suggestKeywordColor('alpha', [a]);
    expect(a).not.toBe(b);
  });

  it('folds prefixes and case into one tag and skips defined ones', () => {
    const found = findUnrecognizedKeywords(
      { '$label:work': 3, '$color:Work': 2, '$label:todo': 1, '$seen': 10, '$label:blue': 4 },
      [{ id: 'blue', label: 'Blue', color: 'blue' }],
    );
    expect(found.map((f) => [f.id, f.count])).toEqual([['work', 5], ['todo', 1]]);
    expect(found[0].keyword).toBe('$label:work');
    expect(found[0].label).toBe('Work');
  });

  it('never proposes the attachment keywords Stalwart 1.0 puts on every message', () => {
    // 1.0 sets `$hasattachment` or `$hasnoattachment` on each message and
    // derives hasAttachment from them; 0.16 never does. They are no tags.
    const found = findUnrecognizedKeywords(
      { $hasattachment: 40, $hasnoattachment: 60, $HasAttachment: 1, '$label:work': 3 },
      [],
    );
    expect(found.map((f) => f.id)).toEqual(['work']);
  });
});
