import type { CalendarEvent, Participant, Email, Attachment, BodyPart, EmailAddress } from '../api/types';

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

export interface AuthenticationResults {
  spf?: { result: string; domain?: string };
  dkim?: { result: string; domain?: string; selector?: string };
  dmarc?: { result: string; domain?: string; policy?: string };
}

/** Parse an Authentication-Results header into SPF / DKIM / DMARC results. */
export function parseAuthenticationResults(header: string): AuthenticationResults {
  const results: AuthenticationResults = {};
  // A header can carry several SPF results (HELO and MAIL FROM); the MAIL FROM
  // identity is primary, another identity may only escalate to a failure.
  const spfRegex = /spf=(\w+)(?:\s+\([^)]*\))?(?:\s+smtp\.(mailfrom|helo)=([^\s;]+))?/g;
  const severity: Record<string, number> = {
    fail: 6, softfail: 5, permerror: 4, temperror: 3, neutral: 2, none: 1, pass: 0,
  };
  const spf: Array<{ result: string; identity?: string; domain?: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = spfRegex.exec(header)) !== null) {
    spf.push({ result: m[1].toLowerCase(), identity: m[2], domain: m[3] });
  }
  if (spf.length > 0) {
    let primary = spf.find((e) => e.identity === 'mailfrom') ?? spf[0];
    for (const cur of spf) {
      const s = severity[cur.result] ?? -1;
      if (s >= severity.temperror && s > (severity[primary.result] ?? -1)) primary = cur;
    }
    results.spf = { result: primary.result, domain: primary.domain };
  }
  const dkim = header.match(/dkim=(\w+)(?:\s+header\.d=([^\s;]+))?(?:\s+header\.s=([^\s;]+))?/);
  if (dkim) results.dkim = { result: dkim[1].toLowerCase(), domain: dkim[2], selector: dkim[3] };
  const dmarc = header.match(/dmarc=(\w+)(?:\s+header\.from=([^\s;]+))?(?:\s+policy\.dmarc=(\w+))?/);
  if (dmarc) results.dmarc = { result: dmarc[1].toLowerCase(), domain: dmarc[2], policy: dmarc[3] };
  return results;
}

/** Authentication results of an email, derived from its raw headers. */
export function getEmailAuthenticationResults(
  email?: Pick<Email, 'headers'> | null,
): AuthenticationResults | null {
  if (!email?.headers) return null;
  const values = email.headers
    .filter((h) => h.name.toLowerCase() === 'authentication-results')
    .map((h) => h.value);
  if (values.length === 0) return null;
  // Merge: the first (outermost, added by our own server) header wins per
  // mechanism; later ones only fill gaps.
  const merged: AuthenticationResults = {};
  for (const value of values) {
    const parsed = parseAuthenticationResults(value);
    if (!merged.spf && parsed.spf) merged.spf = parsed.spf;
    if (!merged.dkim && parsed.dkim) merged.dkim = parsed.dkim;
    if (!merged.dmarc && parsed.dmarc) merged.dmarc = parsed.dmarc;
  }
  return merged;
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
