import { isPeriodBoundary } from './period';
import { isValidLocalInput, localInputToUtcIso, utcIsoToLocalInput } from '../vacation-dates';

// The rule editor's period fields (webmail filter-rule-modal.tsx). The user
// types local wall-clock time as for the vacation dates ("YYYY-MM-DD HH:MM");
// the rule stores the UTC moment, so the script does not depend on the time
// zone of whoever saves it next.

/** A stored boundary as the field shows it; '' for none or one it cannot read. */
export function periodToInput(boundary: string | undefined): string {
  return isPeriodBoundary(boundary) ? utcIsoToLocalInput(boundary) : '';
}

/**
 * The field's text as the boundary the rule stores: undefined for an empty
 * field, null for one that holds no usable moment. A boundary left as the
 * dialog showed it is kept exactly: the field shows whole minutes, so
 * reading it back would drop a saved second.
 */
export function periodFromInput(value: string, saved: string | undefined): string | null | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (saved !== undefined && text === periodToInput(saved)) return saved;
  if (!isValidLocalInput(text)) return null;
  const boundary = localInputToUtcIso(text);
  return boundary && isPeriodBoundary(boundary) ? boundary : null;
}

export type PeriodError = 'invalid' | 'empty' | 'order';

/** What is wrong with a period, read from its two fields (see periodFromInput). */
export function periodError(from: string | null | undefined, until: string | null | undefined): PeriodError | null {
  if (from === null || until === null) return 'invalid';
  if (!from && !until) return 'empty';
  if (from && until && Date.parse(until) <= Date.parse(from)) return 'order';
  return null;
}
