import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  nextSessionRetryDelay,
  shouldRetrySession,
  singleFlightByKey,
  startSessionRetry,
} from '../session-retry';

// A cold start while the LAN server restarts leaves `isAuthenticated: true,
// session: null`. Nothing else retries that, so this keeps trying.

describe('nextSessionRetryDelay', () => {
  it('starts at 5 s and doubles to a 60 s cap', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(nextSessionRetryDelay)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });
});

describe('shouldRetrySession', () => {
  const base = { isAuthenticated: true, hasSession: false, connected: true, isLoading: false };
  it('retries only when signed in, without a session, with an interface, and nothing else loading', () => {
    expect(shouldRetrySession(base)).toBe(true);
    expect(shouldRetrySession({ ...base, isAuthenticated: false })).toBe(false);
    expect(shouldRetrySession({ ...base, hasSession: true })).toBe(false);
    expect(shouldRetrySession({ ...base, connected: false })).toBe(false);
    expect(shouldRetrySession({ ...base, isLoading: true })).toBe(false);
  });
});

describe('singleFlightByKey', () => {
  it('shares one in-flight attempt between concurrent callers for the same key', async () => {
    let resolve!: (v: boolean) => void;
    const fn = vi.fn(() => new Promise<boolean>((r) => { resolve = r; }));
    const run = singleFlightByKey(fn);
    const a = run('acc-1');
    const b = run('acc-1');
    expect(fn).toHaveBeenCalledTimes(1);
    resolve(true);
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    // Settled: the next call starts a new attempt.
    void run('acc-1');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not share an attempt made for another key', () => {
    const fn = vi.fn(() => new Promise<boolean>(() => undefined));
    const run = singleFlightByKey(fn);
    void run('acc-1');
    void run('acc-2');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight attempt after a rejection', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(true);
    const run = singleFlightByKey(fn as () => Promise<boolean>);
    await expect(run('k')).rejects.toThrow('x');
    await expect(run('k')).resolves.toBe(true);
  });
});

describe('startSessionRetry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(initial = true) {
    const state = { want: initial };
    const retry = vi.fn(async () => false);
    const retrier = startSessionRetry({ shouldRetry: () => state.want, retry });
    return { state, retry, retrier };
  }

  it('retries on a backoff of 5, 10, 20, 40, 60, 60 s while it keeps failing', async () => {
    const { retry, retrier } = setup();
    retrier.poke();
    const at: number[] = [];
    retry.mockImplementation(async () => { at.push(Date.now()); return false; });
    const start = Date.now();
    await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000 + 40_000 + 60_000 + 60_000);
    expect(at.map((t) => t - start)).toEqual([5_000, 15_000, 35_000, 75_000, 135_000, 195_000]);
    retrier.stop();
  });

  it('stops once a retry succeeds', async () => {
    const { retry, retrier } = setup();
    retry.mockResolvedValueOnce(true);
    retrier.poke();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(retry).toHaveBeenCalledTimes(1);
    retrier.stop();
  });

  it('does not retry when the conditions no longer hold (session landed, signed out, no interface)', async () => {
    const { state, retry, retrier } = setup();
    retrier.poke();
    state.want = false;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(retry).not.toHaveBeenCalled();
    retrier.stop();
  });

  it('does not schedule while the conditions do not hold, and starts again on a poke once they do', async () => {
    const { state, retry, retrier } = setup(false);
    retrier.poke();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(retry).not.toHaveBeenCalled();
    state.want = true;
    retrier.poke();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(retry).toHaveBeenCalledTimes(1);
    retrier.stop();
  });

  it('a second poke does not stack another timer', async () => {
    const { retry, retrier } = setup();
    retrier.poke();
    retrier.poke();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(retry).toHaveBeenCalledTimes(1);
    retrier.stop();
  });

  it('kick retries at once (app back in the foreground) and keeps the backoff going', async () => {
    const { retry, retrier } = setup();
    retrier.poke();
    await vi.advanceTimersByTimeAsync(1_000);
    retrier.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(retry).toHaveBeenCalledTimes(1);
    // The pending 5 s timer was replaced by the next step (10 s).
    await vi.advanceTimersByTimeAsync(9_999);
    expect(retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(retry).toHaveBeenCalledTimes(2);
    retrier.stop();
  });

  it('kick does nothing when the conditions do not hold', async () => {
    const { retry, retrier } = setup(false);
    retrier.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(retry).not.toHaveBeenCalled();
    retrier.stop();
  });

  it('a kick during an attempt in flight does not start another', async () => {
    const { retry, retrier } = setup();
    let finish!: (v: boolean) => void;
    retry.mockImplementationOnce(() => new Promise<boolean>((r) => { finish = r; }));
    retrier.kick();
    retrier.kick();
    expect(retry).toHaveBeenCalledTimes(1);
    finish(true);
    await vi.advanceTimersByTimeAsync(0);
    retrier.stop();
  });

  it('stop clears the timer and ignores an attempt that settles later', async () => {
    const { retry, retrier } = setup();
    let finish!: (v: boolean) => void;
    retry.mockImplementationOnce(() => new Promise<boolean>((r) => { finish = r; }));
    retrier.kick();
    retrier.stop();
    finish(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats a throwing retry as a failure and keeps going', async () => {
    const { retry, retrier } = setup();
    retry.mockRejectedValueOnce(new Error('boom'));
    retrier.poke();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(retry).toHaveBeenCalledTimes(2);
    retrier.stop();
  });
});
