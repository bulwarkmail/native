import { describe, it, expect, vi } from 'vitest';
import { createDepartures } from '../departures';

const rows = [{ k: 'a' }, { k: 'b' }, { k: 'c' }];
const keyOf = (r: { k: string }) => r.k;

describe('departing rows', () => {
  it('hides a row the moment its action starts', () => {
    const d = createDepartures(() => {});
    d.depart('b', new Promise(() => {}), () => true);
    expect(d.visible(rows, keyOf).map(keyOf)).toEqual(['a', 'c']);
  });

  it('forgets a row once the action has taken it out of the list', async () => {
    const d = createDepartures(() => {});
    let listed = true;
    const done = Promise.resolve().then(() => { listed = false; });
    d.depart('b', done, () => listed);
    await done;
    await Promise.resolve();
    expect(d.visible(rows, keyOf).map(keyOf)).toEqual(['a', 'b', 'c']);
    expect(d.isDeparting('b')).toBe(false);
  });

  it('brings a row back when the action fails', async () => {
    const onChange = vi.fn();
    const d = createDepartures(onChange);
    const failed = Promise.reject(new Error('offline'));
    d.depart('b', failed, () => true);
    await failed.catch(() => {});
    await Promise.resolve();
    expect(d.visible(rows, keyOf).map(keyOf)).toEqual(['a', 'b', 'c']);
    expect(d.returned('b')).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('brings a row back when the action ends but the row is still listed (a cancelled confirm)', async () => {
    const d = createDepartures(() => {});
    const cancelled = Promise.resolve(undefined);
    d.depart('b', cancelled, () => true);
    await cancelled;
    await Promise.resolve();
    expect(d.visible(rows, keyOf).map(keyOf)).toEqual(['a', 'b', 'c']);
    expect(d.returned('b')).toBe(true);
  });

  it('keeps a row hidden for the latest of two quick departures', async () => {
    const d = createDepartures(() => {});
    let finishFirst!: () => void;
    const first = new Promise<void>((r) => { finishFirst = r; });
    d.depart('b', first, () => true);
    d.depart('b', new Promise(() => {}), () => true);
    finishFirst();
    await first;
    await Promise.resolve();
    expect(d.visible(rows, keyOf).map(keyOf)).toEqual(['a', 'c']);
  });
});
