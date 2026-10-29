// The widgets' stored data and the edits widget buttons lay over it, read and
// written in one lane (./serial.ts) so headless tasks running side by side
// neither lose each other's changes nor draw an older state over a newer one.

import { serial } from './serial';
import {
  applyPending,
  confirmedBy,
  expire,
  loadPending,
  savePending,
  type PendingChange,
} from './pending';
import { emptySnapshot, loadSnapshot, saveSnapshot, type ActionNotice, type WidgetSnapshot } from './snapshot';

/** The view without queueing; only for code already running in the lane. */
export async function readView(now = Date.now()): Promise<WidgetSnapshot> {
  const [stored, raw] = await Promise.all([loadSnapshot(), loadPending()]);
  const pending = expire(raw, now);
  return { ...applyPending(stored ?? emptySnapshot(), pending.ops), notice: pending.notice ?? null };
}

/** What the widgets draw: the stored snapshot with the buttons' changes laid over it. */
export function currentView(now = Date.now()): Promise<WidgetSnapshot> {
  return serial(() => readView(now));
}

/**
 * Store a refresh that started reading the server at `startedAt`. Changes the
 * server took before that are now in the data and stop being laid over it;
 * later ones and those still in flight stay.
 */
export function storeRefresh(next: WidgetSnapshot, startedAt: number): Promise<void> {
  return serial(async () => {
    await saveSnapshot(next);
    const pending = expire(await loadPending(), Date.now());
    const appData = next.appDataAt >= startedAt;
    await savePending({ ...pending, ops: confirmedBy(pending.ops, startedAt, appData) });
  });
}

/** Replace the data outright (signed out): no change of the old data may linger. */
export function replaceAll(next: WidgetSnapshot): Promise<void> {
  return serial(async () => {
    await saveSnapshot(next);
    await savePending({ ops: [], notice: null });
  });
}

let counter = 0;

/** Lay a button's change over the data until the server has answered. Returns its key. */
export function track(change: PendingChange, now = Date.now()): Promise<string> {
  const key = `${now}-${++counter}`;
  return serial(async () => {
    const pending = expire(await loadPending(), now);
    // A new tap (a retry included) answers whatever the notice was about.
    await savePending({ ops: [...pending.ops, { key, change, at: now }], notice: null });
    return key;
  });
}

/**
 * The server answered. A change it took stays laid over the data until a
 * refresh has caught up with it; one it refused (or that never reached it) is
 * dropped, which shows the data as the server last described it, and
 * `notice` tells the user.
 */
export function settle(key: string, ok: boolean, notice?: ActionNotice, now = Date.now()): Promise<void> {
  return serial(async () => {
    const pending = expire(await loadPending(), now);
    const ops = ok
      ? pending.ops.map((o) => (o.key === key ? { ...o, doneAt: now } : o))
      : pending.ops.filter((o) => o.key !== key);
    await savePending({ ops, notice: !ok && notice ? notice : pending.notice ?? null });
  });
}
