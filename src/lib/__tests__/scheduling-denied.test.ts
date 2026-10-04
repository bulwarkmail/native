import { describe, it, expect, vi } from 'vitest';
import { saveWithSchedulingFallback } from '../scheduling-denied';
import { SchedulingDeniedError } from '../../api/jmap-result';

describe('saveWithSchedulingFallback', () => {
  it('retries without invitations when the user agrees', async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new SchedulingDeniedError('Not allowed'))
      .mockResolvedValueOnce(undefined);
    const confirm = vi.fn().mockResolvedValue(true);
    await expect(saveWithSchedulingFallback(save, true, confirm)).resolves.toBe('saved_without_invitations');
    expect(confirm).toHaveBeenCalledWith('Not allowed');
    expect(save).toHaveBeenNthCalledWith(1, true);
    expect(save).toHaveBeenNthCalledWith(2, false);
  });

  it('stops when the user declines', async () => {
    const save = vi.fn().mockRejectedValue(new SchedulingDeniedError('no'));
    await expect(saveWithSchedulingFallback(save, true, async () => false)).resolves.toBe('cancelled');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('saves normally when nothing is refused', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.fn();
    await expect(saveWithSchedulingFallback(save, true, confirm)).resolves.toBe('saved');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('rethrows other errors', async () => {
    const boom = new Error('boom');
    const confirm = vi.fn();
    await expect(saveWithSchedulingFallback(async () => { throw boom; }, true, confirm)).rejects.toBe(boom);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does not ask when invitations were not being sent', async () => {
    const denied = new SchedulingDeniedError('no');
    const confirm = vi.fn();
    for (const send of [false, undefined]) {
      await expect(saveWithSchedulingFallback(async () => { throw denied; }, send, confirm)).rejects.toBe(denied);
    }
    expect(confirm).not.toHaveBeenCalled();
  });
});
