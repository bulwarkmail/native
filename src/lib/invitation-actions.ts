import type { CalendarEvent } from '../api/types';
import type { OpScope } from '../api/op-scope';
import type { CalendarState, EventAccount, ImportResult } from '../stores/calendar-store';
import { requireShownAccountScope } from '../stores/email-store';
import { findParticipantByEmail } from './calendar-invitation';

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

/** The account a banner tap writes in, with its scope taken now (throws when it isn't served). */
function tapAccount(appAccountId: string | undefined): EventAccount & { scope: OpScope } {
  return { appAccountId, scope: requireShownAccountScope(appAccountId) };
}

/** Add the invitation's event to `calendarId` (deduped by UID). */
export function importInvitation(
  event: Partial<CalendarEvent>,
  calendarId: string,
  appAccountId: string | undefined,
  importEvents: CalendarState['importEvents'],
): Promise<ImportResult> {
  return importEvents([event], calendarId, undefined, tapAccount(appAccountId));
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
  if (!target) {
    // The store never sees an event outside the loaded window: look it up.
    await actions.importEvents([event], opts.calendarId, undefined, account);
    target = event.uid ? (await actions.findEventsByUid(event.uid, account.scope))[0] ?? null : null;
    if (target) opts.onFound?.(target);
  }
  const participant = target ? findParticipantByEmail(target, opts.userEmails) : null;
  if (!target || !participant) throw new Error('No event to respond to');
  await actions.rsvpEvent(target.id, participant.id, opts.status, opts.replyTo, target, 'series', {
    ...account,
    jmapAccountId: target.accountId || undefined,
  });
}
