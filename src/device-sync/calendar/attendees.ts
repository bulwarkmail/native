/**
 * Participants ↔ Attendees rows (docs/device-sync.md, "Other properties").
 *
 * Only participants with a `mailto:` calendar address become rows; the rest
 * stay on the server untouched. Android decides who "me" is by comparing
 * ATTENDEE_EMAIL with the calendar's OWNER_ACCOUNT case-sensitively, so the
 * user's own address, under whichever alias, is written as exactly
 * OWNER_ACCOUNT. Stalwart can list one address twice (the organizer derived
 * from ORGANIZER plus its ATTENDEE entry); such entries become one row.
 * Participant ids never reach the device: rows are matched to participants
 * by address.
 */
import type { Participant } from '../../api/types';
import { AttendeeRelationship, Attendees } from '../android-columns';
import type { Row } from '../types';
import { attendeeTypeToDevice, participationToDevice, relationshipToDevice } from './values';

export interface SelfContext {
  /** OWNER_ACCOUNT of our calendars, lowercase, no `mailto:`. */
  ownerAccount: string;
  /** Every address of the user, lowercase, no `mailto:`. */
  selfAddresses: string[];
}

type Participants = Record<string, Participant> | null | undefined;

/** The address of a `mailto:` calendar address (lowercased), else null. */
export function mailtoAddress(p: Participant | null | undefined): string | null {
  const addr = p?.calendarAddress;
  if (typeof addr !== 'string') return null;
  const m = /^mailto:(.+)$/i.exec(addr.trim());
  if (!m) return null;
  let email = m[1].trim();
  try {
    email = decodeURIComponent(email);
  } catch {
    // Keep it as written.
  }
  return email ? email.toLowerCase() : null;
}

export function isSelfAddress(email: string | null | undefined, ctx: SelfContext): boolean {
  if (!email) return false;
  const e = email.trim().replace(/^mailto:/i, '').toLowerCase();
  return e === ctx.ownerAccount.toLowerCase() || ctx.selfAddresses.some((a) => a.toLowerCase() === e);
}

/** The address as written to ATTENDEE_EMAIL / ORGANIZER: the user's own ones as OWNER_ACCOUNT. */
export function deviceAddress(email: string, ctx: SelfContext): string {
  return isSelfAddress(email, ctx) ? ctx.ownerAccount : email;
}

/** A device address as the key rows and participants are matched by (the user's aliases are one key). */
export function addressKey(email: unknown, ctx: SelfContext): string {
  const e = String(email ?? '').trim().replace(/^mailto:/i, '').toLowerCase();
  return isSelfAddress(e, ctx) ? `self:${ctx.ownerAccount.toLowerCase()}` : e;
}

interface AddressGroup {
  key: string;
  email: string;
  ids: string[];
  preferred: string;
}

/**
 * Participants with a `mailto:` address grouped by address, in server
 * order. The preferred entry of a group is the one that attends (Stalwart's
 * organizer entry has no `attendee` role), then one with a status.
 */
export function addressGroups(participants: Participants, ctx: SelfContext): AddressGroup[] {
  const groups = new Map<string, AddressGroup>();
  for (const [id, p] of Object.entries(participants ?? {})) {
    const email = mailtoAddress(p);
    if (!email) continue;
    const key = addressKey(email, ctx);
    const group = groups.get(key);
    if (group) group.ids.push(id);
    else groups.set(key, { key, email, ids: [id], preferred: id });
  }
  const list = participants ?? {};
  for (const group of groups.values()) {
    const score = (id: string) => (list[id]?.roles?.attendee ? 2 : 0) + (list[id]?.participationStatus ? 1 : 0);
    group.preferred = group.ids.reduce((best, id) => (score(id) > score(best) ? id : best), group.ids[0]);
  }
  return [...groups.values()];
}

/** The organizer's address for ORGANIZER: `organizerCalendarAddress`, else an owner participant's. */
export function organizerAddress(
  event: { organizerCalendarAddress?: string | null; participants?: Participants },
  ctx: SelfContext,
): string | null {
  const direct = event.organizerCalendarAddress
    ? mailtoAddress({ calendarAddress: /^mailto:/i.test(event.organizerCalendarAddress) ? event.organizerCalendarAddress : `mailto:${event.organizerCalendarAddress}` })
    : null;
  if (direct) return deviceAddress(direct, ctx);
  for (const p of Object.values(event.participants ?? {})) {
    if (p?.roles?.owner) {
      const email = mailtoAddress(p);
      if (email) return deviceAddress(email, ctx);
    }
  }
  return null;
}

/** Whether the event has participants that become Attendees rows. */
export function hasMailtoParticipants(participants: Participants): boolean {
  return Object.values(participants ?? {}).some((p) => mailtoAddress(p) !== null);
}

/** Attendees rows for the participants, one per address, in server order. */
export function attendeeRows(
  event: { organizerCalendarAddress?: string | null; participants?: Participants },
  ctx: SelfContext,
): Row[] {
  const participants = event.participants ?? {};
  const organizer = organizerAddress(event, ctx);
  return addressGroups(participants, ctx).map((group) => {
    const p = participants[group.preferred];
    const email = deviceAddress(group.email, ctx);
    const isOrganizer =
      group.ids.some((id) => participants[id]?.roles?.owner) || (organizer !== null && organizer.toLowerCase() === email.toLowerCase());
    const name = p.name ?? group.ids.map((id) => participants[id]?.name).find((n) => !!n) ?? null;
    return {
      [Attendees.ATTENDEE_EMAIL]: email,
      [Attendees.ATTENDEE_NAME]: name || null,
      [Attendees.ATTENDEE_RELATIONSHIP]: relationshipToDevice(isOrganizer),
      [Attendees.ATTENDEE_TYPE]: attendeeTypeToDevice(p),
      [Attendees.ATTENDEE_STATUS]: participationToDevice(p.participationStatus),
    };
  });
}

/** The participant id a device address stands for (the group's preferred entry), or null. */
export function participantIdFor(participants: Participants, email: unknown, ctx: SelfContext): string | null {
  const key = addressKey(email, ctx);
  return addressGroups(participants, ctx).find((g) => g.key === key)?.preferred ?? null;
}

/** Whether an attendee row is the organizer's. */
export function isOrganizerRow(row: Row): boolean {
  return Number(row[Attendees.ATTENDEE_RELATIONSHIP]) === AttendeeRelationship.ORGANIZER;
}

/** Whether anyone but the user takes part. */
export function hasOtherParticipants(participants: Participants, ctx: SelfContext): boolean {
  return Object.values(participants ?? {}).some((p) => {
    const email = mailtoAddress(p);
    return email !== null && !isSelfAddress(email, ctx);
  });
}

/**
 * Whether the user organizes the event: the organizer address or an owner
 * participant is theirs. An event without an organizer counts too: once it
 * has attendees Stalwart makes the account's first address its organizer.
 */
export function userIsOrganizer(
  event: { organizerCalendarAddress?: string | null; participants?: Participants },
  ctx: SelfContext,
): boolean {
  const organizer = organizerAddress(event, ctx);
  return organizer ? isSelfAddress(organizer, ctx) : true;
}
