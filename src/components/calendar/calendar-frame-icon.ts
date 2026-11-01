import { makeIcon } from '../icons/icon';

/**
 * Tabler's `calendar` with the "1" it prints in the date cell left out. The
 * today button writes the real day in that cell, so the printed digit would sit
 * under it: a doubled "1" on the first of the month, a smudge on other days.
 */
export const CalendarFrame = makeIcon('CalendarFrame', [
  'M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12',
  'M16 3v4',
  'M8 3v4',
  'M4 11h16',
]);
