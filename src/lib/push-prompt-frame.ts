// Where the push notification prompt floats. It takes the toast placement
// (lib/use-layout floatingCardFrame), but stays until it is answered. On a
// tablet split view the bottom right corner is the reading pane: lifting the
// card over the Prev / Reply / Forward bar wasn't enough, since the quick
// reply sits right above that bar and scrolls with the message, and the card
// still covered its "More options" and Send row. While the mail list is on
// screen in a split view the card goes into the list column instead, above
// the compose button; the list scrolls out from under it, the reader never
// has anything over it.

import React from 'react';

/** The reader's bottom bar (EmailThreadScreen: 60 + at least 4 for the inset) and a gap. */
export const READER_BAR_CLEARANCE = 64;

/** The list's compose button (16 from the bottom, 56 tall) and a 12 dp gap. */
export const LIST_FAB_CLEARANCE = 16 + 56 + 12;

/** Side margin of the card inside the list column. */
export const LIST_COLUMN_MARGIN = 12;

/** The mail list column in window coordinates, while it is on screen in a split view. */
export interface ListColumnFrame {
  x: number;
  width: number;
}

let listColumn: ListColumnFrame | null = null;
const listeners = new Set<() => void>();

/** The mail list reports its column (null when it leaves the screen or the split view). */
export function setPromptListColumn(frame: ListColumnFrame | null): void {
  const same = frame === listColumn
    || (!!frame && !!listColumn && frame.x === listColumn.x && frame.width === listColumn.width);
  if (same) return;
  listColumn = frame;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function usePromptListColumn(): ListColumnFrame | null {
  return React.useSyncExternalStore(subscribe, () => listColumn, () => listColumn);
}

/** The prompt's distance from the bottom, before the safe-area inset. */
export function pushPromptBottom(frameBottom: number, split: boolean): number {
  return split ? frameBottom + READER_BAR_CLEARANCE : frameBottom;
}

/**
 * The prompt's left, right and bottom offsets (bottom before the safe-area
 * inset). A phone keeps the toast frame; a split view with the mail list on
 * screen puts it in the list column; any other split view keeps the bottom
 * right corner, above where a reader's bar would be.
 */
export function pushPromptFrame(opts: {
  frame: { left: number; right: number; bottom: number };
  split: boolean;
  windowWidth: number;
  listColumn: ListColumnFrame | null;
}): { left: number; right: number; bottom: number } {
  const { frame, split, windowWidth, listColumn: column } = opts;
  if (!split) return frame;
  if (column && column.width > 2 * LIST_COLUMN_MARGIN) {
    return {
      left: column.x + LIST_COLUMN_MARGIN,
      right: Math.max(LIST_COLUMN_MARGIN, windowWidth - (column.x + column.width) + LIST_COLUMN_MARGIN),
      bottom: LIST_FAB_CLEARANCE,
    };
  }
  return { left: frame.left, right: frame.right, bottom: pushPromptBottom(frame.bottom, true) };
}
