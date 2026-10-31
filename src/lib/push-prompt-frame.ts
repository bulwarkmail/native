// Where the push notification prompt floats. It takes the toast placement
// (lib/use-layout floatingCardFrame), but stays until it is answered: on a
// tablet split view the bottom right corner is the reading pane's Prev /
// Reply / Forward bar, which the card covered until it was dismissed. There
// it sits above that bar.

/** The reader's bottom bar (EmailThreadScreen: 60 + at least 4 for the inset) and a gap. */
export const READER_BAR_CLEARANCE = 64;

/** The prompt's distance from the bottom, before the safe-area inset. */
export function pushPromptBottom(frameBottom: number, split: boolean): number {
  return split ? frameBottom + READER_BAR_CLEARANCE : frameBottom;
}
