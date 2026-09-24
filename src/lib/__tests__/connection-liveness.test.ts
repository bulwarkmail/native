import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startLivenessMonitor, LIVENESS_INTERVAL_MS } from '../connection-liveness';

// PF6: a Core/echo every 30 s on top of the event stream's own pings, and two
// echoes in front of the catch-up sync on every resume.

function setup(overrides: { healthy?: boolean; active?: boolean; online?: boolean; ping?: () => Promise<boolean> } = {}) {
  const state = { healthy: false, active: true, online: true, ...overrides };
  const ping = vi.fn(overrides.ping ?? (async () => true));
  const onConnected = vi.fn();
  const monitor = startLivenessMonitor({
    ping,
    streamHealthy: () => state.healthy,
    isActive: () => state.active,
    isOnline: () => state.online,
    onConnected,
  });
  return { state, ping, onConnected, monitor };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('connection liveness', () => {
  it('sends no echo while the event stream is open', async () => {
    const { ping, onConnected, monitor } = setup({ healthy: true });
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS * 4);
    expect(ping).not.toHaveBeenCalled();
    expect(onConnected).toHaveBeenLastCalledWith(true);
    monitor.stop();
  });

  it('falls back to an echo every 30 s without a stream (polling, reconnecting)', async () => {
    const { ping, monitor } = setup();
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS * 3);
    expect(ping).toHaveBeenCalledTimes(3);
    monitor.stop();
  });

  it('reports a lost connection after two missed echoes', async () => {
    const { onConnected, monitor } = setup({ ping: async () => false });
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);
    expect(onConnected).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS);
    expect(onConnected).toHaveBeenLastCalledWith(false);
    monitor.stop();
  });

  it('pauses in the background and offline', async () => {
    const { state, ping, monitor } = setup({ active: false });
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS * 2);
    state.active = true;
    state.online = false;
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS * 2);
    expect(ping).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('sends one echo on resume, even when the periodic one fires with it', async () => {
    let answer!: (ok: boolean) => void;
    const { ping, monitor } = setup({ ping: () => new Promise<boolean>((r) => { answer = r; }) });
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS - 10);
    // Resume: an on-demand check, then the timer that was due meanwhile.
    const resumed = monitor.check();
    void monitor.check();
    await vi.advanceTimersByTimeAsync(10);
    expect(ping).toHaveBeenCalledTimes(1);
    answer(true);
    await resumed;
    await vi.advanceTimersByTimeAsync(1);
    expect(ping).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it('ignores an answer that lands after it was stopped', async () => {
    let answer!: (ok: boolean) => void;
    const { onConnected, monitor } = setup({ ping: () => new Promise<boolean>((r) => { answer = r; }) });
    const pending = monitor.check();
    monitor.stop();
    answer(false);
    await pending;
    expect(onConnected).not.toHaveBeenCalled();
  });
});
