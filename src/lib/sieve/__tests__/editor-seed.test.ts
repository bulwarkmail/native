import { describe, expect, it } from 'vitest';
import { seedsOnRender } from '../editor-seed';

describe('seedsOnRender', () => {
  it('seeds the Sieve editor when it opens, not when the script is refreshed while it is open (#1162)', () => {
    expect(seedsOnRender(false, true)).toBe(true);
    expect(seedsOnRender(true, true)).toBe(false);
    expect(seedsOnRender(true, false)).toBe(false);
    expect(seedsOnRender(false, false)).toBe(false);
  });
});
