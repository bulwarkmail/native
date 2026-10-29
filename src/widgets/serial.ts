// One lane for everything that reads and writes the stored widget data or
// redraws the widgets. Each widget event (every tap, every periodic update)
// runs as its own headless task in the same JS runtime, and they interleave
// at every await; without this, two taps load the same snapshot and the
// second save drops the first change, and a redraw of an older snapshot can
// land after a newer one, leaving buttons that act on a message the widget
// no longer shows.

let tail: Promise<unknown> = Promise.resolve();

/** Run `fn` after everything queued before it has finished. */
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}
