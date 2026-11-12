import { format } from 'date-fns';
import { descriptionWithNote } from './calendar-description';

/**
 * The event's description with a quick note appended under a time stamp
 * (webmail calendar-app handleSaveNoteFromDetail): "--- 2026-11-02 09:30 ---".
 * An HTML description gets the note as an HTML paragraph and stays HTML.
 */
export function appendEventNote(
  event: { description?: string | null; descriptionContentType?: string | null },
  note: string,
  now: Date,
): { description: string; descriptionContentType?: string } {
  return descriptionWithNote(event, `--- ${format(now, 'yyyy-MM-dd HH:mm')} ---`, note);
}
