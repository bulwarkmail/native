import { withFailureToast } from './action-failure';

// A bulk action clears the selection only when it worked, so a failure leaves
// the ids in place for a retry. A queued action (offline outbox) resolves and
// counts as done; only a rejected promise is a failure.
export function selectionAfter(ok: boolean, selected: ReadonlySet<string>): ReadonlySet<string> {
  return ok ? new Set<string>() : selected;
}

// Runs the action, reports a rejection as a toast, and says whether it resolved.
export async function settled(p: Promise<unknown>, failureTitle: string): Promise<boolean> {
  let ok = true;
  await withFailureToast(p.catch((err) => { ok = false; throw err; }), failureTitle);
  return ok;
}
