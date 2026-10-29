import { describe, it, expect } from 'vitest';
import { mix, DARK_COLORS, LIGHT_COLORS } from '../tokens';

describe('mix', () => {
  it('blends like a translucent layer, but opaque', () => {
    expect(mix('#ffffff', '#000000', 0.5)).toBe('#808080');
    expect(mix('#1e3a8a', '#0a0a0a', 0)).toBe('#0a0a0a');
    expect(mix('#1e3a8a', '#0a0a0a', 1)).toBe('#1e3a8a');
    expect(mix('rgba(0,0,0,0.5)', '#0a0a0a', 0.3)).toBe('#0a0a0a');
  });

  it('gives the webmail unread row tint (bg-accent/30)', () => {
    // #1e3a8a at 30% over #0a0a0a, and #dbeafe at 30% over white.
    expect(mix(DARK_COLORS.accent, DARK_COLORS.background, 0.3)).toBe('#101830');
    expect(mix(LIGHT_COLORS.accent, LIGHT_COLORS.background, 0.3)).toBe('#f4f9ff');
  });
});
