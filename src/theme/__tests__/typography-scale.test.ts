import { describe, it, expect, afterEach } from 'vitest';
import { applyFontScale, FONT_SCALE, fontPx, fontScaleFactor, typography } from '../tokens';
import { scaledPalette } from '../colors';
import { syncFontScale } from '../dynamic';
import { useSettingsStore } from '../../stores/settings-store';

const BASE_BODY = { fontSize: 14, fontWeight: '400', lineHeight: 20 };

afterEach(() => applyFontScale(1));

describe('applyFontScale', () => {
  it('uses the webmail factors', () => {
    expect(FONT_SCALE).toEqual({ small: 0.875, medium: 1, large: 1.125 });
  });

  it('scales sizes and line heights from the base and keeps the weights', () => {
    applyFontScale(1.125);
    expect(typography.body).toEqual({ fontSize: 16, fontWeight: '400', lineHeight: 23 });
    expect(typography.h1).toEqual({ fontSize: 27, fontWeight: '700', lineHeight: 36 });
    expect(typography.bodySemibold.fontWeight).toBe('600');
  });

  it('is idempotent and does not compound', () => {
    applyFontScale(1.125);
    const once = JSON.stringify(typography);
    applyFontScale(1.125);
    expect(JSON.stringify(typography)).toBe(once);
    applyFontScale(0.875);
    applyFontScale(1.125);
    expect(JSON.stringify(typography)).toBe(once);
  });

  it('round-trips to the base at 1', () => {
    applyFontScale(0.875);
    expect(typography.body.fontSize).toBe(12);
    applyFontScale(1);
    expect(typography.body).toEqual(BASE_BODY);
  });

  it('mutates the entries in place so spread styles built later pick up the scale', () => {
    const entry = typography.caption;
    applyFontScale(1.125);
    expect(typography.caption).toBe(entry);
    expect({ ...typography.caption }.fontSize).toBe(14);
  });

  it('fontPx follows the font size setting from the base, in half points', () => {
    expect(fontPx(14.5)).toBe(14.5);
    applyFontScale(1.125);
    expect(fontPx(10)).toBe(11.5);
    applyFontScale(0.875);
    expect(fontPx(14.5)).toBe(12.5);
    applyFontScale(1);
    expect(fontPx(13)).toBe(13);
  });

  it('reports the factor it applies, so style caches can key on it', () => {
    expect(fontScaleFactor()).toBe(1);
    applyFontScale(FONT_SCALE.large);
    expect(fontScaleFactor()).toBe(1.125);
  });
});

describe('scaledPalette', () => {
  it('returns a new palette identity when the font size changes', () => {
    const medium = scaledPalette('dark', null, 'medium');
    const large = scaledPalette('dark', null, 'large');
    expect(large).not.toBe(medium);
    expect(large).toEqual(medium);
  });

  it('keeps a stable identity for the same inputs', () => {
    expect(scaledPalette('light', 'builtin-nord', 'large')).toBe(scaledPalette('light', 'builtin-nord', 'large'));
  });
});

describe('syncFontScale', () => {
  it('applies the stored size at once and on every change, before any render reads it', () => {
    useSettingsStore.setState({ fontSize: 'large' });
    const stop = syncFontScale();
    expect(typography.body.fontSize).toBe(16);
    useSettingsStore.getState().setFontSize('small');
    expect(typography.body.fontSize).toBe(12);
    // Hydration replaces the state with a plain set(); the listener sees it too.
    useSettingsStore.setState({ fontSize: 'medium' });
    expect(typography.body.fontSize).toBe(14);
    stop();
    useSettingsStore.setState({ fontSize: 'large' });
    expect(typography.body.fontSize).toBe(14);
    useSettingsStore.setState({ fontSize: 'medium' });
  });
});
