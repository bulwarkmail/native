import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #125: a day opened from the month grid offers the way back to the month,
// in the header and on Android's back. No React Native renderer in the test
// env, so this checks the wiring.

const src = fs.readFileSync(path.resolve(__dirname, '..', 'CalendarScreen.tsx'), 'utf8');

describe('calendar back to month wiring', () => {
  it('remembers that the day was opened from the month grid', () => {
    expect(src).toMatch(/const openDay = React\.useCallback\(\(date: Date\) => \{\s+setReturnToMonth\(viewMode === 'month'\);/);
  });

  it('forgets it when the view is changed another way', () => {
    expect(src).toMatch(/\(mode: ViewMode\) => \{\s+setReturnToMonth\(false\);\s+if \(mode === viewMode\) return;/);
    expect(src).toMatch(/setSelectedDate\(date\);\s+setReturnToMonth\(false\);/);
  });

  it('shows the back button in the menu\'s place and handles Android back, only in Day view', () => {
    expect(src).toMatch(/const showBackToMonth = returnToMonth && viewMode === 'day';/);
    expect(src).toMatch(/useBackWhileFocused\(showBackToMonth, backToMonth\);/);
    expect(src).toMatch(/\{showBackToMonth \? \(\s+<Pressable\s+onPress=\{backToMonth\}/);
    expect(src).toMatch(/accessibilityLabel=\{t\('calendar\.back_to_month', 'Back to month'\)\}/);
  });
});
