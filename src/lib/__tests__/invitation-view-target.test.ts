import { describe, it, expect } from 'vitest';
import { invitationViewTarget } from '../invitation-view-target';

describe('invitationViewTarget', () => {
  it('parks only a date, and nothing for another shown account', () => {
    expect(invitationViewTarget(new Date(2026, 9, 9, 15), 'appA', 'appA')).toEqual({ date: '2026-10-09' });
    expect(invitationViewTarget(new Date(2026, 9, 9), 'appA', 'appB')).toBeNull();
  });

  it('parks the day of a late-evening start, not the next one', () => {
    expect(invitationViewTarget(new Date(2026, 0, 31, 23, 30), 'appA', 'appA')).toEqual({ date: '2026-01-31' });
  });

  it('parks nothing without a valid start or a known account', () => {
    expect(invitationViewTarget(null, 'appA', 'appA')).toBeNull();
    expect(invitationViewTarget(new Date('nope'), 'appA', 'appA')).toBeNull();
    expect(invitationViewTarget(new Date(2026, 9, 9), null, null)).toBeNull();
    expect(invitationViewTarget(new Date(2026, 9, 9), 'appA', null)).toBeNull();
  });
});
