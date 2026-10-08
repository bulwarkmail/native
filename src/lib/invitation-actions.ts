import type { CalendarEvent } from '../api/types';
import type { OpScope } from '../api/op-scope';
import type { CalendarState, EventAccount, ImportResult } from '../stores/calendar-store';
import { requireShownAccountScope } from '../stores/email-store';
import { findParticipantByEmail, isSameInvitationEvent } from './calendar-invitation';

// What the invitation banner writes. Each tap is one change: the scope is
// taken once, when it starts, and every step (the import, the look-up of the
// imported event, the answer) goes out on it. Ids repeat across accounts
// (Stalwart numbers them per account), so a step on a later connection would
// act on another account's same-id event; on a stale scope it fails instead,
// sending nothing. Still refused by the store once the account isn't shown.

export interface InvitationActions {
  importEvents: CalendarState['importEvents'];
  findEventsByUid: (uid: string, at: OpScope) => Promise<CalendarEvent[]>;
  rsvpEvent: CalendarState['rsvpEvent'];
}

/**
 * The user has another event under the invitation's UID (another organizer):
 * an invitation anyone can write must not answer, link or rewrite it.
 */
export class InvitationUidConflictError extends Error {
  constructor() {
    super('Another event in the calendar has this invitation\'s UID');
    this.name = 'InvitationUidConflictError';
  }
}

// The stored events with the invitation's UID, refused when one of them is
// not this invitation's event.
async function storedEventsFor(
  event: Partial<CalendarEvent>,
  findEventsByUid: InvitationActions['findEventsByUid'],
  at: OpScope,
): Promise<CalendarEvent[]> {
  if (!event.uid) return [];
  const found = await findEventsByUid(event.uid, at);
  if (found.some((e) => !isSameInvitationEvent(e, event))) throw new InvitationUidConflictError();
  return found;
}

/** The account a banner tap writes in, with its scope taken now (throws when it isn't served). */
function tapAccount(appAccountId: string | undefined): EventAccount & { scope: OpScope } {
  return { appAccountId, scope: requireShownAccountScope(appAccountId) };
}

/**
 * Add the invitation's event to `calendarId` (deduped by UID). Refused when
 * the UID is another event's: the import would link that one instead.
 */
export async function importInvitation(
  event: Partial<CalendarEvent>,
  calendarId: string,
  appAccountId: string | undefined,
  actions: Pick<InvitationActions, 'importEvents' | 'findEventsByUid'>,
): Promise<ImportResult> {
  const account = tapAccount(appAccountId);
  await storedEventsFor(event, actions.findEventsByUid, account.scope);
  return actions.importEvents([event], calendarId, undefined, account);
}

/**
 * Answer the invitation: import it first unless it is already there
 * (`existing`), find it on the server for its id and the user's participant,
 * then send the answer. Throws when no response went out.
 */
export async function importAndRespond(opts: {
  event: Partial<CalendarEvent>;
  existing: CalendarEvent | null;
  calendarId: string;
  status: 'accepted' | 'declined' | 'tentative';
  userEmails: string[];
  replyTo: Record<string, string> | null;
  appAccountId: string | undefined;
  actions: InvitationActions;
  /** The imported event, once found. */
  onFound?: (target: CalendarEvent) => void;
}): Promise<void> {
  const { event, actions } = opts;
  const account = tapAccount(opts.appAccountId);
  let target = opts.existing;
  if (target && !isSameInvitationEvent(target, event)) throw new InvitationUidConflictError();
  if (!target) {
    // The store never sees an event outside the loaded window: look it up,
    // and import it only when it isn't there.
    target = (await storedEventsFor(event, actions.findEventsByUid, account.scope))[0] ?? null;
    if (!target) {
      await actions.importEvents([event], opts.calendarId, undefined, account);
      target = (await storedEventsFor(event, actions.findEventsByUid, account.scope))[0] ?? null;
    }
    if (target) opts.onFound?.(target);
  }
  const participant = target ? findParticipantByEmail(target, opts.userEmails) : null;
  if (!target || !participant) throw new Error('No event to respond to');
  await actions.rsvpEvent(target.id, participant.id, opts.status, opts.replyTo, target, 'series', {
    ...account,
    jmapAccountId: target.accountId || undefined,
  });
}
