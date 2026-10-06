// A delayed action on one account's mail (the viewer's mark-read delay). An
// account switch can happen while it waits: the app then shows another
// account, whose message with the same id is a different one, so the action
// must not fire there.

/** What the app shows: the email store, or a stand-in in tests. */
export interface ShownAccountSource {
  getState(): { activeAccountId: string | null };
  subscribe(listener: (state: { activeAccountId: string | null }) => void): () => void;
}

/**
 * Run `run` after `delayMs` (at once for 0) while `source` shows app account
 * `appAccountId`. Cancelled as soon as the app shows another account, and
 * skipped if it fires (or would run at once) while another is shown. Returns
 * a cancel function.
 */
export function runWhileAccountShown(
  source: ShownAccountSource,
  appAccountId: string | undefined,
  delayMs: number,
  run: () => void,
): () => void {
  const shown = () => !!appAccountId && source.getState().activeAccountId === appAccountId;
  if (!shown()) return () => undefined;
  if (delayMs <= 0) {
    run();
    return () => undefined;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    unsubscribe?.();
    unsubscribe = null;
  };
  unsubscribe = source.subscribe((state) => {
    if (state.activeAccountId !== appAccountId) cancel();
  });
  timer = setTimeout(() => {
    timer = null;
    const ok = shown();
    cancel();
    if (ok) run();
  }, delayMs);
  return cancel;
}
