import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// A SafeAreaView inside a react-native Modal whose content starts off screen
// measured no insets on iOS: the Modal is its own window, and the view was
// measured before it slid in. On iPhones with a notch or Dynamic Island the
// header and its close button sat under the status bar, out of reach
// (attachment preview, QR scanner, paste sign-in link, filter and event
// editors), the drawers' account headers did too, and the bottom sheets'
// last rows sat on the home indicator. Such modals use SafeAreaModal, which
// gives the window its own SafeAreaProvider. Slid in means animationType
// "slide", or "none" with the app's own slide animation (drawers, sheets).

const SRC = path.resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(p);
    return e.name.endsWith('.tsx') ? [p] : [];
  });
}

/** Plain <Modal> elements: the opening tag and what is between the tags. */
function modals(source: string): { tag: string; body: string }[] {
  return modalTags(source).map((tag) => {
    const start = source.indexOf(tag) + tag.length;
    const end = source.indexOf('</Modal>', start);
    return { tag, body: source.slice(start, end < 0 ? undefined : end) };
  });
}

/** Opening tags of plain <Modal> elements, attributes included. */
function modalTags(source: string): string[] {
  const tags: string[] = [];
  let at = source.indexOf('<Modal');
  while (at >= 0) {
    if (/[\s>]/.test(source[at + 6] ?? '')) {
      let depth = 0;
      let i = at;
      for (; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === '>' && depth === 0 && source[i - 1] !== '=') break;
      }
      tags.push(source.slice(at, i + 1));
    }
    at = source.indexOf('<Modal', at + 6);
  }
  return tags;
}

describe('modals that slide in with a SafeAreaView', () => {
  it('use SafeAreaModal so their content clears the status bar and home indicator', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => {
        const source = fs.readFileSync(file, 'utf8');
        if (!source.includes('SafeAreaView')) return false;
        return modals(source).some(({ tag, body }) =>
          /animationType="slide"/.test(tag)
          || (/animationType="none"/.test(tag) && body.includes('<SafeAreaView')));
      })
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  // The mail drawer builds its panel (with the SafeAreaView) outside the
  // modal's tags, so the check above can't see it there.
  it('include the side drawers', () => {
    const drawers = sourceFiles(SRC).filter((file) => /SidebarDrawer\.tsx$/.test(file));
    expect(drawers.length).toBeGreaterThanOrEqual(3);
    for (const file of drawers) {
      const source = fs.readFileSync(file, 'utf8');
      expect(modalTags(source).filter((tag) => /animationType="none"/.test(tag)), path.relative(SRC, file)).toEqual([]);
      expect(source).toContain('<SafeAreaModal');
    }
  });

  it('finds the tags it is looking for', () => {
    const tags = modalTags('<View><Modal visible={x} onRequestClose={() => close()} animationType="slide">\n</Modal></View>');
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('animationType="slide"');
  });
});
