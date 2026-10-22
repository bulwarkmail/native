import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// A SafeAreaView inside a slide-up react-native Modal measured no insets on
// iOS: the Modal is its own window and its content starts off screen, so on
// iPhones with a notch or Dynamic Island the header and its close button sat
// under the status bar, out of reach (attachment preview, QR scanner, paste
// sign-in link, filter and event editors). Such modals use SafeAreaModal,
// which gives the window its own SafeAreaProvider.

const SRC = path.resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(p);
    return e.name.endsWith('.tsx') ? [p] : [];
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

describe('slide-up modals with a SafeAreaView', () => {
  it('use SafeAreaModal so their header clears the status bar', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => {
        const source = fs.readFileSync(file, 'utf8');
        if (!source.includes('SafeAreaView')) return false;
        return modalTags(source).some((tag) => /animationType="slide"/.test(tag));
      })
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('finds the tags it is looking for', () => {
    const tags = modalTags('<View><Modal visible={x} onRequestClose={() => close()} animationType="slide">\n</Modal></View>');
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('animationType="slide"');
  });
});
