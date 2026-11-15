import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isHoverPointer, rowHoverActions } from '../row-hover-actions';

describe('row hover actions', () => {
  it('shows the webmail default set in its order', () => {
    expect(rowHoverActions(true)).toEqual(['delete', 'star', 'read', 'archive']);
  });

  it('leaves Archive out where the list cannot archive', () => {
    expect(rowHoverActions(false)).toEqual(['delete', 'star', 'read']);
  });

  it('counts only a mouse as a hovering pointer', () => {
    expect(isHoverPointer('mouse')).toBe(true);
    expect(isHoverPointer('touch')).toBe(false);
    expect(isHoverPointer('pen')).toBe(false);
    expect(isHoverPointer(undefined)).toBe(false);
  });

  // Without the flag Android sends no pointer events to JS and the actions
  // never show; nothing else in the app would notice it going missing.
  it('has W3C pointer events turned on in the Android application', () => {
    const application = readFileSync(
      join(__dirname, '../../../android/app/src/main/java/com/anonymous/bulwarkmobile/MainApplication.kt'),
      'utf8',
    );
    expect(application).toMatch(/^\s*ReactFeatureFlags\.dispatchPointerEvents = true\s*$/m);
  });
});
