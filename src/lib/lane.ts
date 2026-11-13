/**
 * A lane: each call runs its `fn` after everything queued on the same lane
 * before it has finished, whether that succeeded or failed.
 */
export function makeLane(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * One lane per key: calls with the same key run one after another, calls with
 * different keys do not wait for each other. A key's lane is kept once used.
 */
export function makeKeyedLane(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const lanes = new Map<string, ReturnType<typeof makeLane>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    let lane = lanes.get(key);
    if (!lane) {
      lane = makeLane();
      lanes.set(key, lane);
    }
    return lane(fn);
  };
}
