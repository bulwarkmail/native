import { format } from 'date-fns';

/**
 * The event's description with a quick note appended under a time stamp
 * (webmail calendar-app handleSaveNoteFromDetail): "--- 2026-11-02 09:30 ---".
 */
export function appendEventNote(description: string | null | undefined, note: string, now: Date): string {
  const stamp = `--- ${format(now, 'yyyy-MM-dd HH:mm')} ---`;
  return description ? `${description}\n\n${stamp}\n${note}` : `${stamp}\n${note}`;
}
