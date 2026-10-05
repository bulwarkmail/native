import { describe, it, expect, vi, beforeEach } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';

const alertSpy = vi.fn();
vi.mock('react-native', () => ({ Alert: { alert: (...a: unknown[]) => alertSpy(...a) } }));
const auth = { logout: vi.fn(async () => {}), logoutAll: vi.fn(async () => {}), removeAccount: vi.fn(async () => {}) };
vi.mock('../../stores/auth-store', () => ({ useAuthStore: { getState: () => auth } }));
vi.mock('../../stores/account-store', () => ({
  useAccountStore: { getState: () => ({ accounts: [{ id: 'a1' }, { id: 'a10' }] }) },
}));
vi.mock('../../stores/locale-store', () => ({ t: (_k: string, f: string) => f }));

import {
  countQueuedSends, signOutWithGuard, signOutAllWithGuard, removeAccountWithGuard,
} from '../sign-out-guard';

const row = (a: string, id: string) => `webmail:sendqueue:v1:${a}:${id}`;
const prompt = { title: 'Remove?', message: 'Remove x', confirmLabel: 'Remove' };
// Press the alert button with this label once the alert is shown.
async function press(label: string) {
  await vi.waitFor(() => expect(alertSpy).toHaveBeenCalled());
  const buttons = alertSpy.mock.calls.at(-1)![2] as { text: string; onPress?: () => void }[];
  buttons.find((b) => b.text === label)!.onPress!();
}

beforeEach(async () => {
  await AsyncStorage.clear();
  alertSpy.mockClear();
  Object.values(auth).forEach((f) => f.mockClear());
});

describe('countQueuedSends', () => {
  it('does not count a1 rows for a10 or the reverse', async () => {
    await AsyncStorage.setItem(row('a1', 'e1'), '{}');
    await AsyncStorage.setItem(row('a10', 'e2'), '{}');
    await AsyncStorage.setItem(row('a10', 'e3'), '{}');
    expect(await countQueuedSends(['a1', 'a10'])).toEqual([1, 2]);
  });
});

describe('guards', () => {
  it('sign out with nothing queued: no prompt, no discard option', async () => {
    await signOutWithGuard('a1', vi.fn());
    expect(alertSpy).not.toHaveBeenCalled();
    expect(auth.logout).toHaveBeenCalledWith(undefined);
  });

  it('sign out with queued sends: discards only after Sign out', async () => {
    await AsyncStorage.setItem(row('a1', 'e1'), '{}');
    const p = signOutWithGuard('a1', vi.fn());
    await press('Sign out');
    await p;
    expect(auth.logout).toHaveBeenCalledWith({ discardQueuedSends: true });
  });

  it('Cancel and Open Outbox do not sign out', async () => {
    await AsyncStorage.setItem(row('a1', 'e1'), '{}');
    const open = vi.fn();
    let p = signOutWithGuard('a1', open);
    await press('Cancel');
    await p;
    alertSpy.mockClear();
    p = signOutWithGuard('a1', open);
    await press('Open Outbox');
    await p;
    expect(open).toHaveBeenCalledTimes(1);
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('sign out of all sums counts across accounts', async () => {
    await AsyncStorage.setItem(row('a10', 'e1'), '{}');
    const p = signOutAllWithGuard(vi.fn());
    await press('Sign out');
    await p;
    expect(String(alertSpy.mock.calls[0][1])).toContain('{count');
    expect(auth.logoutAll).toHaveBeenCalledWith({ discardQueuedSends: true });
  });

  it('remove account: one combined prompt when queued, plain confirm otherwise', async () => {
    let p = removeAccountWithGuard('a1', vi.fn(), prompt);
    await press('Remove');
    await p;
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(auth.removeAccount).toHaveBeenLastCalledWith('a1', undefined);

    await AsyncStorage.setItem(row('a1', 'e1'), '{}');
    alertSpy.mockClear();
    p = removeAccountWithGuard('a1', vi.fn(), prompt);
    await press('Remove');
    await p;
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(String(alertSpy.mock.calls[0][1])).toContain('Remove x');
    expect(auth.removeAccount).toHaveBeenLastCalledWith('a1', { discardQueuedSends: true });
  });
});
