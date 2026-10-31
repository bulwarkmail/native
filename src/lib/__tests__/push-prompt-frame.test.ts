import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pushPromptBottom, READER_BAR_CLEARANCE } from '../push-prompt-frame';

// On a tablet split view the notification prompt sat in the bottom right
// corner, over the reading pane's Prev / Reply / Forward bar, until it was
// dismissed.

describe('push prompt placement', () => {
  it('sits above the reading pane bar on a split view', () => {
    expect(pushPromptBottom(20, true)).toBe(20 + READER_BAR_CLEARANCE);
    expect(READER_BAR_CLEARANCE).toBeGreaterThanOrEqual(64);
  });

  it('keeps the toast placement above the tab bar on a phone', () => {
    expect(pushPromptBottom(64, false)).toBe(64);
  });

  it('is what the prompt uses', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'components/PushOnboardingPrompt.tsx'), 'utf8');
    expect(src).toMatch(/bottom: insets\.bottom \+ pushPromptBottom\(frame\.bottom, isSplit\)/);
  });
});
