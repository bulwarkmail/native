// Reading fonts (Settings > Accessibility > Font, webmail
// lib/accessibility-settings.ts AppFont, app/accessibility.css): the names,
// the bundled Android files, the @font-face rules a mail body gets, and the
// wrapper that puts the font on the app's Text.
import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// The wrapper subscribes with useSyncExternalStore; outside a React render
// the test reads the snapshot directly.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));

import {
  appFontAssetFamily,
  appFontFamilyName,
  mailFontStack,
  readingFontFaceCss,
  uiFontFamily,
  uiFontsBundled,
} from '../reading-fonts';
import {
  getUiFontFamily,
  setUiFontFamily,
  withFontFamily,
  wrapModuleDefaults,
  wrapWithReadingFont,
} from '../reading-font-text';
import { APP_FONTS, mergeWithDefaults } from '../../stores/settings-store';
import { presetChanges } from '../../lib/accessibility-presets';

const ASSETS = join(__dirname, '..', '..', '..', 'android', 'app', 'src', 'main', 'assets', 'fonts');

describe('reading fonts', () => {
  it('offers the webmail fonts under its names and keys', () => {
    expect(APP_FONTS).toEqual(['default', 'atkinson', 'lexend', 'opendyslexic']);
    expect(appFontFamilyName('atkinson')).toBe('Atkinson Hyperlegible Next');
    expect(appFontFamilyName('lexend')).toBe('Lexend');
    expect(appFontFamilyName('opendyslexic')).toBe('OpenDyslexic');
    expect(appFontFamilyName('default')).toBeNull();
  });

  it('bundles a regular and a bold file on Android for every font', () => {
    for (const font of APP_FONTS) {
      const family = appFontAssetFamily(font);
      if (font === 'default') {
        expect(family).toBeNull();
        continue;
      }
      expect(existsSync(join(ASSETS, `${family}.ttf`))).toBe(true);
      expect(existsSync(join(ASSETS, `${family}_bold.ttf`))).toBe(true);
    }
    expect(existsSync(join(ASSETS, 'OFL.txt'))).toBe(true);
  });

  it('names a family for the app text only where the fonts are bundled', () => {
    expect(uiFontsBundled('android')).toBe(true);
    expect(uiFontFamily('opendyslexic', 'android')).toBe('OpenDyslexic');
    expect(uiFontFamily('default', 'android')).toBeNull();
    // iOS reports an unknown family as an error.
    expect(uiFontFamily('opendyslexic', 'ios')).toBeNull();
  });

  it('puts the font first in a mail body and keeps the system stack behind it', () => {
    expect(mailFontStack('lexend')).toMatch(/^"Lexend", -apple-system, /);
    expect(mailFontStack('default')).toMatch(/^-apple-system, /);
  });

  it('gives a mail document the font as data: woff2 with the webmail unicode ranges', () => {
    const css = readingFontFaceCss('atkinson');
    const faces = css.split('\n');
    expect(faces).toHaveLength(2);
    for (const face of faces) {
      expect(face).toContain('font-family: "Atkinson Hyperlegible Next";');
      expect(face).toContain('font-weight: 200 800;');
      // "wOF2", the woff2 signature, in base64.
      expect(face).toMatch(/src: url\("data:font\/woff2;base64,d09GMg[A-Za-z0-9+/=]+"\) format\("woff2"\);/);
      expect(face).toMatch(/unicode-range: U\+/);
    }
    expect(readingFontFaceCss('opendyslexic')).toContain('font-family: "OpenDyslexic";');
    expect(readingFontFaceCss('default')).toBe('');
  });

  it('keeps a stored font and drops one the app does not know', () => {
    expect(mergeWithDefaults({ appFont: 'lexend' }).appFont).toBe('lexend');
    expect(mergeWithDefaults({ appFont: 'comic-sans' as never }).appFont).toBe('default');
  });

  it('has a dyslexia preset that picks the readable font for the app and plain-text mail', () => {
    expect(presetChanges('dyslexia', { appFont: 'default', plainTextFont: 'mono' })).toEqual([
      { key: 'appFont', from: 'default', to: 'atkinson' },
      { key: 'plainTextFont', from: 'mono', to: 'sans' },
    ]);
  });
});

describe('the reading font on the app text', () => {
  it('puts the family under the caller style, which still wins', () => {
    const own = { color: 'red' };
    expect(withFontFamily({ style: own }, 'Lexend')).toEqual({ style: [{ fontFamily: 'Lexend' }, own] });
    expect(withFontFamily({}, 'Lexend')).toEqual({ style: { fontFamily: 'Lexend' } });
    const props = { style: own };
    expect(withFontFamily(props, null)).toBe(props);
  });

  it('renders the original component with the current family', () => {
    const seen: unknown[] = [];
    const Original = Object.assign((props: Record<string, unknown>) => { seen.push(props); return null; }, {
      displayName: 'TextInput',
      State: { currentlyFocusedInput: () => null },
    });
    const Wrapped = wrapWithReadingFont(Original);
    // Statics such as TextInput.State stay reachable.
    expect((Wrapped as unknown as typeof Original).State).toBe(Original.State);
    expect(Wrapped.displayName).toBe('TextInput');

    setUiFontFamily(null);
    Wrapped({ style: { color: 'red' }, children: 'x' });
    expect(seen.pop()).toEqual({ style: { color: 'red' }, children: 'x' });

    setUiFontFamily('OpenDyslexic');
    expect(getUiFontFamily()).toBe('OpenDyslexic');
    Wrapped({ style: { color: 'red' }, children: 'x' });
    expect(seen.pop()).toEqual({ style: [{ fontFamily: 'OpenDyslexic' }, { color: 'red' }], children: 'x' });
    setUiFontFamily(null);
  });

  it('wraps each module default once and leaves non-functions alone', () => {
    const text = { default: () => null };
    const memo = { default: { $$typeof: Symbol.for('react.memo') } };
    const original = text.default;
    expect(wrapModuleDefaults([text, memo])).toBe(1);
    expect(text.default).not.toBe(original);
    const wrapped = text.default;
    expect(wrapModuleDefaults([text])).toBe(0);
    expect(text.default).toBe(wrapped);
    expect(memo.default).toEqual({ $$typeof: Symbol.for('react.memo') });
  });
});
