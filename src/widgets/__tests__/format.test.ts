import { describe, expect, it } from 'vitest';
import { makeFmt } from '../format';

describe('count', () => {
  it('keeps counts as they are below 10,000 and shortens bigger ones', () => {
    const f = makeFmt('en', false);
    expect(f.count(0)).toBe('0');
    expect(f.count(9999)).toBe('9999');
    expect(f.count(10007)).toBe('10K');
    expect(f.count(12345)).toBe('12.3K');
    expect(f.count(234567)).toBe('235K');
    expect(f.count(2_500_000)).toBe('2.5M');
    expect(makeFmt('de', false).count(12345)).toBe('12,3K');
  });
});
