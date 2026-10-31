import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Checked on the source: the suite has no React Native renderer.
const grid = fs.readFileSync(path.resolve(__dirname, '../TimeGridScrollView.tsx'), 'utf8');
const screen = fs.readFileSync(path.resolve(__dirname, '../../../screens/CalendarScreen.tsx'), 'utf8');

describe('the "New event" block a tap on an empty slot leaves', () => {
  it('goes when the grid is told to drop it', () => {
    expect(grid).toMatch(/React\.useEffect\(\(\) => \{\s*setDraft\(null\);\s*\}, \[draftResetKey\]\);/);
  });

  it('is dropped when the editor opens or closes and when the user leaves the tab', () => {
    const grids = screen.slice(screen.indexOf('<TimeGridScrollView'), screen.indexOf('/>', screen.indexOf('<TimeGridScrollView')));
    expect(grids).toMatch(/draftResetKey=\{slotDraftReset\}/);
    expect(screen).toMatch(/React\.useEffect\(\(\) => \{\s*setSlotDraftReset\(\(n\) => n \+ 1\);\s*\}, \[modalVisible\]\);/);
    // The focus effect's cleanup runs on blur.
    expect(screen).toMatch(/useFocusEffect\(\s*React\.useCallback\(\(\) => \(\) => setSlotDraftReset\(\(n\) => n \+ 1\), \[\]\),?\s*\)/);
  });
});
