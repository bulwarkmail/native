import { describe, it, expect, beforeEach, vi } from 'vitest';

const { clearRefreshBackoff } = vi.hoisted(() => ({ clearRefreshBackoff: vi.fn() }));
vi.mock('../../lib/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/oauth')>()),
  clearRefreshBackoff,
}));

import { SHOW_AFTER_MS, useServerStatusStore } from '../server-status-store';
import { useNetworkStore } from '../network-store';

const report = (accountId: string | null, problem: Parameters<ReturnType<typeof useServerStatusStore.getState>['report']>[1], now: number) =>
  useServerStatusStore.getState().report(accountId, problem, now);

describe('server status store (#167)', () => {
  beforeEach(() => {
    useNetworkStore.setState({ online: true, connected: true });
    useServerStatusStore.setState({ accountId: null, problem: null, since: null, failures: 0, shown: false });
  });

  it('shows after two failures in a row at least 20 s apart, not after one blip', () => {
    report('a', 'unreachable', 0);
    expect(useServerStatusStore.getState().shown).toBe(false);
    report('a', 'unreachable', SHOW_AFTER_MS - 1);
    expect(useServerStatusStore.getState().shown).toBe(false);
    report('a', 'server_error', SHOW_AFTER_MS);
    expect(useServerStatusStore.getState()).toMatchObject({ shown: true, problem: 'server_error', since: 0, failures: 3 });
  });

  it('a request that got an answer clears it', () => {
    report('a', 'unreachable', 0);
    report('a', 'unreachable', SHOW_AFTER_MS);
    report('a', null, SHOW_AFTER_MS + 1);
    expect(useServerStatusStore.getState()).toMatchObject({ shown: false, problem: null, failures: 0 });
    // The next run of failures waits its own 20 s.
    report('a', 'unreachable', SHOW_AFTER_MS + 2);
    report('a', 'unreachable', SHOW_AFTER_MS + 3);
    expect(useServerStatusStore.getState().shown).toBe(false);
  });

  it('keeps a failing sign-in as the problem until something works', () => {
    report('a', 'sign_in_failing', 0);
    report('a', 'unreachable', SHOW_AFTER_MS);
    expect(useServerStatusStore.getState()).toMatchObject({ shown: true, problem: 'sign_in_failing' });
  });

  it('starts over for another account', () => {
    report('a', 'unreachable', 0);
    report('a', 'unreachable', SHOW_AFTER_MS);
    report('b', 'server_error', SHOW_AFTER_MS + 1);
    expect(useServerStatusStore.getState()).toMatchObject({ accountId: 'b', shown: false, failures: 1, problem: 'server_error' });
  });

  it('does not count failures while the phone is offline, and starts over when it is back', () => {
    report('a', 'unreachable', 0);
    useNetworkStore.setState({ online: false, connected: false });
    report('a', 'unreachable', SHOW_AFTER_MS);
    expect(useServerStatusStore.getState()).toMatchObject({ shown: false, failures: 1 });
    useNetworkStore.setState({ online: true, connected: true });
    expect(useServerStatusStore.getState()).toMatchObject({ shown: false, failures: 0, problem: null });
    report('a', 'unreachable', SHOW_AFTER_MS + 1);
    report('a', 'unreachable', SHOW_AFTER_MS + 2);
    expect(useServerStatusStore.getState().shown).toBe(false);
  });

  it('lets the first refresh on a network that came back go out at once', () => {
    clearRefreshBackoff.mockClear();
    useNetworkStore.setState({ online: true, connected: true });
    expect(clearRefreshBackoff).not.toHaveBeenCalled();
    useNetworkStore.setState({ online: false, connected: false });
    expect(clearRefreshBackoff).not.toHaveBeenCalled();
    useNetworkStore.setState({ online: true, connected: true });
    expect(clearRefreshBackoff).toHaveBeenCalledTimes(1);
  });
});
