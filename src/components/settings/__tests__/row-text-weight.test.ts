import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// With Android's "Bold text" setting on, the Settings list showed "Shari…",
// "Notificatio…" and "Layo…": a Text that names no fontWeight is drawn bolder
// than React Native measured it, so a title sized to its own text lost its
// last letters. Text with an explicit weight is drawn as measured.

const read = (...parts: string[]) => fs.readFileSync(path.resolve(__dirname, '..', '..', ...parts), 'utf8');

describe('the text of a Settings list row', () => {
  it('names its weight for the title and the value', () => {
    const src = read('settings', 'settings-section.tsx');
    expect(src).toMatch(/rowTitle: \{[^}]*fontWeight: '400'[^}]*\}/);
    expect(src).toMatch(/rowValue: \{[^}]*fontWeight: '400'[^}]*\}/);
  });

  it('names its weight for the badge after the title', () => {
    expect(read('Badge.tsx')).toMatch(/\btext: \{[^}]*fontWeight: '400'[^}]*\}/);
  });
});
