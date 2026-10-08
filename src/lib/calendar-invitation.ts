import type { CalendarEvent, Participant, Email, Attachment, BodyPart, EmailAddress } from '../api/types';
import { headerValues, parseAuthenticationResults, type AuthenticationResults } from './email-headers';
import { plainDisplayText } from './display-text';
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
  const participants = Object.values(event.participants);
  const organizer = findOrganizerParticipant(event);
  const organizerEmail = getOrganizerEmail(event);
  const attendees = participants.filter((p) =>
    p !== organizer
    && !isOrganizerParticipant(p)
    && (!organizerEmail || participantAddress(p) !== organizerEmail));
  const respondingAttendee = [...attendees].sort(
    (left, right) => getParticipantSignalScore(right) - getParticipantSignalScore(left),
  )[0] ?? null;

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
  const senderMismatch = Boolean(senderEmail && organizerEmail && senderEmail !== organizerEmail);
  const expectsAuthenticatedTransport = method !== 'unknown';

  if (senderMismatch && (failed || !verified)) {
    return { level: 'warning', reason: 'sender_mismatch_unverified', senderEmail, organizerEmail };
  }
  if (failed) {
    return { level: 'warning', reason: 'authentication_failed', senderEmail, organizerEmail };
  }
  if (senderMismatch) {
    return { level: 'caution', reason: 'sender_mismatch', senderEmail, organizerEmail };
  }
  if (expectsAuthenticatedTransport && !verified) {
    return { level: 'caution', reason: 'authentication_missing', senderEmail, organizerEmail };
  }
  return { level: 'trusted', reason: null, senderEmail, organizerEmail };
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
const HTTP_URI = /^https?:\/\//i;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;
const URI_MAX = 500;

function durationMs(duration: string | null | undefined): number | null {
  if (!duration || duration.length > 40) return null;
  const m = DURATION_PATTERN.exec(duration);
  if (!m) return null;
  const [w, d, h, min, sec] = m.slice(1).map((v) => (v ? Number(v) : 0));
  return ((((w * 7 + d) * 24 + h) * 60 + min) * 60 + sec) * 1000;
}

// A wall-clock string read as if it were UTC, so adding a duration needs no zone.
function wallClockAsUtc(value: string): Date | null {
  if (value.length > 19) return null;
  const m = WALL_CLOCK_PATTERN.exec(value);
  if (!m) return null;
  const date = new Date(Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0),
  ));
  return isNaN(date.getTime()) ? null : date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An event's span, comparable between the stored event and the proposal:
 * timed events as UTC instants (ISO with Z), whichever way each writes its
 * start; all-day events as calendar dates (YYYY-MM-DD), the last day
 * included; a floating time as its wall clock. Null end: a single point or day.
 */
function eventSpan(event: Partial<CalendarEvent>): { start: string; end: string | null } | null {
  if (!event.start && !event.utcStart) return null;
  const ms = durationMs(event.duration);
  if (event.showWithoutTime) {
    const day = event.start ? wallClockAsUtc(event.start) : null;
    if (!day) return null;
    const start = day.toISOString().slice(0, 10);
    if (!ms || ms <= DAY_MS) return { start, end: null };
    return { start, end: new Date(day.getTime() + ms - DAY_MS).toISOString().slice(0, 10) };
  }
  let instant: Date | null = null;
  if (event.utcStart) {
    const utc = new Date(event.utcStart);
    if (!isNaN(utc.getTime())) instant = utc;
  }
  if (!instant && event.start && event.timeZone) instant = localDateTimeToInstant(event.start, event.timeZone);
  if (instant) {
    return { start: instant.toISOString(), end: ms ? new Date(instant.getTime() + ms).toISOString() : null };
  }
  // Floating: a wall clock in the viewer's zone, kept without a Z.
  const wall = event.start ? wallClockAsUtc(event.start) : null;
  if (!wall) return null;
  const floating = (d: Date) => d.toISOString().slice(0, 19);
  return { start: floating(wall), end: ms ? floating(new Date(wall.getTime() + ms)) : null };
}

const sameSpan = (a: ReturnType<typeof eventSpan>, b: ReturnType<typeof eventSpan>) =>
  (a?.start ?? null) === (b?.start ?? null) && (a?.end ?? null) === (b?.end ?? null);

// The proposal's times as the patch may write them: well-formed, or none.
function proposedTimes(proposed: Partial<CalendarEvent>): Partial<CalendarEvent> | null {
  if (typeof proposed.start !== 'string' || !wallClockAsUtc(proposed.start)) return null;
  if (proposed.duration != null && durationMs(proposed.duration) === null) return null;
  if (proposed.timeZone != null && (typeof proposed.timeZone !== 'string' || proposed.timeZone.length > 64)) return null;
  return {
    start: proposed.start,
    duration: proposed.duration,
    timeZone: proposed.timeZone ?? null,
    showWithoutTime: proposed.showWithoutTime ?? false,
  };
}

// JSCalendar's descriptionContentType: the app's type leaves it out, but the
// server and the parsed .ics may carry it.
function isPlainText(event: Partial<CalendarEvent>): boolean {
  const type = (event as { descriptionContentType?: unknown }).descriptionContentType;
  return type == null || (typeof type === 'string' && /^text\/plain\b/i.test(type));
}

function locationNames(event: Partial<CalendarEvent>): Array<[string, string]> {
  return Object.entries(event.locations ?? {})
    .map(([id, l]): [string, string] => [id, plainDisplayText(l?.name, TITLE_MAX)])
    .filter(([, name]) => !!name);
}

function meetingLinks(event: Partial<CalendarEvent>): Array<[string, string]> {
  return Object.entries(event.virtualLocations ?? {})
    .map(([id, v]): [string, string] => [id, plainDisplayText(v?.uri, URI_MAX)])
    .filter(([, uri]) => !!uri);
}

const joined = (entries: Array<[string, string]>) => entries.map(([, v]) => v).join('; ');

/**
 * The proposal's values the organizer is shown, each flattened by
 * plainDisplayText, and only those. The patch is built from these and the
 * change list shows these, so Apply writes (and emails every attendee)
 * exactly what was on screen: no sender-written control characters, no
 * location detail or meeting-link name the list leaves out.
 */
function reviewedValues(current: Partial<CalendarEvent>, proposed: Partial<CalendarEvent>) {
  const title = plainDisplayText(proposed.title, TITLE_MAX);
  const titleBefore = plainDisplayText(current.title, TITLE_MAX);

  // Only plain text on both sides: an HTML proposal is not ours to flatten,
  // and plain text written into an HTML description would be read as markup.
  // The event keeps its own content type; the proposal's is never taken.
  const plain = isPlainText(current) && isPlainText(proposed);
  const description = plain ? plainDisplayText(proposed.description, DESCRIPTION_MAX) : '';
  const descriptionBefore = plainDisplayText(current.description, DESCRIPTION_MAX);

  const times = proposedTimes(proposed);
  const spanBefore = eventSpan(current);
  const span = times ? eventSpan({ ...times, utcStart: proposed.utcStart }) : null;

  const locations = locationNames(proposed);
  const locationsBefore = locationNames(current);

  // Another user's URL, sent to every attendee: only web links are taken.
  const allLinks = meetingLinks(proposed);
  const links = allLinks.every(([, uri]) => HTTP_URI.test(uri)) ? allLinks : [];
  const linksBefore = meetingLinks(current);

  return {
    title: title && title !== titleBefore ? { before: titleBefore || null, after: title } : null,
    description: description && description !== descriptionBefore
      ? { before: descriptionBefore || null, after: description }
      : null,
    time: times && span && !sameSpan(span, spanBefore) ? { times, before: spanBefore, after: span } : null,
    locations: locations.length > 0 && joined(locations) !== joined(locationsBefore)
      ? { entries: locations, before: joined(locationsBefore) || null, after: joined(locations) }
      : null,
    links: links.length > 0 && joined(links) !== joined(linksBefore)
      ? { entries: links, before: joined(linksBefore) || null, after: joined(links) }
      : null,
  };
}

/**
 * What applying a counter proposal writes to the stored event: the reviewed
 * values (see reviewedValues) that differ from it, or null when none does.
 * After webmail calendar-invitation-banner.tsx, but never the proposal's
 * descriptionContentType, raw text, or anything the change list doesn't show.
 */
export function buildProposalPatch(
  current: Partial<CalendarEvent> | null,
  proposed: Partial<CalendarEvent> | null,
): Partial<CalendarEvent> | null {
  if (!current || !proposed) return null;
  const v = reviewedValues(current, proposed);
  const patch: Partial<CalendarEvent> = {};
  if (v.title) patch.title = v.title.after;
  if (v.description) patch.description = v.description.after;
  if (v.time) {
    const { start, duration, timeZone, showWithoutTime } = v.time.times;
    if (start !== current.start) patch.start = start;
    if (typeof duration === 'string' && duration !== current.duration) patch.duration = duration;
    if ((timeZone ?? null) !== (current.timeZone ?? null)) patch.timeZone = timeZone ?? null;
    if ((showWithoutTime ?? false) !== (current.showWithoutTime ?? false)) patch.showWithoutTime = showWithoutTime;
  }
  if (v.locations) {
    patch.locations = Object.fromEntries(v.locations.entries.map(([id, name]) => [id, { '@type': 'Location', name }]));
  }
  if (v.links) {
    patch.virtualLocations = Object.fromEntries(v.links.entries.map(([id, uri]) => [id, { '@type': 'VirtualLocation', uri }]));
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * What a counter proposal would change, for the organizer to review, each
 * before and after: the same values buildProposalPatch writes. Times go
 * through `formatDateTime` (an ISO instant, a floating wall clock, or a date).
 */
export function buildInvitationChangeItems(
  current: Partial<CalendarEvent> | null,
  proposed: Partial<CalendarEvent> | null,
  formatDateTime: (iso: string | null) => string,
): InvitationChangeItem[] {
  if (!current || !proposed) return [];
  const v = reviewedValues(current, proposed);
  const schedule = (span: ReturnType<typeof eventSpan>) => (span
    ? `${formatDateTime(span.start)}${span.end ? ` - ${formatDateTime(span.end)}` : ''}`
    : null);
  const changes: InvitationChangeItem[] = [];
  if (v.title) changes.push({ label: 'title', ...v.title });
  if (v.time) changes.push({ label: 'time', before: schedule(v.time.before), after: schedule(v.time.after) ?? '' });
  if (v.locations) changes.push({ label: 'location', before: v.locations.before, after: v.locations.after });
  if (v.links) changes.push({ label: 'virtual_location', before: v.links.before, after: v.links.after });
  if (v.description) changes.push({ label: 'description', ...v.description });
  return changes;
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

/**
 * Whether "Apply proposal" is offered: a counter, to its organizer, for the
 * stored event in the user's own calendar (not a shared one), with something
 * to change, all of it in the change list. Not on a recurring event or an
 * occurrence of one: the proposal names one occurrence's times, and patching
 * the stored event with them would move the whole series.
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
  if (existing.recurrenceRules?.length || existing.recurrenceId || proposed?.recurrenceId) return false;
  if (existing.baseEventId && existing.baseEventId !== (existing.originalId ?? existing.id)) return false;
  return true;
}
