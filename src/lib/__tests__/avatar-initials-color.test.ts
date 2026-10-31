import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generateEmailAvatarColor, initialsColor } from '../avatar-utils';
import { parseColor, relativeLuminance } from '../event-colors';

// Initials were always white, which on the yellow, green and cyan hues of
// `hsl(h, 70%, 50%)` came out near 1.5:1 (webmail 2e13accad).

function contrast(a: { r: number; g: number; b: number; a: number }, b: { r: number; g: number; b: number; a: number }) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function hsl(h: number): { r: number; g: number; b: number; a: number } {
  // Same formula as the avatar's: 70 % saturation, 50 % lightness.
  const s = 0.7; const l = 0.5;
  const k = (n: number) => (n + h / 30) % 12;
  const f = (n: number) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255), a: 1 };
}

describe('avatar initials colour', () => {
  it('picks black on light hues and white on dark ones', () => {
    expect(initialsColor('hsl(60, 70%, 50%)')).toBe('#000000');
    expect(initialsColor('hsl(180, 70%, 50%)')).toBe('#000000');
    expect(initialsColor('hsl(240, 70%, 50%)')).toBe('#ffffff');
    expect(initialsColor('#1d4ed8')).toBe('#ffffff');
    expect(initialsColor('not a colour')).toBe('#ffffff');
  });

  it('reaches 4.5:1 on every generated hue', () => {
    for (let h = 0; h < 360; h++) {
      const ink = parseColor(initialsColor(`hsl(${h}, 70%, 50%)`))!;
      expect(contrast(hsl(h), ink), `hue ${h}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(generateEmailAvatarColor('Ann')).toMatch(/^hsl\(\d+, 70%, 50%\)$/);
  });

  it('is what the sender avatar draws its initials in', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../components/SenderAvatar.tsx'), 'utf8');
    expect(src).toMatch(/color: initialsColor\(bgColor\)/);
  });
});
