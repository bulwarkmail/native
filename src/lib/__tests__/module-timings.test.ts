import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// scripts/perf/module-timings.js wraps Metro's module definitions and adds
// up each module's own evaluation time, without the time of the modules it
// required while it ran.

function install(clock: { t: number }) {
  const g: Record<string, unknown> = { nativePerformanceNow: () => clock.t };
  const factories = new Map<number, () => void>();
  g.__d = (factory: () => void, id: number) => { factories.set(id, factory); };
  const src = fs.readFileSync(path.resolve(__dirname, '../../../scripts/perf/module-timings.js'), 'utf8');
  new Function('globalThis', src)(g);
  (g.__d as (f: () => void, id: number) => void)(() => { clock.t += 5; }, 2);
  (g.__d as (f: () => void, id: number) => void)(() => {
    clock.t += 10;
    factories.get(2)!();
    clock.t += 3;
  }, 1);
  return { run: (id: number) => factories.get(id)!(), times: () => g.__bulwarkModuleTimes as Record<number, number> };
}

describe('module timings polyfill', () => {
  it('counts a module without the modules it required', () => {
    const clock = { t: 0 };
    const m = install(clock);
    m.run(1);
    expect(m.times()).toEqual({ 1: 13, 2: 5 });
  });
});
