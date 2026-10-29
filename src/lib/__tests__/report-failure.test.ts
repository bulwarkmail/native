import { describe, it, expect, vi } from 'vitest';

const error = vi.fn();
vi.mock('../../stores/toast-store', () => ({ toast: { error: (...a: unknown[]) => error(...a) } }));
vi.mock('../../stores/locale-store', () => ({
  useLocaleStore: { getState: () => ({ t: (_k: string, fallback: string) => fallback }) },
}));

import { reportFailure } from '../report-failure';

describe('reportFailure', () => {
  it('shows a toast when the action is refused', async () => {
    reportFailure(Promise.reject(new Error('notUpdated: forbidden')));
    await new Promise((r) => setTimeout(r, 0));
    expect(error).toHaveBeenCalledWith('Failed to update email', 'notUpdated: forbidden');
  });

  it('stays quiet when the action works', async () => {
    error.mockClear();
    reportFailure(Promise.resolve());
    await new Promise((r) => setTimeout(r, 0));
    expect(error).not.toHaveBeenCalled();
  });
});
