/** What Android back does on a list screen (mail, contacts). */
export type ListBackStep = 'clear-selection' | 'clear-search' | 'leave';

/**
 * Back works through the list's own layers first: selection mode ends, then
 * an open search (and on mail its filters) clears. Only a plain list lets
 * back `leave`: on the mail root that closes the app, on another tab it goes
 * back to Mail. A search used to exit the app straight away.
 */
export function listBackStep(state: { selecting: boolean; searching: boolean }): ListBackStep {
  if (state.selecting) return 'clear-selection';
  if (state.searching) return 'clear-search';
  return 'leave';
}
