// Colour-blind-safe colours (webmail lib/cvd-palette.ts and its tests,
// cf4d02b49), and how the app's theme draws tags with the setting on.
import { describe, it, expect } from 'vitest';
import { CVD_COLORS, cvdColor, cvdHue, cvdTagPalette } from '../cvd-palette';
import { resolvePalette } from '../../theme/colors';
import { DARK_COLORS, LIGHT_COLORS } from '../../theme/tokens';
import { mergeWithDefaults } from '../../stores/settings-store';

describe('cvdHue', () => {
  it('maps the default calendar and tag colours onto separate palette colours', () => {
    expect(cvdHue('#ef4444')).toBe('vermillion');
    expect(cvdHue('#f97316')).toBe('orange');
    expect(cvdHue('#eab308')).toBe('yellow');
    expect(cvdHue('#22c55e')).toBe('bluishGreen');
    expect(cvdHue('#06b6d4')).toBe('skyBlue');
    expect(cvdHue('#3b82f6')).toBe('blue');
    expect(cvdHue('#a855f7')).toBe('reddishPurple');
  });

  it('keeps red and green apart, the pair red-green colour blindness merges', () => {
    expect(cvdHue('#dc2626')).not.toBe(cvdHue('#16a34a'));
    expect(cvdHue('#b91c1c')).toBe('vermillion');
    expect(cvdHue('#15803d')).toBe('bluishGreen');
  });

  it('reads tag palette names, with their light and dark shades', () => {
    expect(cvdHue('red')).toBe('vermillion');
    expect(cvdHue('teal-light')).toBe('skyBlue');
    expect(cvdHue('indigo-dark')).toBe('blue');
    expect(cvdHue('gray')).toBe('grey');
  });

  it('reads short hex, rgb() and hsl()', () => {
    expect(cvdHue('#f00')).toBe('vermillion');
    expect(cvdHue('rgb(0, 128, 0)')).toBe('bluishGreen');
    expect(cvdHue('hsl(220, 80%, 50%)')).toBe('blue');
  });

  it('turns greys grey and gives up on what it cannot read', () => {
    expect(cvdHue('#777777')).toBe('grey');
    expect(cvdHue('var(--color-primary)')).toBeNull();
    expect(cvdHue('')).toBeNull();
    expect(cvdHue(undefined)).toBeNull();
  });
});

describe('cvdColor', () => {
  it('draws a colour as it is while the setting is off', () => {
    expect(cvdColor('#3b82f6', false)).toBe('#3b82f6');
  });

  it('draws the palette colour while it is on, and leaves unreadable colours alone', () => {
    expect(cvdColor('#3b82f6', true)).toBe(CVD_COLORS.blue);
    expect(cvdColor('var(--color-primary)', true)).toBe('var(--color-primary)');
  });
});

describe('tags drawn colour-blind-safe', () => {
  it('draws the dot in the palette colour, the fill as its tint, the label in the text colour', () => {
    const tags = cvdTagPalette(DARK_COLORS.tags, '#fafafa');
    expect(tags.red).toEqual({ dot: CVD_COLORS.vermillion, bg: 'rgba(213, 94, 0, 0.15)', text: '#fafafa' });
    expect(tags.green.dot).toBe(CVD_COLORS.bluishGreen);
    expect(tags.red.dot).not.toBe(tags.green.dot);
    expect(tags.gray.dot).toBe(CVD_COLORS.grey);
  });

  it('switches every c.tags colour in the theme and keeps the picked ones for the picker', () => {
    const plain = resolvePalette('dark', null);
    expect(plain).toBe(DARK_COLORS);
    expect(plain.tags.red.dot).toBe('#ef4444');

    const safe = resolvePalette('dark', null, true);
    expect(safe.tags.red.dot).toBe(CVD_COLORS.vermillion);
    expect(safe.tags.red.text).toBe(DARK_COLORS.text);
    expect(safe.tagsAsPicked).toBe(DARK_COLORS.tags);
    // The rest of the theme is untouched, and the palette object is stable.
    expect(safe.primary).toBe(DARK_COLORS.primary);
    expect(resolvePalette('dark', null, true)).toBe(safe);

    const light = resolvePalette('light', 'builtin-roundcube-elastic', true);
    expect(light.tags.blue.dot).toBe(CVD_COLORS.blue);
    expect(light.tagsAsPicked).toBe(LIGHT_COLORS.tags);
  });

  it('is off by default and kept when stored', () => {
    expect(mergeWithDefaults({}).colorBlindPalette).toBe(false);
    expect(mergeWithDefaults({ colorBlindPalette: true }).colorBlindPalette).toBe(true);
  });
});
