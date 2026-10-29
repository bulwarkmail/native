import { describe, it, expect } from 'vitest';
import { DARK_COLORS, LIGHT_COLORS } from '../tokens';

// The standard theme's roles from branding/APP.md ("Tokens used here"),
// which follow the webmail's app/globals.css.
describe('standard theme tokens match the webmail', () => {
  it('light', () => {
    expect(LIGHT_COLORS.background).toBe('#ffffff');
    expect(LIGHT_COLORS.text).toBe('#0f172a');
    expect(LIGHT_COLORS.popover).toBe('#ffffff');
    expect(LIGHT_COLORS.border).toBe('#e2e8f0');
    expect(LIGHT_COLORS.mutedForeground).toBe('#64748b');
  });

  it('dark: white primary with near-black text on neutral greys', () => {
    expect(DARK_COLORS.background).toBe('#0a0a0a');
    expect(DARK_COLORS.text).toBe('#fafafa');
    expect(DARK_COLORS.primary).toBe('#fafafa');
    expect(DARK_COLORS.primaryForeground).toBe('#171717');
    expect(DARK_COLORS.popover).toBe('#1c1c1c');
    expect(DARK_COLORS.border).toBe('rgba(128, 128, 128, 0.3)');
    expect(DARK_COLORS.mutedForeground).toBe('#a3a3a3');
    expect(DARK_COLORS.muted).toBe('#262626');
  });
});
