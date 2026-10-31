import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));

import { JMAPSetError } from '../../api/jmap-result';
import { saveOfferingWithoutInvitations, schedulingDeniedReason } from '../calendar-scheduling-denied';

const t = (_k: string, fallback?: string) => fallback ?? '';
// As api/calendar throws Stalwart 0.16.21+'s refusal of the invitations.
const denied = () => new JMAPSetError('forbidden', 'Failed to update event e1: forbidden – Scheduling not allowed');

describe('schedulingDeniedReason', () => {
  it('tells a refusal of the invitations from other failures', () => {
    expect(schedulingDeniedReason(denied(), true)).toBe('Scheduling not allowed');
    expect(schedulingDeniedReason(denied(), false)).toBeNull();
    expect(schedulingDeniedReason(new JMAPSetError('invalidProperties', 'x'), true)).toBeNull();
    expect(schedulingDeniedReason(new Error('offline'), true)).toBeNull();
  });
});

describe('saveOfferingWithoutInvitations', () => {
  it('saves again without the invitations when the user agrees', async () => {
    const save = vi.fn().mockRejectedValueOnce(denied()).mockResolvedValueOnce(undefined);
    const ask = vi.fn().mockResolvedValue(true);
    expect(await saveOfferingWithoutInvitations(save, true, t, ask)).toBe(true);
    expect(save.mock.calls).toEqual([[true], [false]]);
    expect(ask).toHaveBeenCalledWith('Scheduling not allowed', t);
  });

  it('keeps the editor open when the user declines, and passes other errors on', async () => {
    const save = vi.fn().mockRejectedValue(denied());
    expect(await saveOfferingWithoutInvitations(save, true, t, vi.fn().mockResolvedValue(false))).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    const failing = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(saveOfferingWithoutInvitations(failing, true, t, vi.fn())).rejects.toThrow('offline');
  });
});
