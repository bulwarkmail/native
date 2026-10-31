import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  LIST_COLUMN_MARGIN, LIST_FAB_CLEARANCE, pushPromptBottom, pushPromptFrame, READER_BAR_CLEARANCE,
} from '../push-prompt-frame';

// On a tablet split view the notification prompt sat in the bottom right
// corner, over the reading pane. Lifted over the Prev / Reply / Forward bar
// it still covered the quick reply's "More options" and Send row (portrait,
// y 2024-2272 of 2560 px). With the mail list on screen it now sits in the
// list column.

const toastFrame = { left: 420, right: 20, bottom: 20 };

describe('push prompt placement', () => {
  it('sits in the list column, clear of the reader, on a split view', () => {
    // An 800 dp portrait tablet: an 80 dp rail, then a 320 dp list column.
    const place = pushPromptFrame({ frame: toastFrame, split: true, windowWidth: 800, listColumn: { x: 80, width: 320 } });
    expect(place).toEqual({ left: 80 + LIST_COLUMN_MARGIN, right: 800 - 400 + LIST_COLUMN_MARGIN, bottom: LIST_FAB_CLEARANCE });
    // Its right edge stays left of where the reader starts.
    expect(800 - place.right).toBeLessThanOrEqual(400);
    // Above the list's compose button.
    expect(place.bottom).toBeGreaterThanOrEqual(16 + 56);
  });

  it('keeps the bottom right corner above a reader bar where no list is on screen', () => {
    expect(pushPromptFrame({ frame: toastFrame, split: true, windowWidth: 800, listColumn: null }))
      .toEqual({ left: 420, right: 20, bottom: 20 + READER_BAR_CLEARANCE });
    expect(pushPromptBottom(20, true)).toBe(20 + READER_BAR_CLEARANCE);
  });

  it('keeps the toast placement above the tab bar on a phone', () => {
    const phone = { left: 12, right: 12, bottom: 64 };
    expect(pushPromptFrame({ frame: phone, split: false, windowWidth: 412, listColumn: { x: 0, width: 412 } })).toEqual(phone);
  });

  it('is what the prompt uses, with the column the mail list reports', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'components/PushOnboardingPrompt.tsx'), 'utf8');
    expect(src).toMatch(/pushPromptFrame\(\{ frame, split: isSplit, windowWidth, listColumn \}\)/);
    expect(src).toMatch(/bottom: insets\.bottom \+ place\.bottom/);
    const list = fs.readFileSync(path.resolve(__dirname, '..', '..', 'screens/EmailListScreen.tsx'), 'utf8');
    expect(list).toMatch(/measureInWindow\(\(x, _y, width\) => setPromptListColumn\(\{ x, width \}\)\)/);
    expect(list).toMatch(/onLayout=\{reportListColumn\}/);
  });
});
