/**
 * When a device change asks Stalwart to send iTIP messages
 * (docs/device-sync.md, "Scheduling messages"). Stalwart schedules only when
 * a `/set` says so, while CalDAV clients get implicit scheduling on every
 * change; device sync follows CalDAV for the changes a calendar app would
 * notify about:
 *
 * - the organizer, with others taking part: a change to the title,
 *   description, timing, rule, overrides, location, status or attendees, a
 *   create, and a destroy (CANCEL); reminders, colour, availability and
 *   privacy alone send nothing;
 * - an attendee: their own RSVP, and a destroy (a declining REPLY); their
 *   other edits are stored for them only.
 *
 * Events in the past need no rule here: Stalwart sends nothing for them.
 */
import type { Participant } from '../../api/types';
import { hasOtherParticipants, userIsOrganizer, type SelfContext } from './attendees';

/** Master units whose change the organizer tells the attendees about. */
export const NOTIFYING_UNITS = ['title', 'description', 'timing', 'rule', 'location', 'status'] as const;

type Scheduled = { organizerCalendarAddress?: string | null; participants?: Record<string, Participant> | null };

export type SchedulingChange =
  | {
      kind: 'update';
      /** A notifying unit, an override or an attendee changed. */
      notifying: boolean;
      /** The user's own participation status changed. */
      rsvp: boolean;
      /** Attendees were added (the event may have had no one else before). */
      addsAttendees: boolean;
    }
  | { kind: 'create' }
  | { kind: 'destroy' };

/** Whether the write carries `sendSchedulingMessages: true`, for `event` as it is before (or, for a create, as it is sent). */
export function sendsSchedulingMessages(event: Scheduled, change: SchedulingChange, ctx: SelfContext): boolean {
  const others = hasOtherParticipants(event.participants, ctx);
  switch (change.kind) {
    case 'destroy':
      return others;
    case 'create':
      return others && userIsOrganizer(event, ctx);
    case 'update':
      if (userIsOrganizer(event, ctx)) return (others || change.addsAttendees) && change.notifying;
      return change.rsvp;
  }
}
