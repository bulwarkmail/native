import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A custom label "Chess club" showed as "chess club". No render setup in the
// repo: the style of the field labels is read from the source.
describe('contact detail field labels', () => {
  it('shows a label as stored, without changing its case', () => {
    const src = readFileSync(join(__dirname, '..', 'ContactDetailScreen.tsx'), 'utf-8');
    const block = src.match(/\bdetailLabel:\s*\{([^}]*)\}/)?.[1];
    expect(block).toBeDefined();
    expect(block).toMatch(/color:\s*c\.textMuted,?\r?\n/);
    expect(block).not.toMatch(/textTransform/);
  });
});
