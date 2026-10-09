import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sessionRetryAction,
  nextSessionRetryDelay,
  shouldRetrySession,
  singleFlightByKey,
  coalesceByKey,
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
  const base = { isAuthenticated: true, hasSession: false, connected: true, isLoading: false, appActive: true };
  it('retries only when signed in, without a session, with an interface, and nothing else loading', () => {
    expect(shouldRetrySession(base)).toBe(true);
    expect(shouldRetrySession({ ...base, isAuthenticated: false })).toBe(false);
    expect(shouldRetrySession({ ...base, hasSession: true })).toBe(false);
    expect(shouldRetrySession({ ...base, connected: false })).toBe(false);
    expect(shouldRetrySession({ ...base, isLoading: true })).toBe(false);
    expect(shouldRetrySession({ ...base, appActive: false })).toBe(false);
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

describe('coalesceByKey', () => {
  // A caller that joins mid-flight may need what changed after that run
  // started (a session fetched before the new owner shared): it gets one
  // more run, shared by everyone who joined.
  it('runs once more after the attempt in flight for callers that joined it', async () => {
    const resolvers: Array<(v: number) => void> = [];
    const fn = vi.fn(() => new Promise<number>((r) => { resolvers.push(r); }));
    const run = coalesceByKey(fn);
    const first = run('k');
    const joined = [run('k'), run('k')];
    expect(fn).toHaveBeenCalledTimes(1);
    resolvers[0](1);
    expect(await first).toBe(1);
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    // A caller during the re-run joins it, and queues one more after it.
    const late = run('k');
    resolvers[1](2);
    expect(await joined[0]).toBe(2);
    expect(await joined[1]).toBe(2);
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(3));
    resolvers[2](3);
    expect(await late).toBe(3);
    // Settled: the next call starts afresh, with no re-run.
    void run('k');
    expect(fn).toHaveBeenCalledTimes(4);
    resolvers[3](4);
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('re-runs after a rejection too, and starts another key on its own', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3);
    const run = coalesceByKey(fn as (k: string) => Promise<number>);
    const first = run('k');
    const joined = run('k');
    await expect(first).rejects.toThrow('x');
    await expect(joined).resolves.toBe(2);
    await expect(run('other')).resolves.toBe(3);
  });

  it('keeps one key\'s flight while another key runs', async () => {
    const resolvers: Record<string, Array<(v: number) => void>> = { a: [], b: [] };
    const fn = vi.fn((k: string) => new Promise<number>((r) => { resolvers[k].push(r); }));
    const run = coalesceByKey(fn);
    const a1 = run('a'); void run('b'); const a2 = run('a');
    expect(fn.mock.calls.map(([k]) => k)).toEqual(['a', 'b']);   // a2 joined a1, no second 'a' yet
    resolvers.a[0](1); expect(await a1).toBe(1);
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(3));  // a2's one re-run
    resolvers.a[1](2); expect(await a2).toBe(2);
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

describe('sessionRetryAction', () => {
  const net = { online: false, prevOnline: false, connected: true, prevConnected: true };
  it('kicks on an online edge and on the foreground, pokes on an interface or auth change', () => {
    expect(sessionRetryAction({ kind: 'network', ...net, online: true })).toBe('kick');
    expect(sessionRetryAction({ kind: 'network', ...net, connected: false })).toBe('poke');
    expect(sessionRetryAction({ kind: 'network', ...net })).toBe('none');
    expect(sessionRetryAction({ kind: 'auth', sessionChanged: true, loadingChanged: false })).toBe('poke');
    expect(sessionRetryAction({ kind: 'auth', sessionChanged: false, loadingChanged: true })).toBe('poke');
    expect(sessionRetryAction({ kind: 'auth', sessionChanged: false, loadingChanged: false })).toBe('none');
    expect(sessionRetryAction({ kind: 'appState', active: true })).toBe('kick');
    expect(sessionRetryAction({ kind: 'appState', active: false })).toBe('none');
  });

  it('an online edge during an account switch starts no load (I-2)', async () => {
    const auth = { isAuthenticated: true, session: null as object | null, isLoading: true };
    const retry = vi.fn(async () => true);
    const retrier = startSessionRetry({
      shouldRetry: () => shouldRetrySession({
        isAuthenticated: auth.isAuthenticated, hasSession: auth.session != null,
        connected: true, isLoading: auth.isLoading, appActive: true,
      }),
      retry,
    });
    // The switch's own session fetch answers and flips `online` on.
    const action = sessionRetryAction({ kind: 'network', online: true, prevOnline: false, connected: true, prevConnected: true });
    expect(action).toBe('kick');
    retrier.kick();
    await Promise.resolve();
    expect(retry).not.toHaveBeenCalled();
    retrier.stop();
  });

  it('pauses in the background and resumes on the foreground kick (M-1)', async () => {
    vi.useFakeTimers();
    try {
      let appActive = true;
      const retry = vi.fn(async () => false);
      const retrier = startSessionRetry({
        shouldRetry: () => shouldRetrySession({ isAuthenticated: true, hasSession: false, connected: true, isLoading: false, appActive }),
        retry,
      });
      retrier.poke();
      appActive = false;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(retry).not.toHaveBeenCalled();
      appActive = true;
      if (sessionRetryAction({ kind: 'appState', active: true }) === 'kick') retrier.kick();
      await vi.advanceTimersByTimeAsync(0);
      expect(retry).toHaveBeenCalledTimes(1);
      retrier.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

