import type { CalendarEvent, Participant, Email, Attachment, BodyPart, EmailAddress } from '../api/types';
import {
  getSenderVerification, headerValues, parseAuthenticationResults, type AuthenticationResults,
} from './email-headers';
import { plainDisplayText, plainStoredText } from './display-text';
import { localDateTimeToInstant } from './time-zone';

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

// The address a participant is scheduled at (iCalendar ORGANIZER/ATTENDEE
// value), not its EMAIL= parameter: that one is the sender's to write and
// names no one the server delivers to.
function participantCalendarAddress(p: Participant): string | null {
  const addr = normalizeEmail(p.calendarAddress);
  if (addr) return addr;
  if (p.sendTo) {
    for (const value of Object.values(p.sendTo)) {
      const n = normalizeEmail(value);
      if (n) return n;
    }
  }
  return null;
}

// A participant's address for showing it: the calendar address, else the
// email when it has nothing else.
function participantAddress(p: Participant): string | null {
  return participantCalendarAddress(p) ?? normalizeEmail(p.email);
}

/**
 * The organizer's address, which the trust assessment compares with the
 * sender and the banner shows: the event's `organizerCalendarAddress` (where
 * Stalwart routes replies), else the owner/chair's calendar address.
 */
export function getOrganizerEmail(event: Partial<CalendarEvent>): string | null {
  const stored = normalizeEmail(event.organizerCalendarAddress);
  if (stored) return stored;
  if (event.participants) {
    for (const p of Object.values(event.participants)) {
      if (isOrganizerParticipant(p)) {
        const e = participantAddress(p);
        if (e) return e;
      }
    }
  }
  return null;
}

/**
 * The organizer's participant entry: the one at the organizer's address
 * (Stalwart marks no owner/chair role), else an owner/chair when the event
 * stores no address. An owner/chair at another address is not the organizer.
 */
function findOrganizerParticipant(event: Partial<CalendarEvent>): Participant | null {
  if (!event.participants) return null;
  const participants = Object.values(event.participants);
  const stored = normalizeEmail(event.organizerCalendarAddress);
  if (stored) {
    const atAddress = participants.filter((p) => participantAddress(p) === stored);
    return atAddress.find(isOrganizerParticipant) ?? atAddress[0] ?? null;
  }
  return participants.find(isOrganizerParticipant) ?? null;
}

export function getOrganizerName(event: Partial<CalendarEvent>): string | null {
  return findOrganizerParticipant(event)?.name || getOrganizerEmail(event);
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

// Where the iTIP REPLY should go. Stalwart routes it to the stored
// ORGANIZER (organizerCalendarAddress); the store only uses this to repair
// imported events that lack one.
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

// ─── Who sent the invitation ─────────────────────────────

export interface InvitationActorSummary {
  name: string | null;
  email: string | null;
  role: 'organizer' | 'attendee';
  participationStatus: string | null;
  participationComment: string | null;
}

/**
 * Who the banner says sent or answered: the name the invitation gives is the
 * sender's to write, so the address always shows beside it ("Your Bank
 * <x@evil.example>"), cleaned of direction controls and line breaks.
 */
export function formatInvitationActor(actor: Pick<InvitationActorSummary, 'name' | 'email'>): string | null {
  const email = plainDisplayText(actor.email, 254);
  const name = plainDisplayText(actor.name, 80);
  if (name && email && name.toLowerCase() !== email.toLowerCase()) return `${name} <${email}>`;
  return email || name || null;
}

// How strongly a participant looks like the one answering: a status other
// than needs-action and a note count most, a schedule status a little.
function getParticipantSignalScore(p: Participant): number {
  let score = 0;
  if (p.participationStatus && p.participationStatus !== 'needs-action') score += 2;
  if (p.participationComment) score += 2;
  if (p.scheduleStatus?.length) score += 1;
  return score;
}

/**
 * The attendee a REPLY, COUNTER or REFRESH most likely comes from: not the
 * organizer (by role or address), the one with the strongest answer signals.
 */
function findRespondingAttendee(event: Partial<CalendarEvent>): Participant | null {
  if (!event.participants) return null;
  const organizer = findOrganizerParticipant(event);
  const organizerEmail = getOrganizerEmail(event);
  const attendees = Object.values(event.participants).filter((p) =>
    p !== organizer
    && !isOrganizerParticipant(p)
    && (!organizerEmail || participantAddress(p) !== organizerEmail));
  return [...attendees].sort(
    (left, right) => getParticipantSignalScore(right) - getParticipantSignalScore(left),
  )[0] ?? null;
}

const isResponseMethod = (method: InvitationMethod) =>
  method === 'reply' || method === 'counter' || method === 'refresh';

/**
 * The participant an invitation message comes from: the answering attendee
 * for a REPLY, COUNTER or REFRESH, the organizer for what an organizer sends.
 * Stalwart marks no owner/chair role, so the organizer is also found by
 * `organizerCalendarAddress`. Port of the webmail's getInvitationActorSummary.
 */
export function getInvitationActorSummary(
  event: Partial<CalendarEvent>,
  method: InvitationMethod,
): InvitationActorSummary | null {
  if (!event.participants) return null;
  const organizer = findOrganizerParticipant(event);
  const organizerEmail = getOrganizerEmail(event);
  const respondingAttendee = findRespondingAttendee(event);

  const asOrganizer = (): InvitationActorSummary => ({
    name: organizer?.name || null,
    // The address the trust row checked, never the entry's own EMAIL=.
    email: organizerEmail,
    role: 'organizer',
    participationStatus: organizer?.participationStatus ?? null,
    participationComment: organizer?.participationComment ?? null,
  });
  const asAttendee = (p: Participant): InvitationActorSummary => ({
    name: p.name || null,
    email: participantAddress(p),
    role: 'attendee',
    participationStatus: p.participationStatus ?? null,
    participationComment: p.participationComment ?? null,
  });
  const hasOrganizer = !!organizer || !!organizerEmail;

  switch (method) {
    case 'reply':
    case 'counter':
    case 'refresh':
      return respondingAttendee ? asAttendee(respondingAttendee) : null;
    // What only an organizer sends: never credited to an attendee. With no
    // organizer known it is "Someone", with no address.
    case 'declinecounter':
    case 'request':
    case 'publish':
    case 'add':
    case 'cancel':
      return asOrganizer();
    default:
      if (respondingAttendee) return asAttendee(respondingAttendee);
      return hasOrganizer ? asOrganizer() : null;
  }
}

/**
 * The message's From address when it isn't the actor's, so "Sent by Alice
 * <alice@example.com>" can't hide that someone else sent it. Null when they
 * match or the message has no From.
 */
export function invitationSentFrom(
  actorEmail: string | null | undefined,
  senderEmail: string | null | undefined,
): string | null {
  const sender = normalizeEmail(senderEmail);
  if (!sender) return null;
  return sender === normalizeEmail(actorEmail) ? null : sender;
}

// ─── Content-Type helpers ────────────────────────────────

export function parseContentType(value?: string | null): { mimeType: string; params: Record<string, string> } {
  if (!value) return { mimeType: '', params: {} };
  const parts = value.split(';').map((part) => part.trim()).filter(Boolean);
  const [mimeType = '', ...paramParts] = parts;
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = part.slice(0, separatorIndex).trim().toLowerCase();
    const rawValue = part.slice(separatorIndex + 1).trim();
    params[key] = rawValue.replace(/^"|"$/g, '');
  }
  return { mimeType: mimeType.toLowerCase(), params };
}

const CAL_MIME = new Set(['text/calendar', 'application/ics', 'application/icalendar']);

export function isCalendarMimeType(type?: string | null): boolean {
  return CAL_MIME.has(parseContentType(type).mimeType);
}

export function getHeaderValue(headers: Email['headers'] | undefined, headerName: string): string | null {
  if (!headers) return null;
  const target = headerName.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === target) return h.value;
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

export function extractMethodFromContentType(value?: string | null): InvitationMethod {
  return normalizeMethod(parseContentType(value).params.method);
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
      (p.participationStatus !== 'needs-action' ||
        !!p.participationComment ||
        !!p.scheduleStatus?.length),
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

type EmailForMethod = Pick<Email, 'headers' | 'attachments' | 'textBody' | 'htmlBody'>;

function getMethodFromEmail(
  email?: EmailForMethod | null,
  attachment?: Pick<Attachment, 'type'> | null,
): InvitationMethod {
  const explicit = extractMethodFromContentType(attachment?.type);
  if (explicit !== 'unknown') return explicit;
  if (email?.attachments) {
    for (const item of email.attachments) {
      if (!isCalendarMimeType(item.type)) continue;
      const method = extractMethodFromContentType(item.type);
      if (method !== 'unknown') return method;
    }
  }
  for (const part of [findCalendarBodyPart(email?.textBody), findCalendarBodyPart(email?.htmlBody)]) {
    const method = extractMethodFromContentType(part?.type);
    if (method !== 'unknown') return method;
  }
  return extractMethodFromContentType(getHeaderValue(email?.headers, 'Content-Type'));
}

/**
 * The iTIP METHOD of an invitation: an explicit `method=` Content-Type
 * parameter (attachment, inline body part or top-level header), then the raw
 * ICS `METHOD:` line when the caller downloaded it, then a guess from the
 * parsed event (cancelled status, attendee replies, organizer present).
 */
export function getInvitationMethod(
  event: Partial<CalendarEvent>,
  options?: {
    email?: EmailForMethod | null;
    attachment?: Pick<Attachment, 'type'> | null;
    rawIcs?: string | null;
  },
): InvitationMethod {
  const explicit = getMethodFromEmail(options?.email, options?.attachment);
  if (explicit !== 'unknown') return explicit;
  if (options?.rawIcs) {
    const fromIcs = extractMethodFromRawIcs(options.rawIcs);
    if (fromIcs !== 'unknown') return fromIcs;
  }
  return inferInvitationMethod(event);
}

// ─── Calendar attachment detection ───────────────────────

function isCalendarPart(part: { type?: string | null; name?: string | null }): boolean {
  const name = part.name?.toLowerCase() || '';
  return isCalendarMimeType(part.type) || name.endsWith('.ics') || name.endsWith('.ical');
}

type BodyPartWithSubParts = BodyPart & { subParts?: BodyPartWithSubParts[] | null };

// Inline text/calendar parts live in textBody/htmlBody, not `attachments`.
export function findCalendarBodyPart(parts?: BodyPart[] | null): Attachment | null {
  if (!parts) return null;
  for (const part of parts as BodyPartWithSubParts[]) {
    if (part.blobId && isCalendarPart(part)) {
      return {
        blobId: part.blobId,
        type: part.type || 'text/calendar',
        name: part.name || 'invite.ics',
        size: part.size,
        disposition: part.disposition,
        cid: part.cid,
      };
    }
    const nested = findCalendarBodyPart(part.subParts ?? undefined);
    if (nested) return nested;
  }
  return null;
}

export function findCalendarAttachment(
  email: Pick<Email, 'attachments'> & Partial<Pick<Email, 'textBody' | 'htmlBody'>>,
): Attachment | null {
  if (email.attachments) {
    for (const att of email.attachments) {
      if (isCalendarPart(att)) return att;
    }
  }
  return findCalendarBodyPart(email.textBody) || findCalendarBodyPart(email.htmlBody);
}

/**
 * What identifies a message's invitation for loading it: the message, its
 * account and the calendar part's blob. A keyword change (read, star) hands
 * a new message object with the same key, and must not download and parse
 * the .ics again. Null when the message has no calendar part.
 */
export function calendarInvitationKey(
  email: Pick<Email, 'id'>,
  attachment: Pick<Attachment, 'blobId'> | null,
  jmapAccountId?: string,
): string | null {
  return attachment ? `${jmapAccountId ?? ''}|${email.id}|${attachment.blobId}` : null;
}

// ─── Authentication-Results / trust ──────────────────────

/**
 * Authentication results of an email, derived from its raw headers. Uses the
 * mail viewer's rule: only the topmost header (our own server's) can supply a
 * pass; lower, sender-written headers may only escalate SPF to a failure.
 */
export function getEmailAuthenticationResults(
  email?: Pick<Email, 'headers'> | null,
): AuthenticationResults | null {
  if (!email?.headers) return null;
  const values = headerValues(email.headers, 'Authentication-Results');
  if (values.length === 0) return null;
  return parseAuthenticationResults(values);
}

function hasVerifiedAuthentication(auth?: AuthenticationResults | null): boolean {
  return Boolean(
    auth?.dmarc?.result === 'pass' || auth?.dkim?.result === 'pass' || auth?.spf?.result === 'pass',
  );
}

function hasAuthenticationFailure(auth?: AuthenticationResults | null): boolean {
  return Boolean(
    auth?.dmarc?.result === 'fail'
    || auth?.dkim?.result === 'fail'
    || auth?.dkim?.result === 'policy'
    || auth?.dkim?.result === 'permerror'
    || auth?.spf?.result === 'fail'
    || auth?.spf?.result === 'softfail'
    || auth?.spf?.result === 'permerror',
  );
}

function getPrimaryAddressEmail(addresses?: EmailAddress[] | null): string | null {
  return normalizeEmail(addresses?.[0]?.email);
}

export interface InvitationTrustAssessment {
  level: 'trusted' | 'caution' | 'warning';
  reason:
    | 'authentication_failed'
    | 'authentication_missing'
    | 'sender_mismatch'
    | 'sender_mismatch_unverified'
    | null;
  senderEmail: string | null;
  organizerEmail: string | null;
  /**
   * Whom the sender is compared with: the answering attendee for a REPLY,
   * COUNTER or REFRESH (an attendee sends those), else the organizer.
   */
  expectedSender: 'organizer' | 'attendee';
  expectedSenderEmail: string | null;
}

/**
 * How much to trust an invitation: DMARC/DKIM/SPF results of the carrying
 * email plus whether the sender matches the event's organizer. A spoofed
 * invitation from an unauthenticated sender must not look like a real one.
 * Port of the webmail's getInvitationTrustAssessment.
 */
export function getInvitationTrustAssessment(
  event: Partial<CalendarEvent>,
  email?: Pick<Email, 'from' | 'replyTo' | 'headers'> | null,
  method: InvitationMethod = inferInvitationMethod(event),
): InvitationTrustAssessment {
  const organizerEmail = getOrganizerEmail(event);
  const senderEmail = getPrimaryAddressEmail(email?.from) || getPrimaryAddressEmail(email?.replyTo);
  const auth = getEmailAuthenticationResults(email);
  const verified = hasVerifiedAuthentication(auth);
  const failed = hasAuthenticationFailure(auth);
  // An attendee's answer comes from the attendee, at the address they are
  // scheduled at (never the EMAIL= parameter), not from the organizer.
  const responder = isResponseMethod(method) ? findRespondingAttendee(event) : null;
  const expectedSender: InvitationTrustAssessment['expectedSender'] = isResponseMethod(method) ? 'attendee' : 'organizer';
  const expectedSenderEmail = isResponseMethod(method)
    ? (responder ? participantCalendarAddress(responder) : null)
    : organizerEmail;
  const senderMismatch = Boolean(senderEmail && expectedSenderEmail && senderEmail !== expectedSenderEmail);
  const expectsAuthenticatedTransport = method !== 'unknown';
  const base = { senderEmail, organizerEmail, expectedSender, expectedSenderEmail };

  if (senderMismatch && (failed || !verified)) {
    return { level: 'warning', reason: 'sender_mismatch_unverified', ...base };
  }
  if (failed) {
    return { level: 'warning', reason: 'authentication_failed', ...base };
  }
  if (senderMismatch) {
    return { level: 'caution', reason: 'sender_mismatch', ...base };
  }
  if (expectsAuthenticatedTransport && !verified) {
    return { level: 'caution', reason: 'authentication_missing', ...base };
  }
  return { level: 'trusted', reason: null, ...base };
}

/**
 * Whether the receiving server's checks tie the message to its From domain:
 * results present, none failing, and a DMARC pass or an SPF/DKIM pass
 * aligned with that domain. Stricter than the trust row's "any pass".
 */
function fromIsAuthenticated(auth: AuthenticationResults | null, fromEmail: string | null): boolean {
  if (!auth || !fromEmail || (!auth.spf && !auth.dkim && !auth.dmarc)) return false;
  if (hasAuthenticationFailure(auth)) return false;
  return getSenderVerification(auth, fromEmail) === null;
}

/**
 * Whether a stored event is the one an invitation is about: same UID (the
 * caller's look-up) and the same organizer, at the address the trust check
 * uses. An invitation anyone can write may carry the UID of an unrelated
 * event of the user's; it must not answer, link or rewrite that one.
 */
export function isSameInvitationEvent(
  stored: Partial<CalendarEvent> | null | undefined,
  invitation: Partial<CalendarEvent>,
): boolean {
  if (!stored || !invitation.uid || stored.uid !== invitation.uid) return false;
  return getOrganizerEmail(stored) === getOrganizerEmail(invitation);
}

// ─── Counter proposals ───────────────────────────────────

/**
 * Whether the user organizes the event: the organizer's address (the one the
 * trust row checks) is one of `userEmails`. Stalwart marks no owner or chair,
 * so the address is all there is. The caller hands only the addresses of the
 * account the event lives in.
 */
export function isUserOrganizer(event: Partial<CalendarEvent> | null, userEmails: readonly string[]): boolean {
  if (!event) return false;
  const organizer = getOrganizerEmail(event);
  if (!organizer) return false;
  return userEmails.some((e) => normalizeEmail(e) === organizer);
}

export interface InvitationChangeItem {
  label: 'title' | 'time' | 'location' | 'virtual_location' | 'description';
  /** Null when the event had none. */
  before: string | null;
  after: string;
}

// Fixed shape, one group per unit, so the match is linear; capped anyway.
const DURATION_PATTERN = /^P(?:(\d{1,6})W)?(?:(\d{1,6})D)?(?:T(?:(\d{1,6})H)?(?:(\d{1,6})M)?(?:(\d{1,6})S)?)?$/;
const WALL_CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const HTTP_URI = /^https?:\/\/[^\s]+$/i;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;
const URI_MAX = 500;
const UNCAPPED = Number.MAX_SAFE_INTEGER;
const DAY_MS = 24 * 60 * 60 * 1000;

function durationMs(duration: string | null | undefined): number | null {
  if (!duration || duration.length > 40) return null;
  const m = DURATION_PATTERN.exec(duration);
  if (!m) return null;
  const [w, d, h, min, sec] = m.slice(1).map((v) => (v ? Number(v) : 0));
  return ((((w * 7 + d) * 24 + h) * 60 + min) * 60 + sec) * 1000;
}

// A wall-clock string read as if it were UTC, so adding a duration needs no zone.
function wallClockAsUtc(value: string | null | undefined): Date | null {
  if (typeof value !== 'string' || value.length > 19) return null;
  const m = WALL_CLOCK_PATTERN.exec(value);
  if (!m) return null;
  const date = new Date(Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0),
  ));
  return isNaN(date.getTime()) ? null : date;
}

type Span = { start: string; end: string | null };

/**
 * An event's span from exactly its start, zone and duration (never a
 * server- or sender-computed utcStart): timed events as UTC instants (ISO
 * with Z), all-day events as calendar dates (YYYY-MM-DD) with the last day
 * included, a floating time as its wall clock. Null when it can't be read.
 */
function eventSpan(event: Pick<Partial<CalendarEvent>, 'start' | 'duration' | 'timeZone' | 'showWithoutTime'>): Span | null {
  const wall = wallClockAsUtc(event.start);
  if (!wall) return null;
  const ms = durationMs(event.duration);
  if (event.showWithoutTime) {
    const start = wall.toISOString().slice(0, 10);
    if (!ms || ms <= DAY_MS) return { start, end: null };
    return { start, end: new Date(wall.getTime() + ms - DAY_MS).toISOString().slice(0, 10) };
  }
  if (event.timeZone) {
    const instant = localDateTimeToInstant(event.start as string, event.timeZone);
    if (!instant) return null;
    return { start: instant.toISOString(), end: ms ? new Date(instant.getTime() + ms).toISOString() : null };
  }
  const floating = (d: Date) => d.toISOString().slice(0, 19);
  return { start: floating(wall), end: ms ? floating(new Date(wall.getTime() + ms)) : null };
}

// One line of sender text, flattened; null when longer than `max` (refused, never cut).
function flatText(value: string | null | undefined, max: number): string | null {
  const text = plainDisplayText(value, UNCAPPED);
  return Array.from(text).length > max ? null : text;
}

// JSCalendar's descriptionContentType: the app's type leaves it out, but the
// server (asked for it) and the parsed .ics may carry it. Absent: unknown.
function descriptionType(event: Partial<CalendarEvent>): { known: boolean; plain: boolean } {
  const raw = event as { descriptionContentType?: unknown };
  const known = 'descriptionContentType' in raw;
  const type = raw.descriptionContentType;
  // RFC 8984: no type means text/plain.
  return { known, plain: type == null || (typeof type === 'string' && /^text\/plain\b/i.test(type)) };
}

function namedEntries<T>(map: Record<string, T> | null | undefined, value: (entry: T) => string | undefined) {
  return Object.entries(map ?? {})
    .map(([id, entry]): [string, string] => [id, (entry && value(entry)) || ''])
    .filter(([, v]) => !!v.trim());
}

const joinedFlat = (entries: Array<[string, string]>) => entries.map(([, v]) => plainDisplayText(v, UNCAPPED)).join('; ');

interface ProposalContent {
  items: InvitationChangeItem[];
  patch: Partial<CalendarEvent>;
  /** What the proposal changes but can't be applied as written (too long, not a web link, ...). */
  refused: InvitationChangeItem['label'][];
}

/**
 * The proposal against the stored event: the change list and the patch,
 * built together, so Apply writes (and emails every attendee) exactly what
 * the list shows. A change that can't be written as shown is refused, not
 * dropped or cut. Never the proposal's descriptionContentType, and only the
 * fields shown: a location's or meeting link's other sender-written fields
 * are not taken.
 */
function compareProposal(
  current: Partial<CalendarEvent>,
  proposed: Partial<CalendarEvent>,
  formatDateTime: (iso: string | null) => string,
): ProposalContent {
  const items: InvitationChangeItem[] = [];
  const patch: Partial<CalendarEvent> = {};
  const refused: InvitationChangeItem['label'][] = [];

  // Title.
  if (typeof proposed.title === 'string' && proposed.title.trim() && proposed.title !== current.title) {
    const after = flatText(proposed.title, TITLE_MAX);
    const before = plainDisplayText(current.title, UNCAPPED);
    if (after === null) refused.push('title');
    else if (after !== before) {
      items.push({ label: 'title', before: before || null, after });
      patch.title = after;
    }
  }

  // Time: from exactly the start, zone and duration that would be written; a
  // proposal without a duration keeps the event's.
  const timeChanged = (typeof proposed.start === 'string' && proposed.start !== current.start)
    || (proposed.duration != null && proposed.duration !== current.duration)
    || (proposed.timeZone ?? null) !== (current.timeZone ?? null)
    || (proposed.showWithoutTime ?? false) !== (current.showWithoutTime ?? false);
  if (timeChanged) {
    const allDay = proposed.showWithoutTime ?? false;
    const timeZone = proposed.timeZone ?? null;
    const duration = proposed.duration ?? current.duration;
    const valid = !!wallClockAsUtc(proposed.start)
      && (proposed.duration == null || durationMs(proposed.duration) !== null)
      && (timeZone === null || (typeof timeZone === 'string' && timeZone.length <= 64
        && !!localDateTimeToInstant(proposed.start as string, timeZone)))
      // A timed proposal without a zone would make a zoned event floating.
      && (allDay || timeZone !== null || !current.timeZone);
    const after = valid ? eventSpan({ start: proposed.start, duration, timeZone, showWithoutTime: allDay }) : null;
    if (!after) refused.push('time');
    else {
      const before = eventSpan(current);
      if (after.start !== before?.start || after.end !== (before?.end ?? null)) {
        const schedule = (span: Span) => `${formatDateTime(span.start)}${span.end ? ` - ${formatDateTime(span.end)}` : ''}`;
        items.push({ label: 'time', before: before ? schedule(before) : null, after: schedule(after) });
        if (proposed.start !== current.start) patch.start = proposed.start;
        if (proposed.duration != null && proposed.duration !== current.duration) patch.duration = proposed.duration;
        if (timeZone !== (current.timeZone ?? null)) patch.timeZone = timeZone;
        if (allDay !== (current.showWithoutTime ?? false)) patch.showWithoutTime = allDay;
      }
    }
  }

  // Locations: by name. A location the event already has keeps its other
  // details (the organizer's own); the proposal's are not taken.
  const locations = namedEntries(proposed.locations, (l) => l.name);
  if (locations.length > 0 && joinedFlat(locations) !== joinedFlat(namedEntries(current.locations, (l) => l.name))) {
    const names = locations.map(([id, name]) => [id, flatText(name, TITLE_MAX)] as const);
    if (names.some(([, name]) => name === null)) refused.push('location');
    else {
      items.push({
        label: 'location',
        before: joinedFlat(namedEntries(current.locations, (l) => l.name)) || null,
        after: names.map(([, name]) => name).join('; '),
      });
      patch.locations = Object.fromEntries(names.map(([id, name]) => [
        id,
        { ...(current.locations?.[id] ?? { '@type': 'Location' as const }), name: name as string },
      ]));
    }
  }

  // Meeting links: another user's URL, mailed to every attendee. Only a web
  // link written plainly (nothing hidden in it) is taken, and only its URI.
  const links = namedEntries(proposed.virtualLocations, (v) => v.uri);
  const linksBefore = namedEntries(current.virtualLocations, (v) => v.uri);
  if (links.length > 0 && joinedFlat(links) !== joinedFlat(linksBefore)) {
    const plain = links.every(([, uri]) => uri.length <= URI_MAX && HTTP_URI.test(uri) && plainDisplayText(uri, UNCAPPED) === uri);
    if (!plain) refused.push('virtual_location');
    else {
      items.push({ label: 'virtual_location', before: joinedFlat(linksBefore) || null, after: links.map(([, uri]) => uri).join('; ') });
      patch.virtualLocations = Object.fromEntries(links.map(([id, uri]) => [id, { '@type': 'VirtualLocation' as const, uri }]));
    }
  }

  // Description: plain text on both sides only, and the stored event's type
  // must be known. An HTML proposal is not ours to flatten, and plain text
  // written into an HTML description would be read as markup. Line breaks
  // are kept in what is written; the list shows it on one line.
  if (typeof proposed.description === 'string' && proposed.description.trim()
    && proposed.description !== (current.description ?? '')) {
    const stored = descriptionType(current);
    const written = stored.known && stored.plain && descriptionType(proposed).plain
      ? plainStoredText(proposed.description, DESCRIPTION_MAX)
      : null;
    const beforeWritten = plainStoredText(current.description, UNCAPPED);
    if (!written) refused.push('description');
    else if (written !== beforeWritten) {
      items.push({
        label: 'description',
        before: plainDisplayText(current.description, UNCAPPED) || null,
        after: plainDisplayText(written, UNCAPPED),
      });
      patch.description = written;
    }
  }

  // The list's order: title, time, location, link, description.
  const order: InvitationChangeItem['label'][] = ['title', 'time', 'location', 'virtual_location', 'description'];
  items.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
  return { items, patch, refused };
}

/**
 * What applying a counter proposal writes to the stored event, or null when
 * nothing would change. After webmail calendar-invitation-banner.tsx, but
 * only what buildInvitationChangeItems shows (see compareProposal).
 */
export function buildProposalPatch(
  current: Partial<CalendarEvent> | null,
  proposed: Partial<CalendarEvent> | null,
): Partial<CalendarEvent> | null {
  if (!current || !proposed) return null;
  const { patch } = compareProposal(current, proposed, (iso) => iso ?? '');
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * What a counter proposal would change, for the organizer to review, each
 * before and after. Times go through `formatDateTime` (an ISO instant, a
 * floating wall clock, or a date).
 */
export function buildInvitationChangeItems(
  current: Partial<CalendarEvent> | null,
  proposed: Partial<CalendarEvent> | null,
  formatDateTime: (iso: string | null) => string,
): InvitationChangeItem[] {
  if (!current || !proposed) return [];
  return compareProposal(current, proposed, formatDateTime).items;
}

// The change-list item each patched key is shown under. A key not listed
// here is never applied.
const PATCH_KEY_ITEM: Record<string, InvitationChangeItem['label']> = {
  title: 'title',
  description: 'description',
  start: 'time',
  duration: 'time',
  timeZone: 'time',
  showWithoutTime: 'time',
  locations: 'location',
  virtualLocations: 'virtual_location',
};

/** Whether every key of `patch` is shown by one of `changes`. */
export function patchIsShown(patch: Partial<CalendarEvent>, changes: readonly InvitationChangeItem[]): boolean {
  const shown = new Set(changes.map((c) => c.label));
  return Object.keys(patch).every((key) => {
    const item = PATCH_KEY_ITEM[key];
    return !!item && shown.has(item);
  });
}

// A series, an occurrence of one, or a proposal for one occurrence: the
// proposal names one occurrence's times, and patching the stored event with
// them would move the whole series.
function isRecurring(stored: Partial<CalendarEvent>, proposed?: Partial<CalendarEvent> | null): boolean {
  return !!(stored.recurrenceRules?.length
    || (stored.recurrenceOverrides && Object.keys(stored.recurrenceOverrides).length > 0)
    || stored.recurrenceId
    || proposed?.recurrenceId
    || (stored.baseEventId && stored.baseEventId !== (stored.originalId ?? stored.id)));
}

/**
 * Whether "Apply proposal" may be offered for this patch: a counter, to its
 * organizer, for the stored event in the user's own calendar (not a shared
 * one), not a recurring one, with something to change, all of it in the
 * change list. Who proposed it is checked by reviewCounterProposal.
 */
export function canApplyProposal(args: {
  method: InvitationMethod;
  userIsOrganizer: boolean;
  existing: Partial<CalendarEvent> | null;
  patch: Partial<CalendarEvent> | null;
  changes: readonly InvitationChangeItem[];
  proposed?: Partial<CalendarEvent> | null;
}): boolean {
  const { method, userIsOrganizer, existing, patch, changes, proposed } = args;
  if (method !== 'counter' || !userIsOrganizer || !patch) return false;
  if (!patchIsShown(patch, changes)) return false;
  if (!existing?.id || existing.isShared) return false;
  return !isRecurring(existing, proposed);
}

/** Why Apply is withheld for a counter the user organizes. */
export type ProposalHold =
  /** A series or one occurrence of it: changed in the calendar instead. */
  | 'recurring'
  /** The proposal names no attendee at a calendar address. */
  | 'proposer_unknown'
  /** The proposer is not an attendee of the stored event. */
  | 'proposer_not_attendee'
  /** The message's From is not the proposer. */
  | 'sender_not_proposer'
  /** Nothing ties the message to the From domain, or a check failed. */
  | 'sender_unverified'
  /** Part of the proposal can't be applied as written. */
  | 'unsupported';

export interface CounterProposalReview {
  changes: InvitationChangeItem[];
  patch: Partial<CalendarEvent> | null;
  canApply: boolean;
  /** Set when there is something to apply but Apply is withheld. */
  hold: ProposalHold | null;
  /** The answering attendee, at their calendar address. */
  proposer: { name: string | null; email: string } | null;
}

// Who sent the proposal, and whether the message proves it.
function proposerHold(
  proposed: Partial<CalendarEvent>,
  stored: Partial<CalendarEvent>,
  email: Pick<Email, 'from' | 'replyTo' | 'headers'> | null | undefined,
  proposerEmail: string | null,
): ProposalHold | null {
  if (!proposerEmail) return 'proposer_unknown';
  const storedOrganizer = getOrganizerEmail(stored);
  const attendee = proposerEmail !== storedOrganizer && Object.values(stored.participants ?? {})
    .some((p) => participantCalendarAddress(p) === proposerEmail);
  if (!attendee) return 'proposer_not_attendee';
  // The From itself: a Reply-To is anyone's to set.
  const from = getPrimaryAddressEmail(email?.from);
  if (from !== proposerEmail) return 'sender_not_proposer';
  if (!fromIsAuthenticated(getEmailAuthenticationResults(email), from)) return 'sender_unverified';
  if (getInvitationTrustAssessment(proposed, email, 'counter').level === 'warning') return 'sender_unverified';
  return null;
}

/**
 * The organizer's review of a counter proposal, and whether Apply is offered:
 * the change list, the patch (the same values), and the reason Apply is
 * withheld. Null when there is nothing for the user to review: not a counter,
 * no stored event, the user doesn't organize it (by `userAddresses`, the
 * addresses of the account the event lives in), or the proposal is about
 * another event with the same UID.
 *
 * Apply needs, besides canApplyProposal: the answering attendee (at their
 * calendar address, never EMAIL=) is an attendee of the stored event, the
 * message's From is that attendee, and the message authenticates the From.
 */
export function reviewCounterProposal(args: {
  method: InvitationMethod;
  proposed: Partial<CalendarEvent>;
  stored: Partial<CalendarEvent> | null;
  userAddresses: readonly string[];
  email: Pick<Email, 'from' | 'replyTo' | 'headers'> | null | undefined;
  formatDateTime: (iso: string | null) => string;
}): CounterProposalReview | null {
  const { method, proposed, stored, userAddresses, email, formatDateTime } = args;
  if (method !== 'counter' || !stored || !isUserOrganizer(stored, userAddresses)) return null;
  if (!isSameInvitationEvent(stored, proposed)) return null;
  const responder = findRespondingAttendee(proposed);
  const proposerEmail = responder ? participantCalendarAddress(responder) : null;
  const proposer = proposerEmail ? { name: responder?.name || null, email: proposerEmail } : null;
  if (isRecurring(stored, proposed)) {
    return { changes: [], patch: null, canApply: false, hold: 'recurring', proposer };
  }
  const content = compareProposal(stored, proposed, formatDateTime);
  const patch = Object.keys(content.patch).length > 0 ? content.patch : null;
  if (content.items.length === 0 && content.refused.length === 0) {
    return { changes: [], patch: null, canApply: false, hold: null, proposer };
  }
  const hold = proposerHold(proposed, stored, email, proposerEmail)
    ?? (content.refused.length > 0 ? 'unsupported' : null);
  const canApply = !hold && canApplyProposal({
    method, userIsOrganizer: true, existing: stored, patch, changes: content.items, proposed,
  });
  return { changes: content.items, patch, canApply, hold, proposer };
}

/**
 * Whether a review taken again just before sending still matches the one the
 * organizer confirmed: Apply allowed, and the same changes and patch.
 */
export function proposalStillMatches(
  confirmed: Pick<CounterProposalReview, 'changes' | 'patch'>,
  fresh: CounterProposalReview | null,
): boolean {
  if (!fresh?.canApply || !fresh.patch) return false;
  return JSON.stringify(fresh.changes) === JSON.stringify(confirmed.changes)
    && JSON.stringify(fresh.patch) === JSON.stringify(confirmed.patch);
}
