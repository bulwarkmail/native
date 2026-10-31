import type { CalendarEvent, Participant } from '../api/types';
import type { MessageParams } from '../i18n/format';
import { generateUUID } from './uuid';

// Port of the webmail's lib/calendar-participants.ts.

export interface ParticipantInfo {
  id: string;
  name: string;
  email: string;
  status: Participant['participationStatus'];
  isOrganizer: boolean;
}

export interface StatusCounts {
  accepted: number;
  declined: number;
  tentative: number;
  'needs-action': number;
}

/**
 * Check if a participant matches any of the given email addresses.
 * Checks p.email, p.calendarAddress (mailto:...), and p.sendTo values.
 */
function participantMatchesEmail(p: Participant, lowerEmails: string[]): boolean {
  if (p.email && lowerEmails.includes(p.email.toLowerCase())) return true;
  if (p.calendarAddress) {
    const addr = p.calendarAddress.replace(/^mailto:/i, '').toLowerCase();
    if (addr && lowerEmails.includes(addr)) return true;
  }
  if (p.sendTo) {
    for (const addr of Object.values(p.sendTo)) {
      const normalized = addr.replace(/^mailto:/i, '').toLowerCase();
      if (normalized && lowerEmails.includes(normalized)) return true;
    }
  }
  return false;
}

/** Best-effort scheduling address for a participant, without the mailto: scheme. */
export function getParticipantEmail(p: Participant): string {
  if (p.email) return p.email;
  if (p.calendarAddress) return p.calendarAddress.replace(/^mailto:/i, '');
  if (p.sendTo?.imip) return p.sendTo.imip.replace(/^mailto:/i, '');
  return '';
}

/**
 * Collects the event-level organizer calendar address(es).
 * Stalwart conveys the organizer via `organizerCalendarAddress` / `replyTo`
 * rather than a participant `roles.owner` flag, so self-organized events
 * imported from another server have no owner participant to match against.
 */
export function getEventOrganizerEmails(event: Partial<CalendarEvent>): string[] {
  const emails: string[] = [];
  if (event.organizerCalendarAddress) {
    emails.push(event.organizerCalendarAddress.replace(/^mailto:/i, '').toLowerCase());
  }
  if (event.replyTo) {
    for (const addr of Object.values(event.replyTo)) {
      emails.push(addr.replace(/^mailto:/i, '').toLowerCase());
    }
  }
  return emails.filter(Boolean);
}

/**
 * Merge the user's calendar addresses (login address, identities, account
 * aliases) so isOrganizer() recognises alias-organized events as the user's
 * own. De-duplicated case-insensitively (first casing kept); blanks dropped.
 */
export function collectUserCalendarAddresses(
  ...groups: Array<ReadonlyArray<string | null | undefined>>
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const raw of group) {
      const trimmed = raw?.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}

export function isOrganizer(event: Partial<CalendarEvent>, userEmails: string[]): boolean {
  if (userEmails.length === 0) return false;
  const lower = userEmails.map((e) => e.toLowerCase());

  if (event.participants) {
    const ownerMatch = Object.values(event.participants).some(
      (p) => p.roles?.owner && participantMatchesEmail(p, lower),
    );
    if (ownerMatch) return true;
  }

  // Fall back to the event-level organizer address (Stalwart / imported events
  // mark the organizer here instead of via a participant `owner` role).
  return getEventOrganizerEmails(event).some((email) => lower.includes(email));
}

export function getUserParticipantId(
  event: Partial<CalendarEvent>,
  userEmails: string[],
): string | null {
  if (!event.participants) return null;
  const lower = userEmails.map((e) => e.toLowerCase());
  for (const [id, p] of Object.entries(event.participants)) {
    if (participantMatchesEmail(p, lower)) return id;
  }
  return null;
}

export function getUserStatus(
  event: Partial<CalendarEvent>,
  userEmails: string[],
): Participant['participationStatus'] | null {
  if (!event.participants) return null;
  const lower = userEmails.map((e) => e.toLowerCase());
  for (const p of Object.values(event.participants)) {
    if (participantMatchesEmail(p, lower)) return p.participationStatus;
  }
  return null;
}

/**
 * True when the user declined this event. An occurrence carries its override's
 * participants, so one declined instance of an accepted series counts
 * (webmail #1110).
 */
export function isDeclinedByUser(
  event: Partial<CalendarEvent>,
  userEmails: string[] | undefined,
): boolean {
  if (!userEmails || userEmails.length === 0) return false;
  return getUserStatus(event, userEmails) === 'declined';
}

/**
 * Declined by the user or cancelled by the organizer: the calendar draws both
 * the same way, as an outlined, struck-through event (repos/branding/APP.md).
 */
export function isInactiveEvent(
  event: Partial<CalendarEvent>,
  userEmails: string[] | undefined,
): boolean {
  return event.status === 'cancelled' || isDeclinedByUser(event, userEmails);
}

/** When the same address appears in two participant entries, a real RSVP on
 *  either one beats a missing/"needs-action" one — the duplicate is always the
 *  entry that never replied. Between two real replies the first-seen entry
 *  wins; such conflicts do not occur in practice. */
function betterStatus(
  current: Participant['participationStatus'] | undefined,
  incoming: Participant['participationStatus'] | undefined,
): Participant['participationStatus'] {
  if (current === 'needs-action' && incoming && incoming !== 'needs-action') return incoming;
  return current || 'needs-action';
}

export interface ParticipantListOptions {
  /**
   * Fills `ParticipantInfo.name` for participants whose event data carries no
   * name. Stalwart drops the ORGANIZER display name on its iCalendar
   * round-trip, so the organizer (and attendees added by bare address) render
   * as a bare email until the contact card's name is looked up.
   */
  resolveName?: (email: string) => string | undefined;
}

export function getParticipantList(
  event: Partial<CalendarEvent>,
  options?: ParticipantListOptions,
): ParticipantInfo[] {
  if (!event.participants) return [];
  // Stalwart rebuilds the ORGANIZER line into a participant that carries only
  // `calendarAddress` — no `roles` at all — so `roles.owner` alone would treat
  // the organizer as a plain attendee on every re-read (#731).
  const organizerEmails = getEventOrganizerEmails(event);
  const resolveName = options?.resolveName;

  // The same address can legitimately arrive twice: the organizer as both the
  // ORGANIZER-derived participant and an ATTENDEE line (server-side
  // scheduling, or events written before #731), or an attendee pasted twice.
  // Render each address once by folding later entries into the first-seen
  // one — otherwise every list and count shows a phantom participant.
  const list: ParticipantInfo[] = [];
  const byEmail = new Map<string, ParticipantInfo>();

  for (const [id, p] of Object.entries(event.participants)) {
    const email = getParticipantEmail(p);
    const key = email.trim().toLowerCase();
    const isOrganizer = !!p.roles?.owner || (!!key && organizerEmails.includes(key));

    const existing = key ? byEmail.get(key) : undefined;
    if (existing) {
      if (!existing.name && p.name) existing.name = p.name;
      if (isOrganizer) existing.isOrganizer = true;
      existing.status = betterStatus(existing.status, p.participationStatus);
      continue;
    }

    const entry: ParticipantInfo = {
      id,
      name: p.name || '',
      email,
      status: p.participationStatus || 'needs-action',
      isOrganizer,
    };
    if (key) byEmail.set(key, entry);
    list.push(entry);
  }

  for (const entry of list) {
    if (!entry.name && entry.email && resolveName) {
      entry.name = resolveName(entry.email) || '';
    }
    // The organizer owes no reply to their own invitation; a missing status
    // must not read as "pending" next to the organizer marker. Matches
    // getStatusCounts, which excludes the organizer from pending totals.
    if (entry.isOrganizer && entry.status === 'needs-action') {
      entry.status = 'accepted';
    }
  }
  return list;
}

export function getStatusCounts(event: Partial<CalendarEvent>): StatusCounts {
  const counts: StatusCounts = { accepted: 0, declined: 0, tentative: 0, 'needs-action': 0 };
  if (!event.participants) return counts;
  const organizerEmails = getEventOrganizerEmails(event);
  for (const p of Object.values(event.participants)) {
    // The organizer is not awaiting their own reply; counting the roles-less
    // participant Stalwart derives from ORGANIZER inflates the pending total.
    const email = getParticipantEmail(p).toLowerCase();
    if (p.roles?.owner || (email && organizerEmails.includes(email))) continue;
    const s = p.participationStatus || 'needs-action';
    if (s in counts) counts[s as keyof StatusCounts]++;
  }
  return counts;
}

export function getParticipantCount(event: Partial<CalendarEvent>): number {
  if (!event.participants) return 0;
  // Count addresses, not raw entries: an organizer the server emits twice must
  // not inflate the count. Entries without any address cannot be merged, so
  // they count individually.
  const seen = new Set<string>();
  let count = 0;
  for (const p of Object.values(event.participants)) {
    const key = getParticipantEmail(p).trim().toLowerCase();
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    count++;
  }
  return count;
}

export interface Attendee {
  name: string;
  email: string;
}

/**
 * `attendees` with `added` at the end, unless that address is invited
 * already. Done/Enter on Android submits and then blurs the field, and both
 * add what was typed: checking against the latest list (a state updater's
 * `prev`) keeps the second add from inviting the same person twice.
 */
export function withAttendee(attendees: Attendee[], added: Attendee): Attendee[] {
  const key = added.email.trim().toLowerCase();
  if (!key || attendees.some((a) => a.email.trim().toLowerCase() === key)) return attendees;
  return [...attendees, added];
}

type ParticipationStatus = Participant['participationStatus'];

/**
 * The limit a refusal names when the server turned an event down for having
 * too many participants, or null for any other failure. Stalwart 1.0 enforces
 * maxParticipantsPerEvent on every create and update, answers to invitations
 * included, and refuses with invalidProperties "An event cannot have more
 * than 20 participants."; 0.16 advertises the limit without enforcing it.
 * An import that got nothing in carries the refusals as `refused` reasons.
 */
export function participantLimitOf(error: unknown): number | null {
  const texts: string[] = [];
  if (error instanceof Error) texts.push(error.message);
  const refused = (error as { refused?: { reason?: unknown }[] } | null)?.refused;
  if (Array.isArray(refused)) {
    for (const entry of refused) if (typeof entry?.reason === 'string') texts.push(entry.reason);
  }
  for (const text of texts) {
    const match = /more than (\d+) participants/i.exec(text);
    if (match) return Number(match[1]);
  }
  return null;
}

type Translate = (key: string, fallback?: string, params?: MessageParams) => string;

/**
 * What to tell the user about a failed calendar change the server refused
 * for the participant limit, in the language of `t`; null for any other
 * failure.
 */
export function participantLimitMessage(error: unknown, t: Translate): string | null {
  const max = participantLimitOf(error);
  if (max === null) return null;
  return t(
    'calendar.notifications.participant_limit',
    'The server allows at most {max, plural, one {# participant} other {# participants}} per event, including the organizer, so it refused this change. An administrator can raise the limit.',
    { max },
  );
}

/**
 * An event's participants by address (lowercased): the id each was first
 * listed under, and its answer - a real one over a missing or needs-action
 * one when an address is listed twice (see getParticipantList).
 */
function participantsByAddress(
  participants: CalendarEvent['participants'] | null | undefined,
): Map<string, { id: string; status: ParticipationStatus | undefined }> {
  const known = new Map<string, { id: string; status: ParticipationStatus | undefined }>();
  for (const [id, p] of Object.entries(participants ?? {})) {
    const key = getParticipantEmail(p).trim().toLowerCase();
    if (!key) continue;
    const seen = known.get(key);
    if (!seen) known.set(key, { id, status: p.participationStatus });
    else if ((!seen.status || seen.status === 'needs-action') && p.participationStatus) seen.status = p.participationStatus;
  }
  return known;
}

/**
 * The participants an editor save writes: the organizer, then each attendee
 * once. `existing` is the event's current map. An address already in it
 * keeps its participant id and its answer, so a save neither resets the
 * attendees' answers - the user's own on an invitation included - nor leaves
 * a recurrence override pointing at a participant id that is gone. With
 * `askAgain` every attendee but the organizer answers anew (needs-action).
 */
export function buildParticipantMap(
  organizer: { name: string; email: string },
  attendees: Attendee[],
  existing?: CalendarEvent['participants'] | null,
  options: { askAgain?: boolean } = {},
): Record<string, Participant> {
  const participants: Record<string, Participant> = {};
  const known = participantsByAddress(existing);
  const idFor = (key: string) => {
    const id = known.get(key)?.id;
    return id && !(id in participants) ? id : generateUUID();
  };

  // calendarAddress is the scheduling address in draft-ietf-calext-jscalendarbis
  // (implemented by Stalwart); the RFC 8984 sendTo property is retired there and
  // stored as an inert JSPROP, so it is intentionally not sent.
  const organizerKey = organizer.email.trim().toLowerCase();
  const organizerStatus = known.get(organizerKey)?.status;
  // A blank name is left out: written, it reaches the attendees' copies as
  // an empty CN.
  const organizerName = organizer.name?.trim();
  participants[idFor(organizerKey)] = {
    '@type': 'Participant',
    ...(organizerName ? { name: organizerName } : {}),
    email: organizer.email,
    calendarAddress: `mailto:${organizer.email}`,
    // owner only, NOT attendee: with roles.attendee set, Stalwart's server-side
    // scheduling emits the organizer as an ATTENDEE line in addition to the
    // ORGANIZER line, so the recipient sees the organizer listed twice.
    roles: { owner: true },
    participationStatus: organizerStatus && organizerStatus !== 'needs-action' ? organizerStatus : 'accepted',
    scheduleAgent: 'server',
    expectReply: false,
    kind: 'individual',
  };

  // The organizer already has an entry above, and an address must not appear
  // twice in the invite list, so drop both cases case-insensitively (#731).
  const seen = new Set<string>([organizerKey]);

  attendees.forEach((a) => {
    const email = a.email.trim();
    const key = email.toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);

    const name = a.name?.trim();
    participants[idFor(key)] = {
      '@type': 'Participant',
      ...(name ? { name } : {}),
      email,
      calendarAddress: `mailto:${email}`,
      roles: { attendee: true },
      participationStatus: (options.askAgain ? undefined : known.get(key)?.status) ?? 'needs-action',
      scheduleAgent: 'server',
      expectReply: true,
      kind: 'individual',
    };
  });

  return participants;
}

/**
 * The event's own organizer: the organizer participant, else the address in
 * `organizerCalendarAddress` or the retired `replyTo`. `null` for an event
 * without one.
 */
function eventOrganizer(event: Partial<CalendarEvent>): { name: string; email: string } | null {
  const participant = getParticipantList(event).find((p) => p.isOrganizer && p.email.trim());
  if (participant) return { name: participant.name, email: participant.email.trim() };
  const address = event.organizerCalendarAddress || Object.values(event.replyTo ?? {})[0];
  const email = address?.replace(/^mailto:/i, '').trim();
  return email ? { name: '', email } : null;
}

/**
 * Whether a save of `event` is the user's as its organizer: an event without
 * an organizer yet becomes the user's, and so is one organized under any of
 * the user's addresses. So is the organizer's own copy in someone else's
 * account the user writes to - a calendar shared with them, a group's:
 * Stalwart schedules a change from the addresses of the account the event is
 * in, and `isOrigin` is its word that the organizer is one of them (0.16 and
 * 1.0 alike), so a sharee's change of the owner's meeting goes out from the
 * owner. An invitation someone else sent is not, in the user's account or
 * another (`isOrigin: false`): its organizer asks, the user only answers.
 */
export function userOrganizes(event: Partial<CalendarEvent> | null | undefined, userEmails: string[]): boolean {
  const organizer = event ? eventOrganizer(event) : null;
  if (!organizer || event?.isOrigin === true) return true;
  const key = organizer.email.toLowerCase();
  return userEmails.some((address) => address.trim().toLowerCase() === key);
}

/** Whether two attendee lists name the same addresses, whatever the order or letter case. */
function sameAddresses(a: Attendee[], b: Attendee[]): boolean {
  const keys = (list: Attendee[]) => new Set(list.map((x) => x.email.trim().toLowerCase()).filter(Boolean));
  const left = keys(a);
  const right = keys(b);
  return left.size === right.size && [...left].every((key) => right.has(key));
}

export interface ParticipantSaveContext {
  /** The user's first calendar address: the organizer of an event that has none yet. */
  userEmail: string | undefined;
  /** All of the user's calendar addresses (identities, aliases): whether the user organizes the event. */
  userEmails?: string[];
  /** A name for an organizer the event data carries none for (the contact card, the account). */
  resolveName?: (email: string) => string | undefined;
  /**
   * The save changes when the event happens: its start or end, whether it is
   * all-day, or its recurrence rule.
   */
  rescheduled?: boolean;
}

/**
 * The participant fields an editor save writes.
 *
 * With attendees, the participants are rebuilt around the event's own
 * organizer: an invitation keeps whoever sent it, and a series the exact
 * address it is organized under (Stalwart 1.0 checks it on single
 * occurrences). Only an event without an organizer gets the user, and only
 * then `organizerCalendarAddress` is written: Stalwart derives the iCalendar
 * ORGANIZER solely from it, so without one no invitations go out.
 * Participants that stay keep their id and answer (buildParticipantMap),
 * unless the user as the organizer moves the event: then the other
 * attendees are asked again, as RFC 5546 has an organizer do when an event
 * is rescheduled - Stalwart's update to them carries each stored answer,
 * which would read as an answer to the new time.
 *
 * A save of an invitation someone else organizes writes no participants
 * while the user left them as they were: the organizer's list is not the
 * user's to send, and a written list would reach the organizer as a reply.
 *
 * Without attendees, an event that had participants loses them, its
 * organizer and the retired `replyTo` older releases wrote.
 */
export function participantFieldsToSave(
  event: Partial<CalendarEvent> | null | undefined,
  attendees: Attendee[],
  context: ParticipantSaveContext,
): Partial<Pick<CalendarEvent, 'participants' | 'organizerCalendarAddress' | 'replyTo'>> {
  const { userEmail, resolveName } = context;
  const userEmails = [userEmail, ...(context.userEmails ?? [])].filter((address): address is string => !!address);
  const organizes = userOrganizes(event, userEmails);
  if (event && !organizes && sameAddresses(attendees, seedAttendees(event, userEmails))) return {};
  if (attendees.length > 0 && userEmail) {
    const organizer = (event ? eventOrganizer(event) : null) ?? { name: '', email: userEmail };
    const fields: Partial<Pick<CalendarEvent, 'participants' | 'organizerCalendarAddress'>> = {
      participants: buildParticipantMap(
        // A new event has no participants yet, so it would store an empty
        // organizer name.
        { name: organizer.name || resolveName?.(organizer.email) || '', email: organizer.email },
        attendees,
        event?.participants,
        { askAgain: !!context.rescheduled && organizes },
      ),
    };
    if (!event?.organizerCalendarAddress) fields.organizerCalendarAddress = `mailto:${organizer.email}`;
    return fields;
  }
  if (attendees.length === 0 && event?.participants && Object.keys(event.participants).length > 0) {
    return {
      participants: null,
      ...(event.replyTo ? { replyTo: null } : {}),
      ...(event.organizerCalendarAddress ? { organizerCalendarAddress: null } : {}),
    };
  }
  return {};
}

/**
 * The participant fields a save to a whole series writes when the editor was
 * opened on one of its occurrences ("All events"). The occurrence's list may
 * differ from the series' - one occurrence declined, one attendee added to
 * just that day - so the series starts from its own participants and takes
 * only the attendees the user added or removed in the editor. Nothing is
 * written when the save changes none of them and does not move the series.
 */
export function seriesParticipantFields(
  master: Partial<CalendarEvent>,
  occurrence: Partial<CalendarEvent>,
  attendees: Attendee[],
  context: ParticipantSaveContext,
): Partial<Pick<CalendarEvent, 'participants' | 'organizerCalendarAddress' | 'replyTo'>> {
  const userEmails = [context.userEmail, ...(context.userEmails ?? [])].filter((a): a is string => !!a);
  const key = (a: Attendee) => a.email.trim().toLowerCase();
  const before = seedAttendees(occurrence, userEmails);
  const kept = new Set(attendees.map(key));
  const removed = new Set(before.map(key).filter((k) => !kept.has(k)));
  const had = new Set(before.map(key));
  const added = attendees.filter((a) => !had.has(key(a)));
  const askAgain = !!context.rescheduled && userOrganizes(master, userEmails);
  if (added.length === 0 && removed.size === 0 && !askAgain) return {};
  const series = seedAttendees(master, userEmails).filter((a) => !removed.has(key(a)));
  const listed = new Set(series.map(key));
  for (const a of added) if (!listed.has(key(a))) series.push(a);
  return participantFieldsToSave(master, series, context);
}

/**
 * `event`'s participants with every attendee asked to answer again - back at
 * needs-action - and the organizer's entries as they are. What its organizer
 * does when an event moves (RFC 5546), and what a new event made from it
 * needs: Stalwart sends a new event, and a new override of one occurrence,
 * only to attendees without an answer (PARTSTAT absent or NEEDS-ACTION), and
 * a change to an existing one carries each attendee's stored answer. Null
 * when no attendee has answered.
 */
export function participantsAskedAgain(
  event: Partial<Pick<CalendarEvent, 'participants' | 'organizerCalendarAddress' | 'replyTo'>>,
): Record<string, Participant> | null {
  const organizers = getEventOrganizerEmails(event);
  let asked = false;
  const participants: Record<string, Participant> = {};
  for (const [id, p] of Object.entries(event.participants ?? {})) {
    const address = getParticipantEmail(p).trim().toLowerCase();
    const organizer = !!p.roles?.owner || (!!address && organizers.includes(address));
    if (organizer || !p.participationStatus || p.participationStatus === 'needs-action') {
      participants[id] = p;
      continue;
    }
    participants[id] = { ...p, participationStatus: 'needs-action' };
    asked = true;
  }
  return asked ? participants : null;
}

/**
 * Whether an attendee (anyone but the organizer) of `participants` has
 * answered: Stalwart delivers a new occurrence override, and a new event,
 * only to attendees who have not.
 */
export function hasAnsweredAttendees(participants: CalendarEvent['participants'] | null | undefined): boolean {
  return Object.values(participants ?? {}).some((p) => {
    if (p.roles?.owner) return false;
    const status = p.participationStatus;
    return !!status && status !== 'needs-action';
  });
}

/**
 * The attendee rows an editor should start from: every participant except the
 * organizer (who is re-added by buildParticipantMap on save), without
 * duplicate addresses (#731). The organizer is the event's own, or the user
 * for an event without one - not the user as such: a sharee who attends the
 * owner's meeting, or a user who invited their own main address to a
 * meeting organized under an alias, stays on the list.
 */
export function seedAttendees(
  event: Partial<CalendarEvent> | null | undefined,
  userEmails: string[],
): Attendee[] {
  if (!event?.participants) return [];
  const excluded = new Set<string>();
  const organizerAddress = eventOrganizer(event)?.email || userEmails[0]?.trim();
  if (organizerAddress) excluded.add(organizerAddress.toLowerCase());
  const out: Attendee[] = [];
  for (const p of getParticipantList(event)) {
    if (p.isOrganizer) continue;
    const key = p.email.trim().toLowerCase();
    if (!key || excluded.has(key)) continue;
    excluded.add(key);
    out.push({ name: p.name, email: p.email.trim() });
  }
  return out;
}
