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

/**
 * A list selection and the app account it was made in. Row keys repeat across
 * accounts (on Stalwart, ids are sequential per account), so a selection is
 * never carried into another account: there it would name other messages.
 */
export interface AccountSelection {
  readonly accountId: string | null;
  readonly ids: ReadonlySet<string>;
}

const NOTHING: ReadonlySet<string> = new Set();

/** The ids selected while `accountId` is shown: none once the account changed. */
export function selectionIn(selection: AccountSelection, accountId: string | null): ReadonlySet<string> {
  return selection.accountId === accountId ? selection.ids : NOTHING;
}

/** `selection` set (or updated from what `accountId` shows) in account `accountId`. */
export function updateSelection(
  selection: AccountSelection,
  accountId: string | null,
  next: ReadonlySet<string> | ((prev: ReadonlySet<string>) => ReadonlySet<string>),
): AccountSelection {
  const ids = typeof next === 'function' ? next(selectionIn(selection, accountId)) : next;
  return { accountId, ids };
}

/**
 * After a bulk action made in `actedIn` failed: `selectionAfterFailure`, but
 * only while that account is still shown (`shownNow`). Once the user switched,
 * the acted-on keys are another account's rows and are not re-selected.
 */
export function selectionAfterFailureIn(
  selection: AccountSelection,
  actedIn: string | null,
  shownNow: string | null,
  acted: ReadonlySet<string>,
  present: ReadonlySet<string>,
): AccountSelection {
  if (actedIn !== shownNow) return selection;
  return { accountId: shownNow, ids: selectionAfterFailure(selectionIn(selection, shownNow), acted, present) };
}

// Runs the action, reports a rejection as a toast, and says whether it resolved.
export async function settled(p: Promise<unknown>, failureTitle: string): Promise<boolean> {
  let ok = true;
  await withFailureToast(p.catch((err) => { ok = false; throw err; }), failureTitle);
  return ok;
}

/** The selection restricted to rows still listed; `selected` itself when none dropped. */
export function selectionPrunedTo(selected: ReadonlySet<string>, visibleKeys: readonly string[]): ReadonlySet<string> {
  if (selected.size === 0) return selected;
  const visible = new Set(visibleKeys);
  const kept = [...selected].filter((k) => visible.has(k));
  return kept.length === selected.size ? selected : new Set(kept);
}
