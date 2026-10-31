// The reading fonts on Settings > Accessibility > Font (webmail
// lib/accessibility-settings.ts AppFont, app/accessibility.css,
// lib/mail-reading.ts appFontFamilyName): Atkinson Hyperlegible Next, Lexend
// and OpenDyslexic. As in the webmail the font is the app's text font, and a
// plain-text mail body (which the webmail draws in the app document) uses it
// too; HTML mail keeps the sender's fonts.
//
// The app's text: Android finds the fonts in android/app/src/main/assets/
// fonts by the file name (scripts/build-reading-fonts.py), and the Text patch
// in ./reading-font-text applies the family. iOS bundles the same files
// (expo-font's config plugin in app.config.js) and finds them by the family
// name in their name table, so there the family is the font's real name.
//
// A mail body renders in a sandboxed WebView, which gets the woff2 files as
// data: URIs (./reading-fonts-data: a few hundred KB of base64 string
// constants, which Hermes keeps in the bytecode's string table rather than
// parsing them at startup).

import type { AppFont } from '../stores/settings-store';
import { ATKINSON, LEXEND, OPENDYSLEXIC, type ReadingFontFace } from './reading-fonts-data';

export type { AppFont };

/** The CSS family name a font is bundled under (webmail appFontFamilyName), or null for the default. */
export function appFontFamilyName(font: AppFont | null | undefined): string | null {
  switch (font) {
    case 'atkinson': return 'Atkinson Hyperlegible Next';
    case 'lexend': return 'Lexend';
    case 'opendyslexic': return 'OpenDyslexic';
    default: return null;
  }
}

/** The Android asset family (assets/fonts/<name>.ttf and <name>_bold.ttf). */
export function appFontAssetFamily(font: AppFont | null | undefined): string | null {
  switch (font) {
    case 'atkinson': return 'AtkinsonHyperlegibleNext';
    case 'lexend': return 'Lexend';
    case 'opendyslexic': return 'OpenDyslexic';
    default: return null;
  }
}

/** Whether the platform has the fonts for the app's own text. */
export function uiFontsBundled(platform: string): boolean {
  return platform === 'android' || platform === 'ios';
}

/**
 * The fontFamily the app's text is drawn in: null for the theme font, and
 * where the fonts aren't bundled (an unknown family is an error on iOS).
 * Android looks the family up by asset file name, iOS by the family name
 * the font registers under.
 */
export function uiFontFamily(font: AppFont | null | undefined, platform: string): string | null {
  if (!uiFontsBundled(platform)) return null;
  return platform === 'ios' ? appFontFamilyName(font) : appFontAssetFamily(font);
}

/** The mail body's own font stack (lib/email-html). */
export const MAIL_SYSTEM_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

/**
 * font-family for a mail body: the reading font first (it covers Latin
 * script; other scripts fall through to the system stack, as in the webmail).
 */
export function mailFontStack(font: AppFont | null | undefined): string {
  const family = appFontFamilyName(font);
  return family ? `"${family}", ${MAIL_SYSTEM_FONT_STACK}` : MAIL_SYSTEM_FONT_STACK;
}

function faceFor(font: AppFont): ReadingFontFace | null {
  switch (font) {
    case 'atkinson': return ATKINSON;
    case 'lexend': return LEXEND;
    case 'opendyslexic': return OPENDYSLEXIC;
    default: return null;
  }
}

/**
 * The @font-face rules a mail document needs for the font, with the fonts as
 * data: URIs (the page's CSP allows font-src data: in every mode). Empty for
 * the default font.
 */
export function readingFontFaceCss(font: AppFont | null | undefined): string {
  if (!font || font === 'default') return '';
  const face = faceFor(font);
  if (!face) return '';
  return face.subsets.map((subset) => [
    '@font-face {',
    `font-family: "${face.family}";`,
    'font-style: normal;',
    'font-display: swap;',
    `font-weight: ${face.weight};`,
    `src: url("data:font/woff2;base64,${subset.woff2}") format("woff2");`,
    subset.unicodeRange ? `unicode-range: ${subset.unicodeRange};` : '',
    '}',
  ].filter(Boolean).join(' ')).join('\n');
}
