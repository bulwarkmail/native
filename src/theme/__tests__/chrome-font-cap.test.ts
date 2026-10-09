// Fixed-size chrome (the tab bar, its badge, chips, swipe labels) sits in
// boxes that do not grow with the text. The font size setting scales it a
// little; the OS font scale on top of that is capped, so a large system size
// cannot clip or wrap it. Each such Text names CHROME_MAX_FONT_SCALE.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { CHROME_MAX_FONT_SCALE } from '../tokens';

const ROOT = join(__dirname, '..', '..', '..');

// File, and a piece of the `style` the chrome Text carries.
const CHROME_TEXT: Array<[string, string]> = [
  ['App.tsx', 'chrome.tabLabel'],
  ['App.tsx', 'chrome.tabBadge'],
  ['src/components/SwipeableRow.tsx', 'styles.bandLabel'],
  ['src/components/calendar/EventBlock.tsx', 'styles.blockTitle'],
  ['src/components/calendar/EventBlock.tsx', 'styles.blockTime'],
  ['src/components/calendar/EventBlock.tsx', 'styles.barTitle'],
  ['src/components/calendar/MonthView.tsx', 'styles.monthLabel'],
  ['src/components/calendar/MonthView.tsx', 'styles.chipText'],
  ['src/components/calendar/MonthView.tsx', 'styles.overflowText'],
  ['src/components/email/ListAttachmentChips.tsx', 'styles.name'],
  ['src/components/email/ListAttachmentChips.tsx', 'styles.moreText'],
  ['src/components/email/VerificationCodeChip.tsx', 'styles.code'],
  ['src/screens/ContactsScreen.tsx', 'styles.filterBadgeText'],
  ['src/screens/EmailListScreen.tsx', 'styles.chipText'],
  ['src/screens/EmailListScreen.tsx', 'styles.filterBadgeText'],
  ['src/screens/EmailListScreen.tsx', 'styles.triToggleText'],
];

// Every <Text> whose style mentions `style`, and whether it caps the scale.
function textsStyledWith(path: string, style: string): boolean[] {
  const text = readFileSync(join(ROOT, path), 'utf8');
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // The whole name: `styles.chipText` is not `styles.chipTextInactive`, a
  // nested Text that inherits its parent's cap.
  const named = new RegExp(`${style.replace('.', '\\.')}(?![\\w$])`);
  const found: boolean[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(file) === 'Text') {
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      const styleAttr = attrs.find((a) => a.name.getText(file) === 'style');
      if (named.test(styleAttr?.initializer?.getText(file) ?? '')) {
        const cap = attrs.find((a) => a.name.getText(file) === 'maxFontSizeMultiplier');
        found.push(cap?.initializer?.getText(file) === '{CHROME_MAX_FONT_SCALE}');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('fixed chrome text', () => {
  it('caps the OS font scale at about 1.3', () => {
    expect(CHROME_MAX_FONT_SCALE).toBeCloseTo(1.3);
  });

  it.each(CHROME_TEXT)('%s: the Text styled %s caps it', (path, style) => {
    const texts = textsStyledWith(path, style);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every(Boolean)).toBe(true);
  });

  it('the tab label follows the font size setting through typography.tabLabel', () => {
    const app = readFileSync(join(ROOT, 'App.tsx'), 'utf8');
    expect(app).toMatch(/tabLabel:\s*\{\s*\.\.\.typography\.tabLabel/);
  });
});
