import type { CalendarEvent } from '../api/types';
import { getUserParticipantId, isOrganizer } from './calendar-participants';
import { eventHasNoOwner } from './calendar-editability';

/**
 * The user's open answer to an invitation (webmail lib/calendar-reply-state.ts,
 * pim-9): not answered yet, or maybe. Accepted, declined and the user's own
 * events have none; nor do an ownerless event and a cancelled one.
 */
export type GridReplyState = 'needs-action' | 'tentative' | null;

export function gridReplyState(event: CalendarEvent, userEmails: string[] | undefined): GridReplyState {
  if (!userEmails || userEmails.length === 0) return null;
  if (event.status === 'cancelled') return null;
  if (eventHasNoOwner(event) || isOrganizer(event, userEmails)) return null;
  const id = getUserParticipantId(event, userEmails);
  if (!id) return null;
  // JSCalendar: a participant without a status has not answered.
  const status = event.participants?.[id]?.participationStatus ?? 'needs-action';
  if (status === 'needs-action') return 'needs-action';
  if (status === 'tentative') return 'tentative';
  return null;
}

/**
 * The title an event shows on the grid: an invitation not answered yet gets
 * the webmail's "?" marker in front; tapping it opens the detail sheet with
 * the answers.
 */
export function gridTitle(event: CalendarEvent, title: string, userEmails: string[] | undefined): string {
  return gridReplyState(event, userEmails) === 'needs-action' ? `? ${title}` : title;
}
