import { describe, it, expect } from 'vitest';
import { RequestSlots } from '../request-slots';

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('RequestSlots', () => {
  it('runs at most the limit at once and the rest in order', async () => {
    const slots = new RequestSlots(() => 2);
    const gates = Array.from({ length: 5 }, deferred);
    const started: number[] = [];
    let inFlight = 0;
    let most = 0;
    const runs = gates.map((gate, i) => slots.run(async () => {
      started.push(i);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await gate.promise;
      inFlight -= 1;
      return i;
    }));

    await tick();
    expect(started).toEqual([0, 1]);
    gates[1].resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    gates.forEach((gate) => gate.resolve());

    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4]);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(most).toBe(2);
    expect(slots.running).toBe(0);
  });

  it('frees the slot of a request that failed', async () => {
    const slots = new RequestSlots(() => 1);
    await expect(slots.run(async () => { throw new Error('refused'); })).rejects.toThrow('refused');
    expect(await slots.run(async () => 'next')).toBe('next');
    expect(slots.running).toBe(0);
  });

  it('does not let a newcomer past the line when a slot is handed on', async () => {
    const slots = new RequestSlots(() => 1);
    const first = deferred();
    const order: string[] = [];
    const a = slots.run(async () => { order.push('a'); await first.promise; });
    const b = slots.run(async () => { order.push('b'); expect(slots.running).toBe(1); });
    await tick();
    first.resolve();
    const c = slots.run(async () => { order.push('c'); expect(slots.running).toBe(1); });
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('has no limit without a positive one', async () => {
    for (const limit of [undefined, 0, -1, Number.NaN]) {
      const slots = new RequestSlots(() => limit);
      const gate = deferred();
      const runs = [1, 2, 3, 4, 5, 6].map(() => slots.run(() => gate.promise));
      await tick();
      expect(slots.running).toBe(6);
      gate.resolve();
      await Promise.all(runs);
    }
  });

  it('follows a limit that changes', async () => {
    let limit = 1;
    const slots = new RequestSlots(() => limit);
    const gates = Array.from({ length: 4 }, deferred);
    const runs = gates.map((gate) => slots.run(() => gate.promise));
    await tick();
    expect(slots.running).toBe(1);

    limit = 3;
    gates[0].resolve();
    await tick();
    expect(slots.running).toBe(3);

    limit = 1;
    gates[1].resolve();
    gates[2].resolve();
    await tick();
    expect(slots.running).toBe(1);
    gates[3].resolve();
    await Promise.all(runs);
    expect(slots.running).toBe(0);
  });
});
