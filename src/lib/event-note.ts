import { format } from 'date-fns';
import type { CalendarEvent } from '../api/types';

/**
 * Append a timestamped note to an event description, in webmail's format
 * (calendar-app.tsx handleSaveNoteFromDetail): "--- yyyy-MM-dd HH:mm ---" on
 * its own line, then the note; after existing text, a blank line comes first.
 * `now` is the display clock (displayNow()). The stamp is all digits, so no
 * locale is needed. A blank note returns null (nothing to save).
 */
export function appendEventNote(
  description: string | null | undefined,
  note: string,
  now: Date,
): string | null {
  const trimmed = note.trim();
  if (!trimmed) return null;
  const header = `--- ${format(now, 'yyyy-MM-dd HH:mm')} ---`;
  return description ? `${description}\n\n${header}\n${trimmed}` : `${header}\n${trimmed}`;
}

/** The update for a note: the description and nothing else. */
export function buildNoteUpdate(
  event: Pick<CalendarEvent, 'description'>,
  note: string,
  now: Date,
): Partial<CalendarEvent> | null {
  const description = appendEventNote(event.description, note, now);
  return description === null ? null : { description };
}

/**
 * How a note is saved: never with scheduling messages. A note is the user's
 * own; with them the server would mail it to every guest (iMIP), and an
 * attendee's note would send scheduling for someone else's event. Webmail's
 * note sends none either.
 */
export function noteSaveOptions<A>(account: A): { sendSchedulingMessages: false; account: A } {
  return { sendSchedulingMessages: false, account };
}
