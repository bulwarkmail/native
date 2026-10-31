import { describe, expect, it } from 'vitest';
import { visibleThemeCards } from '../theme-cards';
import { sanitizePolicy } from '../../../lib/org-policy';

const CARDS = [
  { id: null, name: 'Bulwark' },
  { id: 'nord', name: 'Nord' },
  { id: 'solarized', name: 'Solarized' },
];

describe('visibleThemeCards', () => {
  it('offers every card without a policy', () => {
    expect(visibleThemeCards(CARDS, null).map((c) => c.id)).toEqual([null, 'nord', 'solarized']);
  });

  it('leaves out the built-in themes the policy turns off', () => {
    const policy = sanitizePolicy({ themePolicy: { disabledBuiltinThemes: ['nord'] } });
    expect(visibleThemeCards(CARDS, policy).map((c) => c.id)).toEqual([null, 'solarized']);
  });

  it('keeps the default card whatever the policy lists', () => {
    const policy = sanitizePolicy({ themePolicy: { disabledBuiltinThemes: ['nord', 'solarized', 'null', ''] } });
    expect(visibleThemeCards(CARDS, policy).map((c) => c.id)).toEqual([null]);
  });
});
