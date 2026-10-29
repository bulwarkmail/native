import { describe, it, expect } from 'vitest';
import { editorKeyboardInset } from '../calendar-editor-keyboard';

describe('editorKeyboardInset (#81)', () => {
  it('ends the scroll area above the keyboard, past the safe-area inset already kept clear', () => {
    expect(editorKeyboardInset(320, 24, 0)).toBe(296);
  });

  it('shortens a window that resized for the keyboard by nothing more', () => {
    expect(editorKeyboardInset(320, 24, 296)).toBe(0);
    expect(editorKeyboardInset(320, 24, 400)).toBe(0);
  });

  it('keeps the full height without a keyboard', () => {
    expect(editorKeyboardInset(0, 24, 0)).toBe(0);
  });
});
