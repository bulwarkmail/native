import { describe, it, expect } from 'vitest';
import { applyKeywordPatch, revertKeywordPatch } from '../keyword-patch';

describe('applyKeywordPatch', () => {
  it('sets and clears only the keywords the patch names', () => {
    const before = { $seen: true, $flagged: true, '$label:work': true };
    expect(applyKeywordPatch(before, { $seen: null, $pinned: true, $flagged: false })).toEqual({
      '$label:work': true,
      $pinned: true,
    });
    expect(before).toEqual({ $seen: true, $flagged: true, '$label:work': true });
  });

  it('starts from nothing when the message has no keywords yet', () => {
    expect(applyKeywordPatch(undefined, { $seen: true })).toEqual({ $seen: true });
  });
});

describe('revertKeywordPatch', () => {
  it('restores each touched keyword to its original value and nothing else', () => {
    expect(revertKeywordPatch(
      { $junk: true, $notjunk: null, $seen: true },
      { $notjunk: true, $flagged: true },
    )).toEqual({ $junk: null, $notjunk: true, $seen: null });
  });
});
