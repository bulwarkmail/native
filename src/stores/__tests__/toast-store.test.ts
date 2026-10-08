import { describe, it, expect, beforeEach, vi } from 'vitest';
import { freeToastSlots, toast, useToastStore } from '../toast-store';

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

describe('freeToastSlots', () => {
  const entry = (type: string, action = false) => ({
    id: Math.random().toString(36), type, title: 'x', duration: 5000, createdAt: 0,
    ...(action ? { action: { label: 'Undo', onPress: () => undefined } } : {}),
  }) as never;

  it('leaves the newest three free when nothing must stay', () => {
    expect(freeToastSlots([])).toBe(3);
    expect(freeToastSlots([entry('info'), entry('success')])).toBe(3);
  });

  it('keeps everything from the oldest Undo or error inside the three slots', () => {
    expect(freeToastSlots([entry('info', true)])).toBe(2);
    expect(freeToastSlots([entry('info', true), entry('info')])).toBe(1);
    expect(freeToastSlots([entry('info'), entry('error')])).toBe(2);
    expect(freeToastSlots([entry('error'), entry('info', true), entry('info')])).toBe(0);
  });
});
