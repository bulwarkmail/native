import { describe, expect, it } from 'vitest';
import { showUnifiedSection, visibleCrossViews } from '../unified-section';

const base = { accountCount: 1, unifiedCrossAccount: false, includeGroupInUnified: true, hasSharedInbox: false };

describe('showUnifiedSection (#843)', () => {
  it('hides it for a second account while cross-account is off', () => {
    expect(showUnifiedSection({ ...base, accountCount: 2 })).toBe(false);
  });

  it('shows it once cross-account is on with several accounts', () => {
    expect(showUnifiedSection({ ...base, accountCount: 2, unifiedCrossAccount: true })).toBe(true);
    // Cross-account with a single account has nothing to merge.
    expect(showUnifiedSection({ ...base, unifiedCrossAccount: true })).toBe(false);
  });

  it('shows it for group inboxes only when they are merged in', () => {
    expect(showUnifiedSection({ ...base, hasSharedInbox: true })).toBe(true);
    expect(showUnifiedSection({ ...base, hasSharedInbox: true, includeGroupInUnified: false })).toBe(false);
  });
});

const off = { showUnified: false, enableCrossUnreadView: false, enableCrossStarredView: false, enableCrossAllView: false };

describe('visibleCrossViews', () => {
  it('lists none for a single account until one is turned on', () => {
    expect(visibleCrossViews(off)).toEqual([]);
  });

  it('lists the turned-on views for a single account, in drawer order', () => {
    expect(visibleCrossViews({ ...off, enableCrossAllView: true })).toEqual(['all']);
    expect(visibleCrossViews({ ...off, enableCrossStarredView: true })).toEqual(['starred']);
    expect(visibleCrossViews({ ...off, enableCrossAllView: true, enableCrossUnreadView: true })).toEqual(['unread', 'all']);
  });

  it('keeps all three alongside the unified section, whatever the toggles', () => {
    expect(visibleCrossViews({ ...off, showUnified: true })).toEqual(['unread', 'starred', 'all']);
  });
});
