// When the composer's recipient suggestions can't drop down under the field
// (U-069): a phone in landscape has about 50 dp left under To with the
// keyboard up, so the list hid behind the keyboard. There the composer opens
// a full-screen recipient picker instead, whose suggestions take the room
// between its own field and the keyboard.

/** One suggestion row: a 32 dp avatar and 8 dp padding above and below. */
export const SUGGESTION_ROW_HEIGHT = 48;

/** The inline list needs room for at least this much to be of use. */
export const MIN_SUGGESTION_ROOM = 2 * SUGGESTION_ROW_HEIGHT;

/** Room between the bottom of the field and the top of the keyboard (dp). */
export function suggestionRoom(windowHeight: number, keyboardObstruction: number, fieldBottom: number): number {
  return Math.max(0, windowHeight - keyboardObstruction - fieldBottom);
}

/**
 * Whether the address field should hand over to the full-screen picker.
 * A short window (a phone in landscape) always does: the keyboard leaves no
 * room. Elsewhere it does once the keyboard is up and the measured room
 * under the field is less than two rows (a small split-screen window).
 */
export function needsRecipientPicker(opts: {
  shortHeight: boolean;
  windowHeight: number;
  keyboardObstruction: number;
  /** The field row's bottom edge in window coordinates, when measured. */
  fieldBottom: number | null;
}): boolean {
  if (opts.shortHeight) return true;
  if (opts.keyboardObstruction <= 0 || opts.fieldBottom == null) return false;
  return suggestionRoom(opts.windowHeight, opts.keyboardObstruction, opts.fieldBottom) < MIN_SUGGESTION_ROOM;
}

/**
 * A focus that lands right after the picker closed is the field getting its
 * focus back, not the user asking for the picker again.
 */
export const PICKER_REOPEN_GRACE_MS = 600;

export function isPickerReopenTooSoon(closedAt: number | null, now: number): boolean {
  return closedAt != null && now - closedAt < PICKER_REOPEN_GRACE_MS;
}
