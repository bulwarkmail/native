import { describe, it, expect } from 'vitest';
import { singleLine } from '../single-line';

describe('singleLine', () => {
  it('folds preview paragraph breaks into single spaces', () => {
    expect(singleLine('Q3 revenue is up 12 %.\n\n…')).toBe('Q3 revenue is up 12 %. …');
    expect(singleLine('Hi team,\r\n\r\nthe numbers\tare in.  See below.\n')).toBe('Hi team, the numbers are in. See below.');
  });

  it('folds a subject carrying CR/LF onto one line', () => {
    expect(singleLine('Invoice 1042\r\n for September')).toBe('Invoice 1042 for September');
  });

  it('returns an empty string for missing or blank input', () => {
    expect(singleLine(undefined)).toBe('');
    expect(singleLine(null)).toBe('');
    expect(singleLine(' \r\n\t ')).toBe('');
  });

  it('keeps a lone no-break space but folds runs that contain one', () => {
    expect(singleLine('12 %')).toBe('12 %');
    expect(singleLine('a \nb')).toBe('a b');
  });
});
