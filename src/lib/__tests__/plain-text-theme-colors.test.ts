import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildBodyDocument } from '../email-body-document';
import { BUILTIN_THEMES } from '../../theme/builtin-themes';

// A plain-text mail read in dark mode sat on a fixed #0a0a0a whatever the
// app's theme was (UX audit 2026-10, "Plain-text mail dark background").

const base = {
  key: 'k', emptyLabel: '-', blockRemoteImages: false, cidMap: {}, rawHtml: null, text: 'hello',
  messageSpacing: 'auto' as const, plainTextFont: 'sans' as const, quoteLabels: { show: 's', hide: 'h' },
};

describe('plain-text mail colours', () => {
  it("takes the dark theme's ground, text and link colours", () => {
    const nord = { background: '#2e3440', text: '#eceff4', link: '#88c0d0' };
    const html = buildBodyDocument({ ...base, isDark: true, plainDarkColors: nord }).html;
    expect(html).toContain('background: #2e3440;');
    expect(html).toContain('color: #eceff4;');
    expect(html).toContain('a { color: #88c0d0;');
    expect(html).not.toContain('#0a0a0a');
  });

  it('keeps white in light mode and the old dark colours without a theme', () => {
    const colors = { background: '#2e3440', text: '#eceff4', link: '#88c0d0' };
    expect(buildBodyDocument({ ...base, isDark: false, plainDarkColors: colors }).html).toContain('background: #ffffff;');
    expect(buildBodyDocument({ ...base, isDark: true }).html).toContain('background: #0a0a0a;');
  });

  it('cannot close the style sheet with a theme colour', () => {
    const html = buildBodyDocument({
      ...base, isDark: true, plainDarkColors: { background: 'red;}</style><script>x()</script>', text: '#fff', link: '#00f' },
    }).html;
    expect(html).not.toContain('</style><script>');
  });

  it('is fed from the app theme by the body view', () => {
    expect(BUILTIN_THEMES.length).toBeGreaterThan(0);
    const view = fs.readFileSync(path.resolve(__dirname, '../../components/EmailBodyView.tsx'), 'utf8');
    expect(view).toMatch(/background: c\.background, text: c\.text, link: c\.textLink/);
  });
});
