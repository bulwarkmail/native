import { describe, it, expect } from 'vitest';
import { plainDisplayText } from '../display-text';

describe('plainDisplayText', () => {
  it('strips direction controls a sender could use to reorder what is shown', () => {
    expect(plainDisplayText('Bank\u202e \u2066Security\u2069\u200f\u061c')).toBe('Bank Security');
  });

  it('turns line breaks and other control characters into single spaces', () => {
    expect(plainDisplayText('Alice\n\n\u2028Sender verified\t\u0007ok')).toBe('Alice Sender verified ok');
  });

  it('caps the length with an ellipsis', () => {
    expect(plainDisplayText('a'.repeat(300), 10)).toBe('aaaaaaaaa…');
  });

  it('gives an empty string for nothing', () => {
    expect(plainDisplayText(undefined)).toBe('');
    expect(plainDisplayText(null)).toBe('');
  });
});
