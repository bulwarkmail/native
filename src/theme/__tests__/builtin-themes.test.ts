import { describe, it, expect } from 'vitest';
import { BUILTIN_THEMES, getBuiltinTheme } from '../builtin-themes';
import { resolvePalette } from '../colors';
import { DARK_COLORS, LIGHT_COLORS } from '../tokens';

// Solid fills: RN paints screens, sheets and cards with these and has no
// backdrop blur, so a translucent value would show the content underneath.
const SOLID_FILLS = [
  'background', 'surface', 'surfaceHover', 'surfaceActive', 'card',
  'secondary', 'muted', 'accent', 'primaryBg', 'primaryBgHover', 'popover',
] as const;

describe('built-in themes', () => {
  it('ships every webmail built-in theme except Flat fields, in webmail order', () => {
    expect(BUILTIN_THEMES.map((t) => t.id)).toEqual([
      'builtin-qui',
      'builtin-nord',
      'builtin-catppuccin',
      'builtin-solarized',
      'builtin-roundcube-elastic',
      'builtin-aurora-glass',
    ]);
  });

  it('defines the same tokens for light and dark in every theme', () => {
    for (const theme of BUILTIN_THEMES) {
      expect(Object.keys(theme.light).sort(), theme.id).toEqual(Object.keys(theme.dark).sort());
    }
  });

  it('keeps solid-fill tokens opaque', () => {
    for (const theme of BUILTIN_THEMES) {
      for (const scheme of ['light', 'dark'] as const) {
        for (const key of SOLID_FILLS) {
          expect(theme[scheme][key], `${theme.id} ${scheme} ${key}`).toMatch(/^#[0-9a-f]{6}$/i);
        }
      }
    }
  });

  it('applies the Roundcube Elastic tokens in light and dark', () => {
    const light = resolvePalette('light', 'builtin-roundcube-elastic');
    expect(light.primary).toBe('#37beff');
    expect(light.text).toBe('#27353a');
    expect(light.background).toBe('#ffffff');
    const dark = resolvePalette('dark', 'builtin-roundcube-elastic');
    expect(dark.background).toBe('#21292c');
    expect(dark.surface).toBe('#2c373a');
    expect(dark.unread).toBe('#b88a00');
    // Tokens the webmail theme doesn't define keep the base palette.
    expect(dark.starred).toBe(DARK_COLORS.starred);
    expect(dark.calendar).toBe(DARK_COLORS.calendar);
  });

  it('flattens the Aurora Glass dark glass tokens onto its background', () => {
    const dark = resolvePalette('dark', 'builtin-aurora-glass');
    expect(dark.primary).toBe('#8b7bff');
    expect(dark.background).toBe('#06070f');
    // rgba(255, 255, 255, 0.06) over #06070f
    expect(dark.surface).toBe('#15161d');
    // rgba(139, 123, 255, 0.16) over #06070f
    expect(dark.accent).toBe('#1b1a35');
    // Overlays may stay translucent, as in the other themes.
    expect(dark.selection).toBe('rgba(139, 123, 255, 0.22)');
    const light = resolvePalette('light', 'builtin-aurora-glass');
    expect(light.background).toBe('#eef1fb');
    expect(light.tags).toBe(LIGHT_COLORS.tags);
  });

  it('falls back to the base palette for an unknown or cleared theme id', () => {
    expect(getBuiltinTheme('builtin-flat-fields')).toBeNull();
    expect(resolvePalette('dark', 'builtin-flat-fields')).toBe(DARK_COLORS);
    expect(resolvePalette('light', null)).toBe(LIGHT_COLORS);
  });
});
