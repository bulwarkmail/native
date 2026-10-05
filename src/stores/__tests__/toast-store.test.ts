import { describe, it, expect, beforeEach, vi } from 'vitest';
import { toast, useToastStore } from '../toast-store';

describe('toast store actions', () => {
  beforeEach(() => useToastStore.getState().clearToasts());

  it('keeps an optional secondary action beside the first', () => {
    const onPress = vi.fn();
    const second = vi.fn();
    toast.success('Saved', {
      action: { label: 'Undo', onPress },
      secondaryAction: { label: 'Apply', onPress: second },
      duration: 12_000,
    });
    const [entry] = useToastStore.getState().toasts;
    expect(entry.action?.label).toBe('Undo');
    expect(entry.secondaryAction?.label).toBe('Apply');
    expect(entry.duration).toBe(12_000);
    entry.secondaryAction!.onPress();
    expect(second).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('leaves existing callers unchanged', () => {
    toast.error('Failed', 'why');
    toast.info('Hi', { action: { label: 'Go', onPress: () => {} } });
    const [error, info] = useToastStore.getState().toasts;
    expect(error).toMatchObject({ type: 'error', message: 'why', duration: 10_000 });
    expect(error.secondaryAction).toBeUndefined();
    expect(info.action?.label).toBe('Go');
    expect(info.secondaryAction).toBeUndefined();
  });
});
