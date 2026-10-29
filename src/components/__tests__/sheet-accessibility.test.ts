import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Sheets and menus were built as a tappable backdrop (Pressable or
// TouchableWithoutFeedback) wrapping a card that swallows taps. Both are
// accessible elements by default, and an accessible element hides its
// children from VoiceOver and TalkBack: the compose "Attach" and "Schedule
// send" sheets read as one element ("Attach, Photos & Videos, Camera, Files,
// Cancel") whose options couldn't be picked one by one. The wrappers that
// only catch taps are marked accessible={false}, so the options inside stay
// reachable.

const SRC = path.resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(p);
    return e.name.endsWith('.tsx') ? [p] : [];
  });
}

function openingTags(source: string, name: string): { tag: string; line: number }[] {
  const out: { tag: string; line: number }[] = [];
  const re = new RegExp(`<${name}\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let depth = 0;
    let i = m.index;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0 && source[i - 1] !== '=') break;
    }
    out.push({ tag: source.slice(m.index, i + 1), line: source.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** A wrapper that only catches taps and still hides what it wraps. */
export function isHidingWrapper(tag: string): boolean {
  if (/accessible=\{false\}/.test(tag)) return false;
  if (/\/\s*>$/.test(tag)) return false; // self-closing: wraps nothing
  if (tag.startsWith('<TouchableWithoutFeedback')) return true;
  if (/onPress=\{\(\) => \{\}\}/.test(tag)) return true;
  return /style=\{styles\.\w*(Backdrop|backdrop|Overlay|overlay)\}/.test(tag);
}

describe('sheet backdrops', () => {
  it('do not hide the options they wrap from screen readers', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const name of ['Pressable', 'TouchableWithoutFeedback']) {
        for (const { tag, line } of openingTags(source, name)) {
          if (isHidingWrapper(tag)) offenders.push(`${path.relative(SRC, file)}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('recognises the wrappers it looks for', () => {
    expect(isHidingWrapper('<Pressable style={styles.modalBackdrop} onPress={onClose}>')).toBe(true);
    expect(isHidingWrapper('<Pressable style={styles.card} onPress={() => {}}>')).toBe(true);
    expect(isHidingWrapper('<TouchableWithoutFeedback onPress={onClose}>')).toBe(true);
    expect(isHidingWrapper('<Pressable accessible={false} style={styles.modalBackdrop} onPress={onClose}>')).toBe(false);
    expect(isHidingWrapper('<Pressable style={styles.pickerOverlay} onPress={close} />')).toBe(false);
    expect(isHidingWrapper('<Pressable style={styles.row} onPress={open}>')).toBe(false);
  });
});
