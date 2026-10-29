import { describe, it, expect, vi } from 'vitest';

const alert = vi.fn();
vi.mock('react-native', () => ({ Alert: { alert: (...a: unknown[]) => alert(...a) } }));

import { confirmSignOut } from '../sign-out-confirm';

const t = (_key: string, fallback: string, params?: Record<string, string | number>) =>
  fallback.replace(/\{(\w+)\}/g, (_, k) => String(params?.[k] ?? ''));

describe('confirmSignOut', () => {
  it('asks first and signs out only from the destructive button', () => {
    const onConfirm = vi.fn();
    confirmSignOut(t, { account: 'usera@example.org' }, onConfirm);
    expect(onConfirm).not.toHaveBeenCalled();
    const [title, , buttons] = alert.mock.calls[0] as [string, string, Array<{ style?: string; onPress?: () => void }>];
    expect(title).toBe('Sign out of usera@example.org?');
    buttons.find((b) => b.style === 'cancel')?.onPress?.();
    expect(onConfirm).not.toHaveBeenCalled();
    buttons.find((b) => b.style === 'destructive')!.onPress!();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
