import { withFailureToast } from './action-failure';

// A bulk action takes the ids it acts on out of the selection up front, so a
// second tap cannot re-run it, and puts exactly those ids back if it rejects.
// A queued action (offline outbox) resolves and counts as done; only a
// rejected promise is a failure.
export function selectionWithout(selected: ReadonlySet<string>, acted: ReadonlySet<string>): Set<string> {
  return new Set([...selected].filter((id) => !acted.has(id)));
}

// After a failure: re-add the acted-on ids that are still in the list, and
// leave whatever the user selected or deselected meanwhile alone.
export function selectionAfterFailure(
  selected: ReadonlySet<string>,
  acted: ReadonlySet<string>,
  present: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selected);
  for (const id of acted) if (present.has(id)) next.add(id);
  return next;
}

// Runs the action, reports a rejection as a toast, and says whether it resolved.
export async function settled(p: Promise<unknown>, failureTitle: string): Promise<boolean> {
  let ok = true;
  await withFailureToast(p.catch((err) => { ok = false; throw err; }), failureTitle);
  return ok;
}
