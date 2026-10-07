import type { CalendarEvent, Participant } from '../api/types';
import { generateUUID } from './uuid';
import type { RecipientSuggestion } from '../stores/contacts-store';
import type { EmailAddress } from '../api/types';

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
 * Whether the editor must leave an existing event's guests and scheduling
 * alone: it has participants and the user (any of their addresses, identities
 * included) is not the organizer.
 */
export function participantsLockedFor(
  event: Partial<CalendarEvent> | null | undefined,
  userEmails: string[],
): boolean {
  return !!event?.participants && !isOrganizer(event, userEmails);
}

/** The default identity's address (no `mailto:`), or '' when there is none. */
export function defaultIdentityAddress(
  identities: ReadonlyArray<{ calendarAddress: string; isDefault: boolean }> | undefined,
): string {
  const found = identities?.find((i) => i.isDefault && i.calendarAddress.trim());
  return found ? found.calendarAddress.trim().replace(/^mailto:/i, '') : '';
}

type IdentityLike = { id?: string; calendarAddress: string; isDefault: boolean };

const bareAddress = (address: string) => address.trim().replace(/^mailto:/i, '');

/**
 * What organizes a new invitation: the user's default ParticipantIdentity
 * (one with an address), and without one the first login address, with the
 * identity that has that address (`identityId` null when none has it). The
 * settings select shows exactly this, and a save uses `address`.
 */
export function newInvitationOrganizer(
  identities: ReadonlyArray<IdentityLike> | undefined,
  userEmails: string[],
): { address: string; identityId: string | null } {
  const flagged = identities?.find((i) => i.isDefault && i.calendarAddress.trim());
  if (flagged) return { address: bareAddress(flagged.calendarAddress), identityId: flagged.id ?? null };
  const address = userEmails[0] || '';
  const lower = address.toLowerCase();
  const holder = address
    ? identities?.find((i) => bareAddress(i.calendarAddress).toLowerCase() === lower)
    : undefined;
  return { address, identityId: holder?.id ?? null };
}

/**
 * The address that organizes an event on save. An event that already has an
 * organizer keeps it; a new event, or one gaining participants for the first
 * time, uses `newInvitationOrganizer`.
 */
export function organizerAddressForSave(
  event: Partial<CalendarEvent> | null | undefined,
  identities: ReadonlyArray<IdentityLike> | undefined,
  userEmails: string[],
): string {
  const existing = event?.organizerCalendarAddress?.trim().replace(/^mailto:/i, '');
  return existing || newInvitationOrganizer(identities, userEmails).address;
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

export function buildParticipantMap(
  organizer: { name: string; email: string },
  attendees: Attendee[],
  // The event's stored participants when editing: each one that stays keeps
  // its id and every property (status, roles, extra fields); only entries
  // for added attendees are created and removed attendees dropped.
  existing?: Record<string, Participant> | null,
): Record<string, Participant> {
  if (existing && Object.keys(existing).length > 0) {
    return mergeParticipantMap(organizer, attendees, existing);
  }
  const participants: Record<string, Participant> = {};

  // A blank name would be serialized as `CN=` in the invitation; leave it out.
  const named = (name: string) => (name.trim() ? { name: name.trim() } : {});

  const generateId = () => generateUUID();

  // calendarAddress is the scheduling address in draft-ietf-calext-jscalendarbis
  // (implemented by Stalwart); the RFC 8984 sendTo property is retired there and
  // stored as an inert JSPROP, so it is intentionally not sent.
  participants[generateId()] = {
    '@type': 'Participant',
    ...named(organizer.name),
    email: organizer.email,
    calendarAddress: `mailto:${organizer.email}`,
    // owner only, NOT attendee: with roles.attendee set, Stalwart's server-side
    // scheduling emits the organizer as an ATTENDEE line in addition to the
    // ORGANIZER line, so the recipient sees the organizer listed twice.
    roles: { owner: true },
    participationStatus: 'accepted',
    scheduleAgent: 'server',
    expectReply: false,
    kind: 'individual',
  };

  // The organizer already has an entry above, and an address must not appear
  // twice in the invite list, so drop both cases case-insensitively (#731).
  const seen = new Set<string>([organizer.email.trim().toLowerCase()]);

  attendees.forEach((a) => {
    const email = a.email.trim();
    const key = email.toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);

    participants[generateId()] = {
      '@type': 'Participant',
      ...named(a.name),
      email,
      calendarAddress: `mailto:${email}`,
      roles: { attendee: true },
      participationStatus: 'needs-action',
      scheduleAgent: 'server',
      expectReply: true,
      kind: 'individual',
    };
  });

  return participants;
}

function mergeParticipantMap(
  organizer: { name: string; email: string },
  attendees: Attendee[],
  existing: Record<string, Participant>,
): Record<string, Participant> {
  const fresh = buildParticipantMap(organizer, attendees);
  const wanted = new Map<string, Participant>();
  for (const p of Object.values(fresh)) wanted.set(getParticipantEmail(p).trim().toLowerCase(), p);
  const result: Record<string, Participant> = {};
  const kept = new Set<string>();
  // Existing entries whose address is still wanted stay as they are.
  for (const [id, p] of Object.entries(existing)) {
    const key = getParticipantEmail(p).trim().toLowerCase();
    if (!key || kept.has(key)) continue;
    if (wanted.has(key)) {
      result[id] = p;
      kept.add(key);
    }
  }
  // Newly wanted addresses (the organizer when none matched, added attendees).
  for (const [key, p] of wanted) {
    if (kept.has(key)) continue;
    result[generateUUID()] = p;
  }
  return result;
}

/**
 * The attendee rows an editor should start from: every participant except the
 * organizer (who is re-added by buildParticipantMap on save), without
 * duplicate addresses (#731).
 */
export function seedAttendees(
  event: Partial<CalendarEvent> | null | undefined,
  userEmails: string[],
  // The address that organizes the event on save, left out of the rows.
  organizerAddress?: string,
): Attendee[] {
  if (!event?.participants) return [];
  const excluded = new Set<string>();
  if (isOrganizer(event, userEmails) && userEmails[0]) {
    excluded.add(userEmails[0].toLowerCase());
  }
  if (organizerAddress) excluded.add(organizerAddress.trim().replace(/^mailto:/i, '').toLowerCase());
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

const PARTICIPANT_MIN_QUERY = 2;
const PARTICIPANT_SUGGESTION_LIMIT = 8;

/** The trimmed query to look guests up by; empty when it is too short to search. */
export function participantQuery(draft: string): string {
  const q = draft.trim();
  return q.length < PARTICIPANT_MIN_QUERY ? '' : q;
}

/**
 * Guest suggestions: addresses already on the event are left out
 * (case-insensitive). Groups have no address of their own and stay.
 */
export function participantSuggestions(
  all: RecipientSuggestion[],
  existing: ReadonlySet<string>,
  limit = PARTICIPANT_SUGGESTION_LIMIT,
): RecipientSuggestion[] {
  return all.filter((s) => s.group || !existing.has(s.email.toLowerCase())).slice(0, limit);
}

/**
 * Picking a group adds its members, minus anyone already a guest. Deliberate
 * divergence: webmail cannot pick a group (its email check rejects '').
 */
export function groupPickAttendees(members: EmailAddress[], existing: ReadonlySet<string>): Attendee[] {
  const seen = new Set(existing);
  const out: Attendee[] = [];
  for (const m of members) {
    const email = m.email.trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: m.name || '', email });
  }
  return out;
}
