import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  isPickerReopenTooSoon, MIN_SUGGESTION_ROOM, needsRecipientPicker, PICKER_REOPEN_GRACE_MS, suggestionRoom,
} from '../recipient-picker';

// U-069: in phone landscape the keyboard leaves about 50 dp under the To
// field, so the inline suggestions hid behind it. The composer hands the
// field to a full-screen picker there, and wherever the measured room under
// the field is too small for the list.

describe('needsRecipientPicker', () => {
  it('always uses the picker in a phone-landscape window', () => {
    // use-layout's shortHeight: a window under 480 dp tall.
    expect(needsRecipientPicker({ shortHeight: true, windowHeight: 360, keyboardObstruction: 0, fieldBottom: null })).toBe(true);
  });

  it('keeps the inline list in portrait, where it has room above the keyboard', () => {
    expect(needsRecipientPicker({ shortHeight: false, windowHeight: 844, keyboardObstruction: 300, fieldBottom: 160 })).toBe(false);
  });

  it('uses the picker when less than two rows fit between field and keyboard', () => {
    // A short split-screen window: 520 tall, keyboard 300, field ends at 140.
    expect(suggestionRoom(520, 300, 140)).toBe(80);
    expect(80).toBeLessThan(MIN_SUGGESTION_ROOM);
    expect(needsRecipientPicker({ shortHeight: false, windowHeight: 520, keyboardObstruction: 300, fieldBottom: 140 })).toBe(true);
  });

  it('waits for the keyboard and a measurement before deciding on the room', () => {
    expect(needsRecipientPicker({ shortHeight: false, windowHeight: 520, keyboardObstruction: 0, fieldBottom: 140 })).toBe(false);
    expect(needsRecipientPicker({ shortHeight: false, windowHeight: 520, keyboardObstruction: 300, fieldBottom: null })).toBe(false);
  });

  it('does not reopen the picker from the focus the field gets back as it closes', () => {
    expect(isPickerReopenTooSoon(1000, 1000 + PICKER_REOPEN_GRACE_MS - 1)).toBe(true);
    expect(isPickerReopenTooSoon(1000, 1000 + PICKER_REOPEN_GRACE_MS)).toBe(false);
    expect(isPickerReopenTooSoon(null, 5)).toBe(false);
  });
});

describe('ComposeScreen recipient picker wiring', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../screens/ComposeScreen.tsx'), 'utf8');
  const field = source.slice(source.indexOf('const renderRecipientField'), source.indexOf('const composer = ('));

  it('opens the picker when an address field takes the focus in a short window', () => {
    expect(field).toMatch(/needsRecipientPicker\(\{ shortHeight, windowHeight, keyboardObstruction: kbObstruction, fieldBottom: null \}\)[\s\S]{0,40}openRecipientPicker\(field\)/);
  });

  it('hides the inline list while the picker has the field, and feeds the picker the same suggestions', () => {
    expect(field).toMatch(/activeField === field && !pickerField &&/);
    expect(source).toMatch(/const suggestField = pickerField \?\? activeField;\s+const suggestionQuery = inputFor\(suggestField\);/);
    const picker = source.slice(source.indexOf('<RecipientPicker'), source.indexOf('<ComposerOptionsSheet'));
    expect(picker).toMatch(/suggestions=\{suggestions\}/);
    expect(picker).toMatch(/onPick=\{pickSuggestion\}/);
    expect(picker).toMatch(/onDone=\{closeRecipientPicker\}/);
  });

  it('turns what was typed into chips when the picker closes', () => {
    const close = source.slice(source.indexOf('const closeRecipientPicker'), source.indexOf('const closeRecipientPicker') + 400);
    expect(close).toMatch(/if \(inputFor\(field\)\.trim\(\)\) addTyped\(field\);/);
    expect(close).toMatch(/pickerClosedAtRef\.current = Date\.now\(\);/);
  });
});
