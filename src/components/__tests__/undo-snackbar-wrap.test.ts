import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #1599: in Russian "ОТПРАВИТЬ СЕЙЧАС" and "ОТМЕНИТЬ" took the row and left
// the countdown a few letters. The buttons sit in their own wrapping group
// next to the text, which keeps a minimum width, so long labels go below it.
// No RN renderer in the suite: checked on the source.

const src = fs.readFileSync(path.resolve(__dirname, '../UndoSnackbar.tsx'), 'utf8');

describe('undo send bar layout', () => {
  it('wraps the buttons below a text that would get too narrow', () => {
    const bar = src.slice(src.indexOf('    bar: {'), src.indexOf('    label: {'));
    expect(bar).toMatch(/flexWrap: 'wrap',/);
    const label = src.slice(src.indexOf('    label: {'), src.indexOf('    actions: {'));
    expect(label).toMatch(/flexBasis: 0,/);
    expect(label).toMatch(/minWidth: UNDO_LABEL_MIN_WIDTH,/);
    expect(label).not.toMatch(/\bflex: 1\b/);
    expect(src).toMatch(/export const UNDO_LABEL_MIN_WIDTH = 96;/);
  });

  it('keeps both buttons together in one group after the text', () => {
    const jsx = src.slice(src.indexOf('<View style={styles.actions}>'), src.indexOf('</Animated.View>'));
    expect(jsx.indexOf('onPress={onSendNow}')).toBeGreaterThan(-1);
    expect(jsx.indexOf("onPress={() => { void onUndo(); }}")).toBeGreaterThan(jsx.indexOf('onPress={onSendNow}'));
    const actions = src.slice(src.indexOf('    actions: {'));
    expect(actions).toMatch(/^ {4}actions: \{\s+flexDirection: 'row',\s+flexWrap: 'wrap',/);
  });
});
