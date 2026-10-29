// Timing marks for the performance harness (scripts/e2e/perf.mjs).
//
// Off unless the app was launched with the `-perfMarks YES` launch argument
// (iOS puts launch arguments into NSUserDefaults, which React Native's
// Settings module reads). When on, every mark is one `[perf]` line on the
// console; on iOS that lands in the system log, where the harness reads it
// with `log show --info`. Nothing is stored or sent anywhere.

import { Platform, Settings } from 'react-native';

function readEnabled(): boolean {
  try {
    if (Platform.OS !== 'ios') return false;
    const value = Settings.get('perfMarks') as unknown;
    return value === true || value === 'YES' || value === 'true' || value === 1 || value === '1';
  } catch {
    return false;
  }
}

const enabled = readEnabled();

export function perfMarksEnabled(): boolean {
  return enabled;
}

/** Log a mark with the wall-clock time (the harness compares across processes). */
export function perfMark(name: string, detail?: Record<string, string | number | boolean>): void {
  if (!enabled) return;
  console.log(`[perf] ${JSON.stringify({ n: name, t: Date.now(), ...detail })}`);
}

const started = new Map<string, number>();

/** Start a timed span; `perfEnd` with the same name logs its duration. */
export function perfStart(name: string): void {
  if (!enabled) return;
  started.set(name, Date.now());
}

export function perfEnd(name: string, detail?: Record<string, string | number | boolean>): void {
  if (!enabled) return;
  const t0 = started.get(name);
  if (t0 === undefined) return;
  started.delete(name);
  perfMark(name, { ms: Date.now() - t0, ...detail });
}

/** Log how far into a running span a step got, without ending it. */
export function perfLap(name: string, lap: string): void {
  if (!enabled) return;
  const t0 = started.get(name);
  if (t0 === undefined) return;
  perfMark(`${name}:${lap}`, { ms: Date.now() - t0 });
}

/**
 * End a span once the next frames are drawn: two animation frames after the
 * state change that rendered the result, so the time includes commit and
 * paint, not just the JS render.
 */
export function perfEndAfterPaint(name: string, detail?: Record<string, string | number | boolean>): void {
  if (!enabled || !started.has(name)) return;
  requestAnimationFrame(() => requestAnimationFrame(() => perfEnd(name, detail)));
}

let onceDone = new Set<string>();
/** A mark that is logged once per process (first inbox render, ...). */
export function perfOnce(name: string, detail?: Record<string, string | number | boolean>): void {
  if (!enabled || onceDone.has(name)) return;
  onceDone.add(name);
  perfMark(name, detail);
}

/**
 * The modules whose own evaluation took longest so far, when the bundle was
 * built with BULWARK_MODULE_TIMINGS (scripts/perf/module-timings.js): the
 * 60 slowest as "id:ms" pairs, plus the total. Logged once, at first inbox.
 */
export function logModuleTimes(): void {
  if (!enabled || onceDone.has('module-times')) return;
  const times = (globalThis as { __bulwarkModuleTimes?: Record<string, number> }).__bulwarkModuleTimes;
  if (!times) return;
  onceDone.add('module-times');
  const entries = Object.entries(times);
  const total = entries.reduce((sum, [, ms]) => sum + ms, 0);
  const top = entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60)
    .map(([id, ms]) => `${id}:${Math.round(ms * 10) / 10}`)
    .join(',');
  perfMark('module-times', { total: Math.round(total), count: entries.length, top });
}

/** Test hook. */
export function resetPerfMarks(): void {
  started.clear();
  onceDone = new Set();
}

/**
 * Frame monitor for scrolling: counts animation frames between `start` and
 * `stop` and how many of them took longer than two vsyncs (a visible hitch
 * at 60 Hz). JS-thread frames, so it shows JS work blocking during a scroll.
 */
export function createFrameMonitor(name: string): { start: () => void; stop: () => void } {
  let raf: number | null = null;
  let last = 0;
  let frames = 0;
  let long = 0;
  let worst = 0;
  let t0 = 0;
  const tick = (now: number) => {
    if (last) {
      const dt = now - last;
      frames += 1;
      if (dt > 34) long += 1;
      if (dt > worst) worst = dt;
    }
    last = now;
    raf = requestAnimationFrame(tick);
  };
  return {
    start() {
      if (!enabled || raf !== null) return;
      frames = 0;
      long = 0;
      worst = 0;
      last = 0;
      t0 = Date.now();
      raf = requestAnimationFrame(tick);
    },
    stop() {
      if (raf === null) return;
      cancelAnimationFrame(raf);
      raf = null;
      perfMark(name, { ms: Date.now() - t0, frames, long, worst: Math.round(worst) });
    },
  };
}
