import { describe, it, expect } from 'vitest';
import { plainDisplayText, plainStoredText } from '../display-text';

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

  it('strips zero-width and other format characters', () => {
    expect(plainDisplayText('Ba\u200bnk\u2060 \ufeffSe\u00adcurity\u{e0041}')).toBe('Bank Security');
  });

  it('strips every format character Unicode lists', () => {
    // Hermes may lack \p{...}, so the module lists the ranges itself; this
    // keeps that list in step with the engine running the tests.
    const missed: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (/\p{Cf}/u.test(ch) && plainDisplayText(`a${ch}b`) !== 'ab') missed.push(cp.toString(16));
    }
    expect(missed).toEqual([]);
  });

  it('keeps every character that is not a format, control or separator character', () => {
    // The other half of the list check: nothing outside Cf is stripped, so a
    // name in any script shows as written.
    const lost: string[] = [];
    for (let cp = 0x21; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/u.test(ch)) continue;
      if (plainDisplayText(`a${ch}b`) !== `a${ch}b`) lost.push(cp.toString(16));
    }
    expect(lost).toEqual([]);
  });

  it('never splits a surrogate pair when it caps the length', () => {
    expect(plainDisplayText('\u{1f600}'.repeat(5), 3)).toBe('\u{1f600}\u{1f600}…');
    expect(plainDisplayText('\u{1f600}'.repeat(3), 3)).toBe('\u{1f600}'.repeat(3));
  });
});

describe('plainStoredText', () => {
  it('keeps line breaks and drops hidden characters', () => {
    expect(plainStoredText('One\r\nTwo\u202e\u0007 three\rFour', 100)).toBe('One\nTwo  three\nFour');
  });
  it('refuses text over the limit instead of cutting it', () => {
    expect(plainStoredText('abcd', 3)).toBeNull();
    expect(plainStoredText('abc', 3)).toBe('abc');
    expect(plainStoredText(null, 3)).toBe('');
  });
});
