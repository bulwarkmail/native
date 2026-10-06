import { describe, it, expect, vi, beforeEach } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';

const alertSpy = vi.fn();
vi.mock('react-native', () => ({ Alert: { alert: (...a: unknown[]) => alertSpy(...a) } }));
const auth = { logout: vi.fn(async () => {}), logoutAll: vi.fn(async () => {}), removeAccount: vi.fn(async () => {}) };
vi.mock('../../stores/auth-store', () => ({ useAuthStore: { getState: () => auth } }));
vi.mock('../../stores/account-store', () => ({
  useAccountStore: { getState: () => ({ accounts: [{ id: 'a1' }, { id: 'a10' }] }) },
}));
vi.mock('../../stores/locale-store', () => ({
  t: (_k: string, f: string, p?: Record<string, unknown>) => (p ? `${f}|${JSON.stringify(p)}` : f),
}));

import {
  countQueuedSends, countQueuedSendStates, signOutWithGuard, signOutAllWithGuard, removeAccountWithGuard,
} from '../sign-out-guard';

const row = (a: string, id: string) => `webmail:sendqueue:v1:${a}:${id}`;
/** A row as the store writes it (hydrate's validation accepts it). */
const valid = (a: string, id: string, state = 'queued') => JSON.stringify({
  id, appAccountId: a, jmapAccountId: 'j', identityId: 'i', outgoing: { messageId: `${id}@x` }, messageId: `${id}@x`,
  createdAt: '2026-10-04T00:00:00Z', state,
});
/** Seed a valid row in this state. */
const put = (a: string, id: string, state = 'queued') => AsyncStorage.setItem(row(a, id), valid(a, id, state));
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
    await put('a1', 'e1');
    await put('a10', 'e2');
    await put('a10', 'e3');
    expect(await countQueuedSends(['a1', 'a10'])).toEqual([1, 2]);
  });

  it('counts only rows hydrate would load: a corrupt row is not counted', async () => {
    await put('a1', 'e1');
    await AsyncStorage.setItem(row('a1', 'e2'), '{not json');
    await AsyncStorage.setItem(row('a1', 'e3'), JSON.stringify({ state: 'queued' }));
    await AsyncStorage.setItem(row('a1', 'e4'), valid('a1', 'other'));
    expect(await countQueuedSends(['a1'])).toEqual([1]);
  });

  it('a storage error still counts as one: ask rather than risk it', async () => {
    vi.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(new Error('io'));
    expect(await countQueuedSends(['a1', 'a10'])).toEqual([1, 1]);
  });
});

describe('countQueuedSendStates', () => {
  it('counts sending rows separately; a corrupt row is not counted', async () => {
    await put('a1', 'e1', 'sending');
    await put('a1', 'e2', 'queued');
    await AsyncStorage.setItem(row('a1', 'e3'), '{not json');
    await AsyncStorage.setItem(row('a1', 'e5'), JSON.stringify({ state: 'sending' }));
    await put('a10', 'e4', 'sending');
    expect(await countQueuedSendStates(['a1', 'a10', 'zz'])).toEqual([
      { total: 2, sending: 1 }, { total: 1, sending: 1 }, { total: 0, sending: 0 },
    ]);
  });

  it('only corrupt rows: nothing to ask about', async () => {
    await AsyncStorage.setItem(row('a1', 'e1'), '{not json');
    await signOutWithGuard('a1', vi.fn());
    expect(alertSpy).not.toHaveBeenCalled();
    expect(auth.logout).toHaveBeenCalledWith(undefined);
  });

  it('a storage error still counts as one unsent row', async () => {
    vi.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(new Error('io'));
    expect(await countQueuedSendStates(['a1'])).toEqual([{ total: 1, sending: 0 }]);
  });
});

describe('sign-out prompt while a message is being sent', () => {
  it('says a message may still go out, and counts only the others as unsent', async () => {
    await put('a1', 'e1', 'sending');
    await put('a1', 'e2', 'failed');
    const p = signOutWithGuard('a1', vi.fn());
    await press('Cancel');
    await p;
    const message = String(alertSpy.mock.calls[0][1]);
    expect(message).toContain('A message is being sent and may still go out.');
    expect(message).toContain('"count":1');
  });

  it('only sending: no unsent-messages count, just the sending warning', async () => {
    await put('a1', 'e1', 'sending');
    const p = signOutWithGuard('a1', vi.fn());
    await press('Sign out');
    await p;
    const message = String(alertSpy.mock.calls[0][1]);
    expect(message).toBe('A message is being sent and may still go out.');
    expect(auth.logout).toHaveBeenCalledWith({ discardQueuedSends: true });
  });
});

describe('guards', () => {
  it('sign out with nothing queued: no prompt, no discard option', async () => {
    await signOutWithGuard('a1', vi.fn());
    expect(alertSpy).not.toHaveBeenCalled();
    expect(auth.logout).toHaveBeenCalledWith(undefined);
  });

  it('sign out with queued sends: discards only after Sign out', async () => {
    await put('a1', 'e1');
    const p = signOutWithGuard('a1', vi.fn());
    await press('Sign out');
    await p;
    expect(auth.logout).toHaveBeenCalledWith({ discardQueuedSends: true });
  });

  it('Cancel and Open Outbox do not sign out', async () => {
    await put('a1', 'e1');
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
    await put('a10', 'e1');
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

    await put('a1', 'e1');
    alertSpy.mockClear();
    p = removeAccountWithGuard('a1', vi.fn(), prompt);
    await press('Remove');
    await p;
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(String(alertSpy.mock.calls[0][1])).toContain('Remove x');
    expect(auth.removeAccount).toHaveBeenLastCalledWith('a1', { discardQueuedSends: true });
  });
});
