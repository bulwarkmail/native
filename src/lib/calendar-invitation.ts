import type { CalendarEvent, Participant, Email, Attachment, BodyPart, EmailAddress } from '../api/types';
import { parseDuration, parseLocalDateTime } from './calendar-utils';
import { getEffectiveTimeZone, isValidTimeZone, localDateTimeToInstant, toDisplayDate } from './calendar-timezone';

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

interface SpfCheck {
  result: string;
  identity?: string;
  domain?: string;
}

interface DkimCheck {
  result: string;
  domain?: string;
  selector?: string;
}

export interface AuthenticationResults {
  /** The headline result; `all` every identity checked (MAIL FROM, HELO). */
  spf?: SpfCheck & { all?: SpfCheck[] };
  /** The first signature; `all` every one the header lists. */
  dkim?: DkimCheck & { all?: DkimCheck[] };
  dmarc?: { result: string; domain?: string; policy?: string };
}

interface ResInfo {
  method: string;
  result: string;
  props: Record<string, string>;
}

// The parser below is a port of parseAuthenticationResults in
// lib/email-headers.ts on the reading branch (fx/read), which this branch
// can't import yet: switch to that export (and its
// hasAlignedAuthenticationPass) once both are merged.

/**
 * Split one Authentication-Results header into its `;`-separated parts
 * (RFC 8601), dropping comments. A `;` inside a quoted string or a comment
 * does not split: both can carry sender-chosen text such as the envelope
 * address.
 */
function splitResinfo(header: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (c === '\\' && (quoted || depth > 0)) {
      if (depth === 0) current += c + (header[i + 1] ?? '');
      i++;
      continue;
    }
    if (quoted) {
      current += c;
      if (c === '"') quoted = false;
      continue;
    }
    if (c === '(') {
      depth++;
      continue;
    }
    if (depth > 0) {
      if (c === ')' && --depth === 0) current += ' ';
      continue;
    }
    if (c === '"') quoted = true;
    if (c === ';') {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

const METHOD_RE = /^([a-z0-9][a-z0-9_-]*)(?:\/\d+)?\s*=\s*([a-z]+)(?=\s|$)/i;
const PROP_RE = /\s*([^\s=]+)\s*=\s*("(?:[^"\\]|\\.)*"|\S*)/y;

/**
 * Read one resinfo: the method must open the part, so a `dmarc=pass` that
 * appears inside a property value (say an envelope local part in
 * `smtp.mailfrom=`) is never taken for a result.
 */
function parseResinfo(part: string): ResInfo | null {
  const match = METHOD_RE.exec(part);
  if (!match) return null;
  const props: Record<string, string> = {};
  const rest = part.slice(match[0].length);
  PROP_RE.lastIndex = 0;
  let prop: RegExpExecArray | null;
  while ((prop = PROP_RE.exec(rest)) !== null && prop[0].length > 0) {
    const key = prop[1].toLowerCase();
    let value = prop[2];
    if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    if (!(key in props)) props[key] = value;
  }
  return { method: match[1].toLowerCase(), result: match[2].toLowerCase(), props };
}

const SPF_SEVERITY: Record<string, number> = {
  fail: 6, softfail: 5, permerror: 4, temperror: 3, neutral: 2, none: 1, pass: 0,
};

const DMARC_SEVERITY: Record<string, number> = { fail: 3, permerror: 2, temperror: 2, none: 1, pass: 0 };

/**
 * Parse Authentication-Results headers, in message order, into SPF, DKIM
 * and DMARC results. The topmost header is the receiving server's own;
 * anything below it may have been written by the sender, so DKIM and DMARC
 * come from the topmost header only, and the others can only escalate SPF
 * to a failure, never supply a pass. A method counts only where it opens a
 * `;`-separated part: matched anywhere in the header, a `dkim=pass` written
 * into a comment or an envelope address passed for a result.
 */
export function parseAuthenticationResults(headers: string | readonly string[]): AuthenticationResults {
  const results: AuthenticationResults = {};
  const list = typeof headers === 'string' ? [headers] : headers;
  const perHeader = list.map((header) => splitResinfo(header)
    .map(parseResinfo)
    .filter((info): info is ResInfo => info !== null));
  const own = perHeader[0] ?? [];
  const foreign = perHeader.slice(1).flat();

  const severity = (r: string) => SPF_SEVERITY[r] ?? -1;
  const isFailure = (r: string) => severity(r) >= SPF_SEVERITY.temperror;
  const toSpfCheck = (info: ResInfo): SpfCheck => {
    const identity = info.props['smtp.mailfrom'] !== undefined
      ? 'mailfrom'
      : info.props['smtp.helo'] !== undefined ? 'helo' : undefined;
    return { result: info.result, identity, domain: identity ? info.props[`smtp.${identity}`] || undefined : undefined };
  };
  const spf: SpfCheck[] = [
    ...own.filter((info) => info.method === 'spf').map(toSpfCheck),
    ...foreign.filter((info) => info.method === 'spf').map(toSpfCheck).filter((e) => isFailure(e.result)),
  ];
  if (spf.length > 0) {
    // The MAIL FROM identity is primary; another one (HELO) may only
    // escalate the headline to a failure.
    let primary = spf.find((e) => e.identity === 'mailfrom') ?? spf[0];
    for (const cur of spf) {
      if (isFailure(cur.result) && severity(cur.result) > severity(primary.result)) primary = cur;
    }
    results.spf = { ...primary, all: spf };
  }

  // A message can carry several signatures (the sender's and a mailing
  // list's or a sending service's): alignment looks at each.
  const dkim: DkimCheck[] = own
    .filter((info) => info.method === 'dkim')
    .map((info) => ({ result: info.result, domain: info.props['header.d'], selector: info.props['header.s'] }));
  if (dkim.length > 0) results.dkim = { ...dkim[0], all: dkim };

  // One DMARC verdict per message; should the header carry several, the
  // most severe stands.
  const dmarc = own
    .filter((info) => info.method === 'dmarc')
    .reduce<ResInfo | undefined>(
      (worst, info) => (!worst || (DMARC_SEVERITY[info.result] ?? -1) > (DMARC_SEVERITY[worst.result] ?? -1) ? info : worst),
      undefined,
    );
  if (dmarc) results.dmarc = { result: dmarc.result, domain: dmarc.props['header.from'], policy: dmarc.props['policy.dmarc'] };
  return results;
}

/** Authentication results of an email, from its Authentication-Results headers in message order. */
export function getEmailAuthenticationResults(
  email?: Pick<Email, 'headers'> | null,
): AuthenticationResults | null {
  if (!email?.headers) return null;
  const values = email.headers
    .filter((h) => h.name.toLowerCase() === 'authentication-results')
    .map((h) => h.value);
  if (values.length === 0) return null;
  return parseAuthenticationResults(values);
}

function domainOf(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const domain = address.slice(address.lastIndexOf('@') + 1).trim().toLowerCase().replace(/\.$/, '');
  return /^[^\s<>@]+\.[^\s<>@]+$/.test(domain) ? domain : undefined;
}

/**
 * Whether `candidate` is the From domain or a parent or child of it: the
 * relaxed alignment DMARC applies, without a public-suffix list.
 */
function alignedWith(fromDomain: string, candidate: string | undefined): boolean {
  const other = domainOf(candidate);
  if (!other) return false;
  return other === fromDomain || other.endsWith(`.${fromDomain}`) || fromDomain.endsWith(`.${other}`);
}

/**
 * Whether the receiving server's checks tie the message to the domain of its
 * From address: a DMARC pass, or an SPF (MAIL FROM, never HELO) or DKIM pass
 * for a domain aligned with it. A bare pass says nothing about the visible
 * sender: anyone passes SPF for an envelope domain of their own, or signs
 * with their own key, and still writes the organizer's address in From; with
 * no DMARC policy on that domain the verdict is `dmarc=none` (#1374). Mirrors
 * the webmail's hasAlignedAuthenticationPass.
 */
export function hasAlignedAuthenticationPass(
  auth: AuthenticationResults | null | undefined,
  fromEmail: string | null | undefined,
): boolean {
  if (!auth || !fromEmail) return false;
  const fromDomain = domainOf(fromEmail);
  if (!fromDomain) return false;
  if (auth.dmarc?.result === 'pass') return true;
  const spf = auth.spf?.all ?? (auth.spf ? [auth.spf] : []);
  if (spf.some((e) => e.identity !== 'helo' && e.result === 'pass' && alignedWith(fromDomain, e.domain))) return true;
  const dkim = auth.dkim?.all ?? (auth.dkim ? [auth.dkim] : []);
  return dkim.some((e) => e.result === 'pass' && alignedWith(fromDomain, e.domain));
}

function hasAuthenticationFailure(auth?: AuthenticationResults | null): boolean {
  // DMARC passed on the receiving server's own header: one aligned method
  // passed, and that is the verdict. A mailing list's or a forwarder's
  // signature that broke on the way, listed first, flagged such a message.
  if (auth?.dmarc?.result === 'pass') return false;
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
 *
 * `ownAddresses` are the reader's own addresses. Mail from another user on
 * the reader's domains that carries no Authentication-Results header at all
 * was handed in by a signed-in user rather than received from outside:
 * Stalwart adds the header to everything that arrives on port 25 (#1374).
 */
export function getInvitationTrustAssessment(
  event: Partial<CalendarEvent>,
  email?: Pick<Email, 'from' | 'replyTo' | 'headers'> | null,
  method: InvitationMethod = inferInvitationMethod(event),
  ownAddresses: readonly string[] = [],
): InvitationTrustAssessment {
  const organizerEmail = getOrganizerEmail(event);
  const senderEmail = getPrimaryAddressEmail(email?.from) || getPrimaryAddressEmail(email?.replyTo);
  const auth = getEmailAuthenticationResults(email);
  const verified = hasAlignedAuthenticationPass(auth, getPrimaryAddressEmail(email?.from));
  const failed = hasAuthenticationFailure(auth);
  const senderMismatch = Boolean(senderEmail && organizerEmail && senderEmail !== organizerEmail);
  const senderDomain = domainOf(senderEmail ?? undefined);
  const internal = Boolean(email && !auth && senderDomain
    && ownAddresses.some((address) => domainOf(address) === senderDomain));
  const expectsAuthenticatedTransport = method !== 'unknown' && !internal;

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

// ─── When ────────────────────────────────────────────────

/** What the invitation banner shows as an event's time. */
export interface InvitationDisplayRange {
  /** Display dates (see toDisplayDate): their local fields are what to show. */
  start: Date;
  end: Date | null;
  /**
   * The real start instant, for an event at a fixed moment (a UTC time or a
   * zoned wall clock) shown in the user's zone: worth a zone label. Unset
   * for all-day and floating events, which read the same everywhere.
   */
  instant?: Date;
}

const HAS_UTC_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * The banner's start and end of an invitation. CalendarEvent/parse gives
 * `start` as a wall clock in `timeZone` and no `utcStart`, so the start has
 * to be resolved in that zone and shown in the user's: read as a device
 * time, it showed the organizer's clock without saying so (webmail #1252).
 * An all-day event gets its last day (the end is exclusive) or none for a
 * single day; a floating time stays as written.
 */
export function getInvitationDisplayRange(
  event: Partial<Pick<CalendarEvent, 'start' | 'duration' | 'timeZone' | 'showWithoutTime' | 'utcStart' | 'utcEnd'>>,
): InvitationDisplayRange | null {
  if (!event.start) return null;
  const durationMs = parseDuration(event.duration);
  if (event.showWithoutTime) {
    const start = parseLocalDateTime(event.start.slice(0, 10));
    if (isNaN(start.getTime())) return null;
    const days = Math.round(durationMs / 86_400_000);
    if (days <= 1) return { start, end: null };
    const last = new Date(start);
    last.setDate(last.getDate() + days - 1);
    return { start, end: last };
  }

  let instant: Date | null = null;
  if (event.utcStart) instant = new Date(event.utcStart);
  else if (HAS_UTC_OFFSET.test(event.start)) instant = new Date(event.start);
  else if (event.timeZone && isValidTimeZone(event.timeZone)) instant = localDateTimeToInstant(event.start, event.timeZone);
  if (instant && !isNaN(instant.getTime())) {
    let end: Date | null = event.utcEnd ? new Date(event.utcEnd) : null;
    if ((!end || isNaN(end.getTime())) && durationMs > 0) end = new Date(instant.getTime() + durationMs);
    return {
      start: toDisplayDate(instant),
      end: end && !isNaN(end.getTime()) && end.getTime() > instant.getTime() ? toDisplayDate(end) : null,
      instant,
    };
  }

  // Floating: the same wall clock everywhere.
  const start = parseLocalDateTime(event.start);
  if (isNaN(start.getTime())) return null;
  return { start, end: durationMs > 0 ? new Date(start.getTime() + durationMs) : null };
}

/** The short name of the user's calendar zone at `instant` ("CET", "GMT+1"), or null. */
export function invitationZoneLabel(instant: Date, locale?: string): string | null {
  try {
    const part = new Intl.DateTimeFormat(locale, { timeZone: getEffectiveTimeZone(), timeZoneName: 'short' })
      .formatToParts(instant)
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? null;
  } catch {
    return null;
  }
}
