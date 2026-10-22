import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module reads its switch once at load, so each case loads it fresh
// with its own react-native mock.
async function load(os: 'ios' | 'android', setting: unknown) {
  vi.resetModules();
  vi.doMock('react-native', () => ({
    Platform: { OS: os },
    Settings: { get: vi.fn(() => setting) },
  }));
  return import('../perf-marks');
}

describe('perf marks', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    log.mockRestore();
    vi.doUnmock('react-native');
  });

  it('logs nothing without the launch argument', async () => {
    const m = await load('ios', undefined);
    m.perfMark('bundle-loaded');
    m.perfStart('open-message');
    m.perfEnd('open-message');
    m.perfOnce('inbox-rendered');
    expect(m.perfMarksEnabled()).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('stays off on Android even when the setting is there', async () => {
    const m = await load('android', 'YES');
    m.perfMark('bundle-loaded');
    expect(log).not.toHaveBeenCalled();
  });

  it('logs marks and span durations with -perfMarks YES', async () => {
    const m = await load('ios', 'YES');
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    m.perfStart('open-message');
    vi.setSystemTime(1_250);
    m.perfEnd('open-message', { id: 'x' });
    vi.useRealTimers();
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line.startsWith('[perf] ')).toBe(true);
    expect(JSON.parse(line.slice(7))).toEqual({ n: 'open-message', t: 1_250, ms: 250, id: 'x' });
  });

  it('logs a once-mark only once and ignores an end without a start', async () => {
    const m = await load('ios', true);
    m.perfOnce('inbox-rendered', { rows: 3 });
    m.perfOnce('inbox-rendered', { rows: 9 });
    m.perfEnd('never-started');
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('"rows":3');
  });
});
