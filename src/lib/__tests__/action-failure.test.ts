import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/toast-store', () => ({
  toast: { error: vi.fn() },
}));

import { toast } from '../../stores/toast-store';
import { reportActionFailure, withFailureToast } from '../action-failure';

const toastError = toast.error as unknown as ReturnType<typeof vi.fn>;

describe('withFailureToast', () => {
  beforeEach(() => {
    toastError.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('reports a rejected action once', async () => {
    const out = await withFailureToast(Promise.reject(new Error('nope')), 'Failed');
    expect(out).toBeUndefined();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('Failed', 'nope');
  });

  it('an action dropped after an account switch (StaleLoadError) shows no toast', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const stale = new Error('Superseded by a newer account load');
    stale.name = 'StaleLoadError';
    await withFailureToast(Promise.reject(stale), 'Failed');
    reportActionFailure('Failed', stale);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('a queued action shows no toast', async () => {
    const out = await withFailureToast(Promise.resolve({ queued: true }), 'Failed');
    expect(out).toEqual({ queued: true });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('never rejects', async () => {
    await expect(withFailureToast(Promise.reject('plain string'), 'Failed')).resolves.toBeUndefined();
    expect(toastError).toHaveBeenCalledWith('Failed', undefined);
  });
});

describe('reportActionFailure', () => {
  it('toasts the title with the error message', () => {
    toastError.mockClear();
    reportActionFailure('Failed', new Error('boom'));
    expect(toastError).toHaveBeenCalledWith('Failed', 'boom');
  });
});
