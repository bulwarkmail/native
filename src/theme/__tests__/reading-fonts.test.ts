// Reading fonts (Settings > Accessibility > Font, webmail
// lib/accessibility-settings.ts AppFont, app/accessibility.css): the names,
// the bundled Android files, the @font-face rules a mail body gets, and the
// wrapper that puts the font on the app's Text.
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

const ROOT = join(__dirname, '..', '..', '..');
const ASSETS = join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'fonts');

/** The Windows-platform names of a TTF's name table, by name id. */
function ttfNames(file: string): Record<number, string> {
  const buf = readFileSync(file);
  const numTables = buf.readUInt16BE(4);
  let offset = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) === 'name') offset = buf.readUInt32BE(rec + 8);
  }
  if (offset < 0) throw new Error(`${file} has no name table`);
  const count = buf.readUInt16BE(offset + 2);
  const strings = offset + buf.readUInt16BE(offset + 4);
  const out: Record<number, string> = {};
  for (let i = 0; i < count; i++) {
    const rec = offset + 6 + i * 12;
    if (buf.readUInt16BE(rec) !== 3) continue;
    const start = strings + buf.readUInt16BE(rec + 10);
    const bytes = Buffer.from(buf.subarray(start, start + buf.readUInt16BE(rec + 8)));
    out[buf.readUInt16BE(rec + 6)] = bytes.swap16().toString('utf16le');
  }
  return out;
}

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
    expect(uiFontFamily('atkinson', 'android')).toBe('AtkinsonHyperlegibleNext');
    expect(uiFontFamily('default', 'android')).toBeNull();
    // iOS finds the font by the family name in the file, not the file name.
    expect(uiFontsBundled('ios')).toBe(true);
    expect(uiFontFamily('atkinson', 'ios')).toBe('Atkinson Hyperlegible Next');
    expect(uiFontFamily('lexend', 'ios')).toBe('Lexend');
    expect(uiFontFamily('default', 'ios')).toBeNull();
    expect(uiFontsBundled('web')).toBe(false);
    expect(uiFontFamily('lexend', 'web')).toBeNull();
  });

  it('gives each bold file its own name under the family iOS looks up', () => {
    for (const font of APP_FONTS) {
      if (font === 'default') continue;
      const family = appFontAssetFamily(font);
      const regular = ttfNames(join(ASSETS, `${family}.ttf`));
      const bold = ttfNames(join(ASSETS, `${family}_bold.ttf`));
      expect(regular[1]).toBe(appFontFamilyName(font));
      expect(bold[1]).toBe(appFontFamilyName(font));
      expect(bold[2]).toBe('Bold');
      // Two files under one PostScript name register as one font on iOS.
      expect(bold[6]).not.toBe(regular[6]);
      expect(bold[4]).not.toBe(regular[4]);
    }
  });

  it('bundles every font file for iOS through expo-font', () => {
    const config = createRequire(__filename)(join(ROOT, 'app.config.js')).expo;
    const entry = config.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-font');
    const files: string[] = entry[1].ios.fonts;
    for (const font of APP_FONTS) {
      if (font === 'default') continue;
      const family = appFontAssetFamily(font);
      for (const name of [`${family}.ttf`, `${family}_bold.ttf`]) {
        const listed = files.find((f) => f.endsWith(`/${name}`));
        expect(listed, name).toBeDefined();
        expect(existsSync(join(ROOT, listed!))).toBe(true);
      }
    }
    // Android keeps its own assets/fonts; the plugin must not copy into it.
    expect(entry[1].fonts).toBeUndefined();
    expect(entry[1].android).toBeUndefined();
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
