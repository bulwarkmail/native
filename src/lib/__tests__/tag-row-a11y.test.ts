// Tag picker rows showed a check mark but exposed no checked state.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tagCheckedState, tagRowAccessibility } from '../tag-row-a11y';

describe('tag picker row state', () => {
  const a = { keywords: { $label1: true } };
  const b = { keywords: {} };

  it('is checked when every selected email has the tag', () => {
    expect(tagCheckedState([a, a], '$label1')).toBe(true);
    expect(tagRowAccessibility(true)).toEqual({ accessibilityRole: 'checkbox', accessibilityState: { checked: true } });
  });

  it('is mixed when only some have it, unchecked when none do', () => {
    expect(tagCheckedState([a, b], '$label1')).toBe('mixed');
    expect(tagCheckedState([b], '$label1')).toBe(false);
    expect(tagCheckedState([], '$label1')).toBe(false);
  });

  it('is spread onto both kinds of tag row', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../components/TagSheet.tsx'), 'utf8');
    const spreads = source.match(/\{\.\.\.tagRowAccessibility\(/g) ?? [];
    expect(spreads.length).toBe(2);
  });
});
