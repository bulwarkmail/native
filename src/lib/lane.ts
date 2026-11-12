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
