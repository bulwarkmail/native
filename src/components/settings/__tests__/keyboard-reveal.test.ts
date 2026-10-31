import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { revealScrollY, settingsPagePaddingBottom, visibleHeightAboveKeyboard } from '../keyboard-reveal';

// Settings > Tags > Add tag: the form at the end of the page stayed under the
// keyboard (the window does not shrink for it on Android edge to edge), so
// taps meant for "No parent" landed on the keys.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', '..', rel), 'utf8');

describe('settings keyboard reveal', () => {
  // A phone: page from y=80 to y=800, keyboard top at y=500.
  const visible = visibleHeightAboveKeyboard(80, 720, 500);

  it('measures the page height left above the keyboard', () => {
    expect(visible).toBe(420);
    expect(visibleHeightAboveKeyboard(80, 720, 900)).toBe(720);
    expect(visibleHeightAboveKeyboard(80, 720, 60)).toBe(0);
  });

  it('scrolls a form under the keyboard up until its end clears it', () => {
    // Form at page y 600..800 with the page at the top: its end is hidden.
    expect(revealScrollY(0, 600, 800, visible, 12)).toBe(392);
  });

  it('keeps the top of a form taller than the space above the keyboard', () => {
    expect(revealScrollY(0, 600, 1200, visible, 12)).toBe(588);
  });

  it('leaves a form that already fits alone', () => {
    expect(revealScrollY(0, 100, 300, visible, 12)).toBeNull();
  });

  it('pads the page end by the keyboard so it can scroll that far', () => {
    expect(settingsPagePaddingBottom(40, 0)).toBe(40);
    expect(settingsPagePaddingBottom(40, 300)).toBe(340);
  });

  it('pads the settings page and hands the tag form to it on focus', () => {
    const screen = read('screens/SettingsScreen.tsx');
    expect(screen).toMatch(/paddingBottom: settingsPagePaddingBottom\(DETAIL_PADDING_BOTTOM, keyboard\)/);
    expect(screen).toMatch(/<SettingsKeyboardContext\.Provider value=\{revealOnKeyboard\}>/);
    const tags = read('components/settings/KeywordSettings.tsx');
    expect(tags).toMatch(/<View ref=\{formRef\} style=\{styles\.form\}>/);
    expect(tags).toMatch(/onFocus=\{\(\) => revealOnKeyboard\?\.\(formRef\.current\)\}/);
  });
});
