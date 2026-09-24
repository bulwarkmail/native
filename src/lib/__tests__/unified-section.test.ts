import { describe, expect, it } from 'vitest';
import { showUnifiedSection } from '../unified-section';

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
