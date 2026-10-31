import { describe, expect, it } from 'vitest';
import { autoAssignSharedCalendarColors, sharedCalendarColorKey } from '../calendar-utils';

describe('autoAssignSharedCalendarColors (#1414)', () => {
  const own = { id: 'c1', color: '#3b82f6' };
  const coloured = { id: 'b:c2', originalId: 'c2', accountId: 'b', isShared: true, color: '#10b981' };
  const plain = { id: 'b:c3', originalId: 'c3', accountId: 'b', isShared: true };

  it('keeps the server colour of a shared calendar and colours only one without', () => {
    const assigned = autoAssignSharedCalendarColors([own, coloured, plain], {});
    expect(Object.keys(assigned)).toEqual([sharedCalendarColorKey(plain)]);
    const color = assigned[sharedCalendarColorKey(plain)].toLowerCase();
    expect(['#3b82f6', '#10b981']).not.toContain(color);
  });

  it('leaves a calendar the viewer coloured alone', () => {
    expect(autoAssignSharedCalendarColors([plain], { [sharedCalendarColorKey(plain)]: '#ef4444' })).toEqual({});
  });
});
