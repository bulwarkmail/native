// When the unified inbox has to reload page 1 of every account on focus.
//
// Every focus used to reload, so opening a message and going back cost one
// Email/query per account even when nothing had changed. A reload is now due
// only when something may have changed since the last load:
//
// - the view's inputs (accounts, role, search) or the active account changed;
// - the live session reported an Email state change (push or poll), which
//   covers a message read, deleted or moved on the thread screen;
// - a message that was unread when opened (the thread screen marks it read);
// - the app went to the background (the event stream is closed there, so
//   changes are missed);
// - accounts without a live session are on screen (nothing pushes their
//   changes) and the last load is older than a minute.
//
// The echo of an action taken just before returning (archive or delete from
// the thread screen pops back at once) can land after the focus; a change that
// arrives within a few seconds of a focus that skipped the reload reloads then.

export const DETACHED_RELOAD_AFTER_MS = 60_000;
export const LATE_ECHO_WINDOW_MS = 5_000;

export interface UnifiedReloadTracker {
  /** A load of `inputs` started (called before the request goes out). */
  loaded(inputs: readonly unknown[], activeAccountId: string | null, hasDetachedAccounts: boolean): void;
  /** The view gained focus; returns whether it has to reload. */
  focus(inputs: readonly unknown[], activeAccountId: string | null): boolean;
  blur(): void;
  /** Something may have changed; the next focus reloads. */
  markStale(): void;
  /** An Email state change arrived; returns whether to reload right now. */
  changeArrived(): boolean;
}

function sameInputs(a: readonly unknown[] | null, b: readonly unknown[]): boolean {
  return !!a && a.length === b.length && a.every((v, i) => v === b[i]);
}

export function createUnifiedReloadTracker(now: () => number = Date.now): UnifiedReloadTracker {
  let inputs: readonly unknown[] | null = null;
  let loadedAt = 0;
  let loadedFor: string | null = null;
  let detached = false;
  let stale = true;
  let focused = false;
  let skippedAt = -Infinity;

  return {
    loaded(next, activeAccountId, hasDetachedAccounts) {
      inputs = next;
      loadedAt = now();
      loadedFor = activeAccountId;
      detached = hasDetachedAccounts;
      stale = false;
    },
    focus(next, activeAccountId) {
      focused = true;
      const reload =
        stale ||
        !sameInputs(inputs, next) ||
        activeAccountId !== loadedFor ||
        (detached && now() - loadedAt >= DETACHED_RELOAD_AFTER_MS);
      skippedAt = reload ? -Infinity : now();
      return reload;
    },
    blur() {
      focused = false;
    },
    markStale() {
      stale = true;
    },
    changeArrived() {
      stale = true;
      return focused && now() - skippedAt <= LATE_ECHO_WINDOW_MS;
    },
  };
}
