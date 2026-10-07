import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => undefined },
}));
import { unknownKeywordColor } from '../keywords-store';
import { colors } from '../../theme/tokens';

describe('unknownKeywordColor', () => {
  it('is stable for an id and a palette colour', () => {
    expect(unknownKeywordColor('projectx')).toBe(unknownKeywordColor('projectx'));
    expect(Object.keys(colors.tags)).toContain(unknownKeywordColor('projectx'));
  });
  it('keeps a palette-named id on its colour', () => {
    expect(unknownKeywordColor('blue')).toBe('blue');
  });
  it('spreads different ids over more than one colour', () => {
    const seen = new Set(['a', 'invoices', 'travel', 'x1', 'family', 'taxes', 'misc'].map(unknownKeywordColor));
    expect(seen.size).toBeGreaterThan(1);
  });
});
