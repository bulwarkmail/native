import type { CalendarEvent, Participant, Email, Attachment } from '../api/types';

// ─── Address helpers ─────────────────────────────────────

export function normalizeEmail(value?: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/^mailto:/i, '').toLowerCase();
  return normalized || null;
}

export function getParticipantEmail(p: Participant): string | null {
  const direct = normalizeEmail(p.email);
  if (direct) return direct;
  if (p.calendarAddress) {
    const addr = normalizeEmail(p.calendarAddress);
    if (addr) return addr;
  }
  if (p.sendTo) {
    for (const addr of Object.values(p.sendTo)) {
      const n = normalizeEmail(addr);
      if (n) return n;
    }
  }
  return null;
}

export function isOrganizerParticipant(p: Participant): boolean {
  return Boolean(p.roles?.owner || p.roles?.chair);
}

export function getOrganizerEmail(event: Partial<CalendarEvent>): string | null {
  if (event.participants) {
    for (const p of Object.values(event.participants)) {
      if (isOrganizerParticipant(p)) {
        const e = getParticipantEmail(p);
        if (e) return e;
      }
    }
  }
  if (event.organizerCalendarAddress) return normalizeEmail(event.organizerCalendarAddress);
  return null;
}

export function getOrganizerName(event: Partial<CalendarEvent>): string | null {
  if (event.participants) {
    for (const p of Object.values(event.participants)) {
      if (isOrganizerParticipant(p)) return p.name || getParticipantEmail(p);
    }
    if (event.organizerCalendarAddress) {
      for (const p of Object.values(event.participants)) {
        if (p.calendarAddress === event.organizerCalendarAddress) return p.name || getParticipantEmail(p);
      }
    }
  }
  return getOrganizerEmail(event);
}

// Find the participant entry that matches one of the given user emails.
export function findParticipantByEmail(
  event: Partial<CalendarEvent>,
  emails: string[],
): { id: string; participant: Participant } | null {
  if (!event.participants || emails.length === 0) return null;
  const wanted = new Set(emails.map((e) => e.toLowerCase()).filter(Boolean));
  for (const [id, p] of Object.entries(event.participants)) {
    const e = getParticipantEmail(p);
    if (e && wanted.has(e)) return { id, participant: p };
  }
  return null;
}

// `replyTo` to attach to an RSVP so the server knows where to deliver the iTIP
// reply (Stalwart exposes the organizer as organizerCalendarAddress).
export function buildReplyTo(event: Partial<CalendarEvent>): Record<string, string> | null {
  if (event.replyTo) return event.replyTo;
  if (event.organizerCalendarAddress) {
    const addr = event.organizerCalendarAddress.startsWith('mailto:')
      ? event.organizerCalendarAddress
      : `mailto:${event.organizerCalendarAddress}`;
    return { imip: addr };
  }
  return null;
}

// ─── iMIP method detection ───────────────────────────────

export type InvitationMethod =
  | 'publish' | 'request' | 'reply' | 'add'
  | 'cancel' | 'refresh' | 'counter' | 'declinecounter' | 'unknown';

const KNOWN_METHODS = new Set<InvitationMethod>([
  'publish', 'request', 'reply', 'add', 'cancel', 'refresh', 'counter', 'declinecounter',
]);

function normalizeMethod(value?: string | null): InvitationMethod {
  if (!value) return 'unknown';
  const v = value.trim().toLowerCase();
  return KNOWN_METHODS.has(v as InvitationMethod) ? (v as InvitationMethod) : 'unknown';
}

// JMAP strips Content-Type params (RFC 8621), so `text/calendar; method=REQUEST`
// arrives as `text/calendar`. The raw ICS METHOD line is the reliable source.
export function extractMethodFromRawIcs(rawText: string): InvitationMethod {
  const m = rawText.match(/^METHOD:(\S+)/m);
  return m ? normalizeMethod(m[1]) : 'unknown';
}

function looksLikeReply(event: Partial<CalendarEvent>): boolean {
  if (!event.participants) return false;
  return Object.values(event.participants).some(
    (p) =>
      p.roles?.attendee &&
      !isOrganizerParticipant(p) &&
      (p.participationStatus !== 'needs-action' || !!p.participationComment),
  );
}

export function inferInvitationMethod(event: Partial<CalendarEvent>): InvitationMethod {
  if (event.status === 'cancelled') return 'cancel';
  if (looksLikeReply(event)) return 'reply';
  if (event.participants && Object.keys(event.participants).length > 0) {
    if (Object.values(event.participants).some(isOrganizerParticipant) || event.organizerCalendarAddress) {
      return 'request';
    }
  }
  return 'unknown';
}

// ─── Calendar attachment detection ───────────────────────

const CAL_MIME = new Set(['text/calendar', 'application/ics', 'application/icalendar']);

function isCalendarType(type?: string | null): boolean {
  if (!type) return false;
  const base = type.split(';')[0].trim().toLowerCase();
  return CAL_MIME.has(base);
}

export function findCalendarAttachment(email: Pick<Email, 'attachments'>): Attachment | null {
  if (!email.attachments) return null;
  for (const att of email.attachments) {
    const name = att.name?.toLowerCase() || '';
    if (isCalendarType(att.type) || name.endsWith('.ics') || name.endsWith('.ical')) {
      return att;
    }
  }
  return null;
}
