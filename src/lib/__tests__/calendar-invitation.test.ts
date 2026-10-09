import { describe, it, expect } from 'vitest';
import type { Email } from '../../api/types';
import {
  calendarInvitationKey,
  extractMethodFromContentType,
  extractMethodFromRawIcs,
  findCalendarAttachment,
  getEmailAuthenticationResults,
  getInvitationActorSummary,
  getInvitationMethod,
  getInvitationTrustAssessment,
  formatInvitationActor,
  getOrganizerEmail,
  getOrganizerName,
  invitationSentFrom,
  buildProposalPatch,
  buildInvitationChangeItems,
  canApplyProposal,
  isUserOrganizer,
  patchIsShown,
  reviewCounterProposal,
  proposalStillMatches,
  isSameInvitationEvent,
  mayImportOver,
  withFetchedDescriptionType,
  invitationBannerDetails,
} from '../calendar-invitation';
import type { CalendarEvent } from '../../api/types';
import { parseAuthenticationResults } from '../email-headers';

const request = {
  organizerCalendarAddress: 'mailto:alice@example.com',
  participants: {
    a: { calendarAddress: 'mailto:alice@example.com', roles: { owner: true } },
    b: { calendarAddress: 'mailto:bob@example.com', roles: { attendee: true }, participationStatus: 'needs-action' },
  },
};

function email(overrides: Partial<Email>): Email {
  return {
    id: 'e1', threadId: 't1', mailboxIds: {}, keywords: {}, size: 1, receivedAt: '', hasAttachment: true,
    ...overrides,
  } as Email;
}

describe('method detection', () => {
  it('reads method= from a Content-Type parameter', () => {
    expect(extractMethodFromContentType('text/calendar; charset=utf-8; method=REQUEST')).toBe('request');
    expect(extractMethodFromContentType('text/calendar; method="CANCEL"')).toBe('cancel');
    expect(extractMethodFromContentType('text/calendar')).toBe('unknown');
  });

  it('reads METHOD from raw ICS text', () => {
    expect(extractMethodFromRawIcs('BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nBEGIN:VEVENT')).toBe('reply');
    expect(extractMethodFromRawIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT')).toBe('unknown');
  });

  it('prefers the explicit method over the raw ICS over the inferred one', () => {
    expect(getInvitationMethod(request, { attachment: { type: 'text/calendar; method=CANCEL' } })).toBe('cancel');
    expect(getInvitationMethod(request, { rawIcs: 'METHOD:REPLY\n' })).toBe('reply');
    expect(getInvitationMethod(request)).toBe('request');
    // A REPLY without participant signals is no longer treated as a request.
    expect(getInvitationMethod({ title: 'x' }, { rawIcs: 'METHOD:REPLY\n' })).toBe('reply');
  });

  it('finds inline text/calendar body parts, not just attachments', () => {
    const e = email({
      attachments: [],
      textBody: [{ partId: '1', blobId: 'b1', type: 'text/plain' }],
      htmlBody: [{ partId: '2', blobId: 'b2', type: 'text/calendar', name: 'invite.ics' }],
    });
    expect(findCalendarAttachment(e)?.blobId).toBe('b2');
    expect(findCalendarAttachment(email({ attachments: [{ blobId: 'b3', type: 'application/ics' }] }))?.blobId).toBe('b3');
  });
});

describe('authentication results', () => {
  it('parses spf/dkim/dmarc from the header', () => {
    const parsed = parseAuthenticationResults(
      'mx.example.com; dkim=pass header.d=example.com header.s=sel; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com',
    );
    expect(parsed.spf?.result).toBe('pass');
    expect(parsed.dkim).toEqual({ result: 'pass', domain: 'example.com', selector: 'sel' });
    expect(parsed.dmarc?.result).toBe('pass');
  });

  it('lets a HELO failure escalate but not a HELO none downgrade', () => {
    expect(parseAuthenticationResults('spf=pass smtp.mailfrom=a.com; spf=none smtp.helo=b.com').spf?.result).toBe('pass');
    expect(parseAuthenticationResults('spf=pass smtp.mailfrom=a.com; spf=fail smtp.helo=b.com').spf?.result).toBe('fail');
  });

  it('does not take a pass from a lower, sender-written header', () => {
    const forged = email({
      from: [{ email: 'alice@example.com' }],
      headers: [
        { name: 'Authentication-Results', value: 'mx.example; spf=fail smtp.mailfrom=evil.example; dkim=none; dmarc=fail header.from=bank.example' },
        { name: 'Authentication-Results', value: 'evil.example; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example' },
      ],
    });
    const auth = getEmailAuthenticationResults(forged, 'mx.example');
    expect(auth?.dmarc?.result).toBe('fail');
    expect(auth?.dkim?.result).not.toBe('pass');
    expect(getInvitationTrustAssessment(request, forged, 'request', { serverHost: 'mx.example' }).level).toBe('warning');
  });

  it('does not let a lower header fill a mechanism the topmost one omits', () => {
    const forged = email({
      from: [{ email: 'alice@example.com' }],
      headers: [
        { name: 'Authentication-Results', value: 'mx.example; spf=none smtp.mailfrom=evil.example' },
        { name: 'Authentication-Results', value: 'evil.example; dkim=pass header.d=example.com; dmarc=pass header.from=example.com' },
      ],
    });
    const auth = getEmailAuthenticationResults(forged, 'mx.example');
    expect(auth?.dkim?.result).not.toBe('pass');
    expect(auth?.dmarc?.result).not.toBe('pass');
    expect(getInvitationTrustAssessment(request, forged, 'request', { serverHost: 'mx.example' }).reason).toBe('authentication_missing');
  });

  it('never verifies an invitation whose only pass is under a foreign authserv-id', () => {
    const forgedPass = email({
      from: [{ email: 'alice@example.com' }],
      headers: [{ name: 'Authentication-Results', value: 'evil.example; dkim=pass header.d=example.com; dmarc=pass header.from=example.com' }],
    });
    expect(getEmailAuthenticationResults(forgedPass, 'jmap.example.com')).toBeNull();
    expect(getInvitationTrustAssessment(request, forgedPass, 'request', { serverHost: 'jmap.example.com' }).reason).toBe('authentication_missing');
    // Without a known host nothing is trusted at all.
    expect(getInvitationTrustAssessment(request, forgedPass, 'request').reason).toBe('authentication_missing');
  });

  it('reads the Authentication-Results header from the email headers', () => {
    const e = email({ headers: [{ name: 'Authentication-Results', value: 'x; dmarc=fail header.from=evil.com' }] });
    expect(getEmailAuthenticationResults(e, 'x')?.dmarc?.result).toBe('fail');
    expect(getEmailAuthenticationResults(email({}), 'x')).toBeNull();
  });
});

describe('getInvitationTrustAssessment', () => {
  it('is trusted for an authenticated organizer', () => {
    const e = email({
      from: [{ email: 'alice@example.com' }],
      headers: [{ name: 'Authentication-Results', value: 'x; dkim=pass header.d=example.com' }],
    });
    expect(getInvitationTrustAssessment(request, e, 'request', { serverHost: 'x' }).level).toBe('trusted');
  });

  it('warns when the sender differs from the organizer and is unverified', () => {
    const e = email({ from: [{ email: 'mallory@evil.com' }] });
    const a = getInvitationTrustAssessment(request, e, 'request', { serverHost: 'x' });
    expect(a.level).toBe('warning');
    expect(a.reason).toBe('sender_mismatch_unverified');
  });

  it('warns on authentication failure and cautions on a verified mismatch', () => {
    const failed = email({
      from: [{ email: 'alice@example.com' }],
      headers: [{ name: 'Authentication-Results', value: 'x; spf=fail smtp.mailfrom=example.com' }],
    });
    expect(getInvitationTrustAssessment(request, failed, 'request', { serverHost: 'x' }).reason).toBe('authentication_failed');
    const mismatch = email({
      from: [{ email: 'assistant@example.com' }],
      headers: [{ name: 'Authentication-Results', value: 'x; dmarc=pass header.from=example.com' }],
    });
    expect(getInvitationTrustAssessment(request, mismatch, 'request', { serverHost: 'x' })).toMatchObject({ level: 'caution', reason: 'sender_mismatch' });
  });

  it('cautions when a scheduling message carries no authentication at all', () => {
    const e = email({ from: [{ email: 'alice@example.com' }] });
    expect(getInvitationTrustAssessment(request, e, 'request', { serverHost: 'x' }).reason).toBe('authentication_missing');
    expect(getInvitationTrustAssessment(request, e, 'unknown', { serverHost: 'x' }).reason).toBe('authentication_missing');
  });

  it('never calls an invitation with no METHOD and no organizer verified without a pass', () => {
    // Nobody to compare the sender with must not read as "Sender verified".
    const bare = { uid: 'u1', title: 'Payment overdue' };
    const e = email({ from: [{ email: 'billing@yourbank.example' }] });
    expect(getInvitationTrustAssessment(bare, e, undefined, { serverHost: 'x' })).toMatchObject({ level: 'caution', reason: 'authentication_missing' });
    expect(getInvitationTrustAssessment(bare, email({}), 'unknown', { serverHost: 'x' }).level).not.toBe('trusted');
    const passed = email({
      from: [{ email: 'billing@yourbank.example' }],
      headers: [{ name: 'Authentication-Results', value: 'x; dmarc=pass header.from=yourbank.example' }],
    });
    expect(getInvitationTrustAssessment(bare, passed, 'unknown', { serverHost: 'x' }).level).toBe('trusted');
  });
});

describe('calendarInvitationKey', () => {
  const invite = {
    id: 'e1',
    keywords: {},
    attachments: [{ blobId: 'b1', type: 'text/calendar', name: 'invite.ics', size: 10 }],
  } as unknown as Email;

  it('stays the same when only the keywords change', () => {
    const read = { ...invite, keywords: { $seen: true } } as Email;
    const key = calendarInvitationKey(invite, findCalendarAttachment(invite), 'group');
    expect(key).toBe('group|e1|b1');
    expect(calendarInvitationKey(read, findCalendarAttachment(read), 'group')).toBe(key);
  });

  it('differs per account and calendar part, and is null without one', () => {
    const other = { ...invite, attachments: [{ ...invite.attachments![0], blobId: 'b2' }] } as Email;
    expect(calendarInvitationKey(invite, findCalendarAttachment(invite))).toBe('|e1|b1');
    expect(calendarInvitationKey(other, findCalendarAttachment(other))).toBe('|e1|b2');
    expect(calendarInvitationKey({ id: 'e2' }, null)).toBeNull();
  });
});

describe('invitation actor', () => {
  const replyEvent = {
    organizerCalendarAddress: 'mailto:alice@example.com',
    participants: {
      a: { name: 'Alice', calendarAddress: 'mailto:alice@example.com', roles: { attendee: true } },
      c: { name: 'Carol', calendarAddress: 'mailto:carol@example.com', roles: { attendee: true }, participationStatus: 'needs-action' as const },
      b: {
        name: 'Bob', calendarAddress: 'mailto:bob@example.com', roles: { attendee: true },
        participationStatus: 'accepted' as const, participationComment: 'See you',
      },
    },
  };

  it('names the responding attendee for a reply, with their status and note', () => {
    expect(getInvitationActorSummary(replyEvent, 'reply')).toMatchObject({
      name: 'Bob', email: 'bob@example.com', role: 'attendee',
      participationStatus: 'accepted', participationComment: 'See you',
    });
  });

  it('names the organizer for a request, finding it by organizerCalendarAddress on Stalwart', () => {
    // Stalwart marks no owner/chair role; the organizer is only known by address.
    expect(getInvitationActorSummary(replyEvent, 'request')).toMatchObject({
      name: 'Alice', email: 'alice@example.com', role: 'organizer', participationComment: null,
    });
    expect(getInvitationActorSummary(request, 'cancel')).toMatchObject({ email: 'alice@example.com', role: 'organizer' });
  });

  it('names the attendee who proposed a change, never the organizer', () => {
    expect(getInvitationActorSummary(replyEvent, 'counter')?.name).toBe('Bob');
    expect(getInvitationActorSummary(request, 'refresh')).toMatchObject({ email: 'bob@example.com', role: 'attendee' });
  });

  it('names a chair attendee who answers, keeping the organizer out', () => {
    const chaired = {
      organizerCalendarAddress: 'mailto:alice@example.com',
      participants: {
        a: { name: 'Alice', calendarAddress: 'mailto:alice@example.com', roles: { owner: true } },
        b: {
          name: 'Bob', calendarAddress: 'mailto:bob@example.com', roles: { attendee: true, chair: true },
          participationStatus: 'accepted' as const,
        },
      },
    };
    expect(getInvitationActorSummary(chaired, 'reply')).toMatchObject({ email: 'bob@example.com', role: 'attendee' });
  });

  it('returns null without participants', () => {
    expect(getInvitationActorSummary({ title: 'x' }, 'request')).toBeNull();
    expect(getInvitationActorSummary({ participants: {} }, 'reply')).toBeNull();
  });
});

describe('formatInvitationActor', () => {
  // The name in an invitation is the sender's to write; the address shows too,
  // so "Your Bank" alone can't stand in for who sent it.
  it('shows the address beside a name', () => {
    expect(formatInvitationActor({ name: 'Your Bank', email: 'x@evil.example' })).toBe('Your Bank <x@evil.example>');
  });

  it('shows the address alone when the name is the address or missing', () => {
    expect(formatInvitationActor({ name: 'a@b.example', email: 'a@b.example' })).toBe('a@b.example');
    expect(formatInvitationActor({ name: null, email: 'a@b.example' })).toBe('a@b.example');
  });

  it('keeps direction controls and line breaks out of both', () => {
    expect(formatInvitationActor({ name: 'Bank\u202e\nverified', email: 'x@\u2066evil.example' })).toBe('Bank verified <x@evil.example>');
  });

  it('gives null with neither', () => {
    expect(formatInvitationActor({ name: null, email: null })).toBeNull();
  });
});

describe('the actor address is the one the trust row checked', () => {
  const verifiedFrom = (from: string) => email({
    from: [{ email: from }],
    headers: [{ name: 'Authentication-Results', value: 'x; dkim=pass header.d=evil.example; dmarc=pass header.from=evil.example' }],
  });

  it('shows an organizer at its calendar address, not the EMAIL= it gives itself', () => {
    const event = {
      organizerCalendarAddress: 'mailto:mallory@evil.example',
      participants: {
        o: { name: 'Your Bank', email: 'security@bank.example', calendarAddress: 'mailto:mallory@evil.example', roles: { owner: true } },
        b: { name: 'Bob', calendarAddress: 'mailto:bob@example.com', roles: { attendee: true } },
      },
    };
    const trust = getInvitationTrustAssessment(event, verifiedFrom('mallory@evil.example'), 'request', { serverHost: 'x' });
    const actor = getInvitationActorSummary(event, 'request')!;
    expect(actor.email).toBe('mallory@evil.example');
    expect(actor.email).toBe(trust.organizerEmail);
    expect(formatInvitationActor(actor)).toBe('Your Bank <mallory@evil.example>');
    expect(invitationSentFrom(actor.email, trust.senderEmail)).toBeNull();
    // Without organizerCalendarAddress, the owner's calendar address still wins.
    const { organizerCalendarAddress: _drop, ...noStored } = event;
    expect(getInvitationActorSummary(noStored, 'request')?.email).toBe('mallory@evil.example');
    expect(getOrganizerEmail(noStored)).toBe('mallory@evil.example');
  });

  it('finds the organizer whatever the case of its address', () => {
    const event = {
      organizerCalendarAddress: 'MAILTO:Alice@Example.com',
      participants: {
        a: { name: 'Alice', calendarAddress: 'mailto:alice@example.com', roles: { attendee: true } },
        b: { name: 'Bob', calendarAddress: 'mailto:bob@example.com', roles: { attendee: true }, participationStatus: 'accepted' as const },
      },
    };
    expect(getInvitationActorSummary(event, 'request')).toMatchObject({ name: 'Alice', email: 'alice@example.com', role: 'organizer' });
    expect(getOrganizerName(event)).toBe('Alice');
    // Alice is the organizer, so a reply comes from Bob.
    expect(getInvitationActorSummary(event, 'reply')?.name).toBe('Bob');
  });

  it('never credits an attendee with what only an organizer sends', () => {
    const missing = {
      organizerCalendarAddress: 'mailto:alice@example.com',
      participants: {
        b: { name: 'Bob', calendarAddress: 'mailto:bob@example.com', roles: { attendee: true }, participationStatus: 'accepted' as const },
      },
    };
    for (const method of ['request', 'publish', 'add', 'cancel', 'declinecounter'] as const) {
      expect(getInvitationActorSummary(missing, method)).toMatchObject({ name: null, email: 'alice@example.com', role: 'organizer' });
    }
    // An owner at another address than the stored organizer is not it.
    const otherOwner = {
      organizerCalendarAddress: 'mailto:alice@example.com',
      participants: {
        o: { name: 'Your Bank', calendarAddress: 'mailto:bank@evil.example', roles: { owner: true } },
      },
    };
    expect(getInvitationActorSummary(otherOwner, 'request')).toMatchObject({ name: null, email: 'alice@example.com' });
    expect(getOrganizerName(otherOwner)).toBe('alice@example.com');
    // No organizer at all: "Someone", with no address.
    const none = { participants: { b: missing.participants.b } };
    expect(getInvitationActorSummary(none, 'request')).toMatchObject({ name: null, email: null });
  });

  it('names the From too when it is not the actor', () => {
    const reply = {
      organizerCalendarAddress: 'mailto:alice@example.com',
      participants: {
        a: { calendarAddress: 'mailto:alice@example.com', roles: { owner: true } },
        b: { name: 'Bob', calendarAddress: 'mailto:bob@example.com', email: 'bob@other.example', roles: { attendee: true }, participationStatus: 'accepted' as const },
      },
    };
    const actor = getInvitationActorSummary(reply, 'reply')!;
    expect(actor.email).toBe('bob@example.com');
    const fromBob = getInvitationTrustAssessment(reply, email({ from: [{ email: 'Bob@Example.com' }] }), 'reply', { serverHost: 'x' });
    expect(invitationSentFrom(actor.email, fromBob.senderEmail)).toBeNull();
    const fromMallory = getInvitationTrustAssessment(reply, verifiedFrom('mallory@evil.example'), 'reply', { serverHost: 'x' });
    expect(invitationSentFrom(actor.email, fromMallory.senderEmail)).toBe('mallory@evil.example');
    expect(invitationSentFrom(null, 'mallory@evil.example')).toBe('mallory@evil.example');
    expect(invitationSentFrom('bob@example.com', null)).toBeNull();
  });
});

// The app's CalendarEvent type leaves descriptionContentType out; the server sends it.
const typed = (e: Record<string, unknown>) => e as Partial<CalendarEvent>;

describe('counter-proposal review', () => {
  it('patches only what the proposal changes', () => {
    expect(buildProposalPatch(
      { start: '2026-10-09T10:00:00', duration: 'PT1H', title: 'A' },
      { start: '2026-10-09T11:00:00', duration: 'PT1H', title: 'A' },
    )).toEqual({ start: '2026-10-09T11:00:00' });
  });

  it('patches a changed zone, all-day flag and location, keeping the location\'s stored detail', () => {
    expect(buildProposalPatch(
      { start: '2026-10-09T10:00:00', timeZone: 'Europe/Berlin', locations: { l: { name: 'Room 1', description: 'Floor 2' } } as CalendarEvent['locations'] },
      { start: '2026-10-09T10:00:00', timeZone: 'Europe/Paris', showWithoutTime: true, locations: { l: { name: 'Room 2', description: 'Sender text' } } as CalendarEvent['locations'] },
    )).toEqual({ timeZone: 'Europe/Paris', showWithoutTime: true, locations: { l: { name: 'Room 2', description: 'Floor 2' } } });
  });

  it('returns null when nothing differs', () => {
    const same = { start: '2026-10-09T10:00:00', duration: 'PT1H', title: 'A', locations: { l: { name: 'Room 1' } } as CalendarEvent['locations'] };
    expect(buildProposalPatch(same, { ...same })).toBeNull();
    expect(buildProposalPatch(null, same)).toBeNull();
    expect(buildProposalPatch(same, null)).toBeNull();
  });

  const iso = (value: string | null) => value ?? '';

  it('lists a moved time and a new location, before and after', () => {
    const current = {
      title: 'Planning', start: '2026-10-09T10:00:00', utcStart: '2026-10-09T08:00:00Z',
      timeZone: 'Europe/Berlin', duration: 'PT1H',
    };
    const proposed = {
      title: 'Planning', start: '2026-10-09T11:00:00', timeZone: 'Europe/Berlin', duration: 'PT1H',
      locations: { l: { name: 'Room 2' } } as CalendarEvent['locations'],
    };
    expect(buildInvitationChangeItems(current, proposed, iso)).toEqual([
      { label: 'time', before: '2026-10-09T08:00:00.000Z - 2026-10-09T09:00:00.000Z', after: '2026-10-09T09:00:00.000Z - 2026-10-09T10:00:00.000Z' },
      { label: 'location', before: null, after: 'Room 2' },
    ]);
  });

  it('sees no time change when the same instant is written two ways', () => {
    expect(buildInvitationChangeItems(
      { start: '2026-10-09T10:00:00', utcStart: '2026-10-09T08:00:00Z', timeZone: 'Europe/Berlin', duration: 'PT1H' },
      { start: '2026-10-09T10:00:00', timeZone: 'Europe/Berlin', duration: 'PT1H' },
      iso,
    )).toEqual([]);
  });

  it('shows an all-day change as calendar dates, the last day included', () => {
    expect(buildInvitationChangeItems(
      { start: '2026-10-09T00:00:00', showWithoutTime: true, duration: 'P1D' },
      { start: '2026-10-12T00:00:00', showWithoutTime: true, duration: 'P2D' },
      iso,
    )).toEqual([{ label: 'time', before: '2026-10-09', after: '2026-10-12 - 2026-10-13' }]);
  });

  it('shows the sender\'s title and description flattened, not raw', () => {
    const current = typed({ title: 'Old', description: '', descriptionContentType: null });
    const proposed = { title: 'New\u202e title\nline two', description: 'Line one\r\nLine\u200b two' };
    expect(buildInvitationChangeItems(current, proposed, iso)).toEqual([
      { label: 'title', before: 'Old', after: 'New title line two' },
      { label: 'description', before: null, after: 'Line one Line two' },
    ]);
    // Written with its line break kept, the hidden character gone.
    expect(buildProposalPatch(current, proposed)).toEqual({ title: 'New title line two', description: 'Line one\nLine two' });
  });

  it('refuses an over-long title or description instead of writing it cut', () => {
    const current = typed({ title: 'Old', description: 'd', descriptionContentType: 'text/plain' });
    expect(buildProposalPatch(current, { title: 'x'.repeat(201) })).toBeNull();
    expect(buildProposalPatch(current, { description: 'x'.repeat(2001) })).toBeNull();
    expect(buildProposalPatch(current, { title: 'x'.repeat(200) })).toEqual({ title: 'x'.repeat(200) });
  });

  it('reads the proposed time only from the start, zone and duration it writes', () => {
    // A sender-written utcStart is not what gets written: it must not shape the list.
    const items = buildInvitationChangeItems(
      { start: '2026-10-09T10:00:00', timeZone: 'Europe/Berlin', duration: 'PT1H' },
      { start: '2026-10-09T11:00:00', timeZone: 'Europe/Berlin', utcStart: '2026-10-09T08:00:00Z' },
      iso,
    );
    // No proposed duration: the event's hour stays, and the end shows it.
    expect(items).toEqual([{
      label: 'time',
      before: '2026-10-09T08:00:00.000Z - 2026-10-09T09:00:00.000Z',
      after: '2026-10-09T09:00:00.000Z - 2026-10-09T10:00:00.000Z',
    }]);
  });

  it('refuses a time that drops the event\'s zone or names an unknown one', () => {
    const zoned = { start: '2026-10-09T10:00:00', timeZone: 'Europe/Berlin', duration: 'PT1H' };
    expect(buildProposalPatch(zoned, { start: '2026-10-09T11:00:00', timeZone: null })).toBeNull();
    expect(buildProposalPatch(zoned, { start: '2026-10-09T11:00:00', timeZone: 'Mars/Olympus' })).toBeNull();
    expect(buildProposalPatch(zoned, { start: 'tomorrow', timeZone: 'Europe/Berlin' })).toBeNull();
  });

  it('lists nothing without both events', () => {
    expect(buildInvitationChangeItems(null, { title: 'A' }, iso)).toEqual([]);
  });

  const ok = {
    method: 'counter' as const,
    userIsOrganizer: true,
    existing: { id: 'ev1', baseEventId: 'ev1', title: 'A' } as Partial<CalendarEvent>,
    patch: { start: '2026-10-09T11:00:00' } as Partial<CalendarEvent>,
    changes: [{ label: 'time' as const, before: 'a', after: 'b' }],
  };

  it('offers Apply only to the organizer of an own, existing event on a counter', () => {
    expect(canApplyProposal(ok)).toBe(true);
    expect(canApplyProposal({ ...ok, existing: { ...ok.existing, isShared: true } })).toBe(false);
    expect(canApplyProposal({ ...ok, method: 'reply' })).toBe(false);
    expect(canApplyProposal({ ...ok, userIsOrganizer: false })).toBe(false);
    expect(canApplyProposal({ ...ok, existing: null })).toBe(false);
    expect(canApplyProposal({ ...ok, existing: { title: 'A' } })).toBe(false);
    expect(canApplyProposal({ ...ok, patch: null })).toBe(false);
  });

  it('does not offer Apply on a recurring event, where the patch would move the whole series', () => {
    expect(canApplyProposal({ ...ok, existing: { ...ok.existing, recurrenceRules: [{ frequency: 'weekly' }] as CalendarEvent['recurrenceRules'] } })).toBe(false);
    // An expanded occurrence (synthetic id) is not the stored event.
    expect(canApplyProposal({ ...ok, existing: { ...ok.existing, id: 'syn1', baseEventId: 'ev1' } })).toBe(false);
    expect(canApplyProposal({ ...ok, proposed: { recurrenceId: '2026-10-09T10:00:00' } })).toBe(false);
  });
});

describe('a counter proposal writes only what the organizer was shown', () => {
  const iso = (value: string | null) => value ?? '';
  const vl = (uri: string, extra: Record<string, unknown> = {}) =>
    ({ v: { uri, ...extra } }) as unknown as CalendarEvent['virtualLocations'];

  it('shows a swapped meeting link, before and after, and writes only the link', () => {
    const current = { virtualLocations: vl('https://meet.example.com/a') };
    const proposed = { virtualLocations: vl('https://evil.example.net/a', { name: 'Hidden name', description: 'x' }) };
    expect(buildInvitationChangeItems(current, proposed, iso)).toEqual([
      { label: 'virtual_location', before: 'https://meet.example.com/a', after: 'https://evil.example.net/a' },
    ]);
    expect(buildProposalPatch(current, proposed)).toEqual({
      virtualLocations: { v: { '@type': 'VirtualLocation', uri: 'https://evil.example.net/a' } },
    });
  });

  it('takes no meeting link with something hidden in it', () => {
    expect(buildProposalPatch({}, { virtualLocations: vl('https://evil.example.net/\u202ea') })).toBeNull();
    expect(buildProposalPatch({}, { virtualLocations: vl('https://a.example.com/ b') })).toBeNull();
  });

  it('takes no meeting link that is not a web link', () => {
    const proposed = { virtualLocations: vl('javascript:alert(1)') };
    expect(buildProposalPatch({}, proposed)).toBeNull();
    expect(buildInvitationChangeItems({}, proposed, iso)).toEqual([]);
  });

  it('never takes the proposal\'s description type, and leaves an HTML description alone', () => {
    // The proposal tries to turn a plain description into HTML.
    expect(buildProposalPatch(
      { description: 'Agenda' },
      typed({ description: '<a href="https://evil.example.net">Agenda</a>', descriptionContentType: 'text/html' }),
    )).toBeNull();
    // Plain text written into an HTML description would be read as markup.
    expect(buildProposalPatch(
      typed({ description: '<p>Agenda</p>', descriptionContentType: 'text/html' }),
      { description: '<img src=x>' },
    )).toBeNull();
    const patch = buildProposalPatch(
      typed({ description: 'Agenda', descriptionContentType: 'text/plain' }),
      typed({ description: 'New agenda', descriptionContentType: 'text/plain' }),
    );
    expect(patch).toEqual({ description: 'New agenda' });
  });

  it('writes the sender\'s text as it was shown, not raw', () => {
    expect(buildProposalPatch({ title: 'Old' }, { title: 'New\u202e title' })).toEqual({ title: 'New title' });
  });

  it('shows every key it would patch', () => {
    const current = typed({
      title: 'A', description: 'd', descriptionContentType: 'text/plain', start: '2026-10-09T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin',
      locations: { l: { name: 'Room 1', description: 'x' } } as CalendarEvent['locations'],
      virtualLocations: vl('https://meet.example.com/a'),
    });
    const proposed: Partial<CalendarEvent> = typed({
      title: 'B', description: 'e', descriptionContentType: 'text/plain', start: '2026-10-10T09:00:00',
      duration: 'PT2H', timeZone: 'Europe/Paris', showWithoutTime: false,
      locations: { l: { name: 'Room 2', coordinates: 'geo:0,0' } } as unknown as CalendarEvent['locations'],
      virtualLocations: vl('https://meet.example.com/b'),
    });
    const patch = buildProposalPatch(current, proposed)!;
    const items = buildInvitationChangeItems(current, proposed, iso);
    expect(Object.keys(patch).sort()).toEqual(['description', 'duration', 'locations', 'start', 'timeZone', 'title', 'virtualLocations']);
    expect(patchIsShown(patch, items)).toBe(true);
    expect(patch.locations).toEqual({ l: { name: 'Room 2', description: 'x' } });
  });

  it('refuses a patch with a key the change list does not show', () => {
    const base = {
      method: 'counter' as const, userIsOrganizer: true,
      existing: { id: 'ev1', baseEventId: 'ev1' } as Partial<CalendarEvent>,
    };
    const link = { virtualLocations: vl('https://evil.example.net') };
    expect(canApplyProposal({ ...base, patch: link, changes: [] })).toBe(false);
    expect(canApplyProposal({ ...base, patch: link, changes: [{ label: 'title', before: null, after: 'x' }] })).toBe(false);
    expect(canApplyProposal({ ...base, patch: typed({ descriptionContentType: 'text/html' }), changes: [{ label: 'description', before: null, after: 'x' }] })).toBe(false);
    expect(canApplyProposal({ ...base, patch: link, changes: [{ label: 'virtual_location', before: null, after: 'x' }] })).toBe(true);
  });
});

describe('isUserOrganizer', () => {
  // Stalwart marks no owner or chair: only organizerCalendarAddress says who organizes.
  const stalwart = {
    organizerCalendarAddress: 'mailto:Me@Example.com',
    participants: {
      a: { calendarAddress: 'mailto:me@example.com', roles: { attendee: true } },
      b: { calendarAddress: 'mailto:bob@example.com', roles: { attendee: true } },
    },
  };

  it('recognises the user by the organizer address alone', () => {
    expect(isUserOrganizer(stalwart, ['me@example.com'])).toBe(true);
    expect(isUserOrganizer(stalwart, ['ME@EXAMPLE.COM'])).toBe(true);
  });

  it('does not take an attendee or another account\'s addresses for the organizer', () => {
    expect(isUserOrganizer(stalwart, ['bob@example.com'])).toBe(false);
    expect(isUserOrganizer(stalwart, [])).toBe(false);
    expect(isUserOrganizer({ participants: stalwart.participants }, ['me@example.com'])).toBe(false);
  });
});

describe('who may have a counter proposal applied', () => {
  const iso = (value: string | null) => value ?? '';
  const me = 'me@example.com';
  const stored = typed({
    id: 'ev1', baseEventId: 'ev1', uid: 'u1', title: 'Planning',
    start: '2026-10-09T10:00:00', timeZone: 'Europe/Berlin', duration: 'PT1H',
    descriptionContentType: null,
    organizerCalendarAddress: `mailto:${me}`,
    participants: {
      o: { calendarAddress: `mailto:${me}`, roles: { owner: true, attendee: true } },
      b: { calendarAddress: 'mailto:bob@example.com', roles: { attendee: true } },
    },
  });
  const counter = (attendee = 'bob@example.com', extra: Record<string, unknown> = {}) => typed({
    uid: 'u1', title: 'Planning', start: '2026-10-09T11:00:00', timeZone: 'Europe/Berlin', duration: 'PT1H',
    organizerCalendarAddress: `mailto:${me}`,
    participants: {
      o: { calendarAddress: `mailto:${me}`, roles: { owner: true } },
      // EMAIL= is the sender's to write, and names no one: never the proposer.
      b: { calendarAddress: `mailto:${attendee}`, email: 'ceo@example.com', roles: { attendee: true }, participationStatus: 'tentative' },
    },
    ...extra,
  });
  const authed = (from: string, results = 'mx.example.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com') =>
    email({ from: [{ email: from }], headers: [{ name: 'Authentication-Results', value: results }] });
  const review = (proposed: Partial<CalendarEvent>, mail: ReturnType<typeof email>, storedEvent: Partial<CalendarEvent> = stored) =>
    reviewCounterProposal({ method: 'counter', proposed, stored: storedEvent, userAddresses: [me], email: mail, serverHost: 'mx.example.com', formatDateTime: iso });

  it('offers Apply for a genuine counter from an attendee, authenticated', () => {
    const r = review(counter(), authed('bob@example.com'));
    expect(r).toMatchObject({ canApply: true, hold: null, proposer: { email: 'bob@example.com' } });
    expect(r?.patch).toEqual({ start: '2026-10-09T11:00:00' });
  });

  it('withholds Apply when the From is not the proposer', () => {
    expect(review(counter(), authed('mallory@example.com'))).toMatchObject({ canApply: false, hold: 'sender_not_proposer' });
  });

  it('withholds Apply for an attendee the event does not have', () => {
    expect(review(counter('eve@example.com'), authed('eve@example.com'))).toMatchObject({ canApply: false, hold: 'proposer_not_attendee' });
    // The organizer's own address does not count as an attendee proposing.
    const self = typed({ ...counter(), participants: { o: { calendarAddress: `mailto:${me}`, roles: { attendee: true } } } });
    expect(review(self, authed(me))?.canApply).toBe(false);
  });

  it('withholds Apply when nothing authenticates the From', () => {
    expect(review(counter(), email({ from: [{ email: 'bob@example.com' }] }))).toMatchObject({ canApply: false, hold: 'sender_unverified' });
    // A pass for another domain proves nothing about example.com.
    expect(review(counter(), authed('bob@example.com', 'mx.example.com; dkim=pass header.d=evil.example.net')))
      .toMatchObject({ canApply: false, hold: 'sender_unverified' });
  });

  it('holds Apply on a counter-proposal authenticated under a foreign authserv-id', () => {
    const args = {
      method: 'counter' as const, proposed: counter(), stored, userAddresses: [me], formatDateTime: iso,
      email: authed('bob@example.com', 'evil.example; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com'),
    };
    expect(reviewCounterProposal({ ...args, serverHost: 'jmap.example.com' })?.hold).toBe('sender_unverified');
    expect(reviewCounterProposal({ ...args, serverHost: 'evil.example' })?.hold).toBeNull();
  });

  it('withholds Apply when the From domain does not parse, whatever the results say', () => {
    const intranet = typed({
      ...stored,
      participants: { ...(stored.participants as object), i: { calendarAddress: 'mailto:ian@intranet', roles: { attendee: true } } },
    });
    const fromIan = authed('ian@intranet', 'mx.example.com; spf=none smtp.mailfrom=intranet; dkim=none; dmarc=none');
    expect(review(counter('ian@intranet'), fromIan, intranet)).toMatchObject({ canApply: false, hold: 'sender_unverified' });
  });

  it('withholds Apply on a failed check (warning-level trust)', () => {
    expect(review(counter(), authed('bob@example.com', 'mx.example.com; dkim=pass header.d=example.com; spf=fail smtp.mailfrom=example.com')))
      .toMatchObject({ canApply: false, hold: 'sender_unverified' });
  });

  it('withholds Apply when part of the proposal cannot be written as shown', () => {
    const r = review(counter('bob@example.com', { title: 'x'.repeat(300) }), authed('bob@example.com'));
    expect(r).toMatchObject({ canApply: false, hold: 'unsupported' });
  });

  it('leaves a description alone while the stored event\'s type is unknown', () => {
    const { descriptionContentType: _omit, ...unknownType } = stored as Record<string, unknown>;
    const r = review(counter('bob@example.com', { description: 'New agenda' }), authed('bob@example.com'), typed(unknownType));
    // Listed as not applied; the moved time is still applied, and only it.
    expect(r).toMatchObject({ canApply: true, hold: null, patch: { start: '2026-10-09T11:00:00' } });
    expect(r?.changes.find((c) => c.label === 'description')).toMatchObject({ after: 'New agenda', notApplied: true });
    expect(patchIsShown({ description: 'x' }, r!.changes)).toBe(false);
  });

  it('reads an omitted description type as plain text on the review fetch, as Stalwart sends it', () => {
    // Stalwart 0.16.25 leaves descriptionContentType out for a plain-text event.
    const { descriptionContentType: _omit, ...asSent } = stored as Record<string, unknown>;
    const fetched = withFetchedDescriptionType(typed({ ...asSent, description: 'Agenda' }));
    const r = review(counter('bob@example.com', { description: 'New agenda' }), authed('bob@example.com'), fetched);
    expect(r).toMatchObject({ canApply: true, patch: { start: '2026-10-09T11:00:00', description: 'New agenda' } });
    // An HTML event says so, and keeps its description.
    const html = withFetchedDescriptionType(typed({ ...asSent, description: '<p>Agenda</p>', descriptionContentType: 'text/html' }));
    const h = review(counter('bob@example.com', { description: 'New agenda' }), authed('bob@example.com'), html);
    expect(h?.patch).toEqual({ start: '2026-10-09T11:00:00' });
    expect(h?.changes.find((c) => c.label === 'description')?.notApplied).toBe(true);
  });

  it('applies nothing for a proposal that only changes a description it cannot write', () => {
    const { descriptionContentType: _omit, ...unknownType } = stored as Record<string, unknown>;
    const same = counter('bob@example.com', { start: '2026-10-09T10:00:00', description: 'New agenda' });
    // Said, rather than leaving the button out with no word why.
    expect(review(same, authed('bob@example.com'), typed(unknownType))).toMatchObject({ canApply: false, patch: null, hold: 'not_applicable' });
  });

  it('sends a recurring event to the calendar instead', () => {
    const series = typed({ ...stored, recurrenceOverrides: { '2026-10-16T10:00:00': { title: 'x' } } });
    expect(review(counter(), authed('bob@example.com'), series)).toMatchObject({ canApply: false, hold: 'recurring', changes: [] });
    expect(review(counter('bob@example.com', { recurrenceId: '2026-10-09T10:00:00' }), authed('bob@example.com')))
      .toMatchObject({ canApply: false, hold: 'recurring' });
  });

  it('reviews nothing for a user who does not organize it, or another event with the UID', () => {
    expect(reviewCounterProposal({ method: 'counter', proposed: counter(), stored, userAddresses: ['other@example.com'], email: authed('bob@example.com'), serverHost: 'mx.example.com', formatDateTime: iso })).toBeNull();
    const elsewhere = typed({ ...counter(), organizerCalendarAddress: 'mailto:someone@example.org' });
    expect(review(elsewhere, authed('bob@example.com'))).toBeNull();
  });

  it('applies only what was confirmed', () => {
    const confirmed = review(counter(), authed('bob@example.com'))!;
    expect(proposalStillMatches(confirmed, review(counter(), authed('bob@example.com')))).toBe(true);
    // The stored event moved meanwhile: the list would read differently.
    const moved = typed({ ...stored, start: '2026-10-09T09:00:00' });
    expect(proposalStillMatches(confirmed, review(counter(), authed('bob@example.com'), moved))).toBe(false);
    expect(proposalStillMatches(confirmed, null)).toBe(false);
  });

  it('compares an attendee\'s answer with the attendee, not the organizer', () => {
    const context = { stored, userAddresses: [me], serverHost: 'mx.example.com' };
    const t = getInvitationTrustAssessment(counter(), authed('bob@example.com'), 'counter', context);
    expect(t).toMatchObject({ level: 'trusted', expectedSender: 'attendee', expectedSenderEmail: 'bob@example.com' });
    const spoof = getInvitationTrustAssessment(counter(), email({ from: [{ email: 'mallory@evil.com' }] }), 'counter', context);
    expect(spoof).toMatchObject({ level: 'warning', reason: 'sender_mismatch_unverified' });
  });

  it('never trusts an answer the stored event does not back', () => {
    // A new UID, a made-up organizer, the attacker as the attendee, and a
    // message that authenticates the attacker's own domain.
    const forged = typed({
      uid: 'new-uid', organizerCalendarAddress: 'mailto:ceo@corp.example',
      participants: {
        o: { calendarAddress: 'mailto:ceo@corp.example', roles: { owner: true } },
        m: { calendarAddress: 'mailto:mallory@evil.example', roles: { attendee: true }, participationStatus: 'accepted' },
      },
    });
    const fromMallory = authed('mallory@evil.example', 'mx.example.com; dkim=pass header.d=evil.example; dmarc=pass header.from=evil.example');
    for (const method of ['counter', 'refresh', 'reply'] as const) {
      expect(getInvitationTrustAssessment(forged, fromMallory, method, { serverHost: 'mx.example.com' })).toMatchObject({ level: 'caution', reason: 'responder_not_on_event' });
      // A stored event the user doesn't organize backs nothing either.
      expect(getInvitationTrustAssessment(forged, fromMallory, method, { stored: { ...forged, id: 'x' }, userAddresses: [me], serverHost: 'mx.example.com' }).level).not.toBe('trusted');
    }
    // A REFRESH with a spoofed From and a DKIM pass for another domain, no DMARC.
    const spoofed = authed('ceo@corp.example', 'mx.example.com; dkim=pass header.d=evil.example');
    expect(getInvitationTrustAssessment(forged, spoofed, 'refresh', { serverHost: 'mx.example.com' })).toMatchObject({ level: 'caution', reason: 'responder_not_on_event' });
  });

  it('counts only a pass for the From domain as verified', () => {
    const e = email({
      from: [{ email: 'alice@example.com' }],
      headers: [{ name: 'Authentication-Results', value: 'x; dkim=pass header.d=other.example.net' }],
    });
    expect(getInvitationTrustAssessment(request, e, 'request', { serverHost: 'x' })).toMatchObject({ level: 'caution', reason: 'authentication_missing' });
  });
});

describe('isSameInvitationEvent', () => {
  const stored = { uid: 'u1', organizerCalendarAddress: 'mailto:alice@example.com' };
  it('takes a stored event for the invitation only with the same organizer', () => {
    expect(isSameInvitationEvent(stored, { uid: 'u1', organizerCalendarAddress: 'mailto:ALICE@example.com' })).toBe(true);
    // A crafted invitation carrying the UID of an unrelated event of the user's.
    expect(isSameInvitationEvent(stored, { uid: 'u1', organizerCalendarAddress: 'mailto:mallory@evil.com' })).toBe(false);
    expect(isSameInvitationEvent(stored, { uid: 'u2', organizerCalendarAddress: 'mailto:alice@example.com' })).toBe(false);
    expect(isSameInvitationEvent(null, { uid: 'u1' })).toBe(false);
  });

  it('never takes two events without an organizer for the same one', () => {
    expect(isSameInvitationEvent({ uid: 'u1' }, { uid: 'u1' })).toBe(false);
    // An import may still meet it: it dedupes.
    expect(mayImportOver({ uid: 'u1' }, { uid: 'u1' })).toBe(true);
    expect(mayImportOver(stored, { uid: 'u1' })).toBe(false);
    expect(mayImportOver({ uid: 'u1' }, { uid: 'u1', organizerCalendarAddress: 'mailto:mallory@evil.com' })).toBe(false);
  });
});

describe('invitationBannerDetails', () => {
  const stored = {
    uid: 'u1', title: 'Board meeting', start: '2026-10-08T10:00:00',
    organizerCalendarAddress: 'mailto:alice@example.com',
    locations: { l: { name: 'Room 4' } },
    virtualLocations: { v: { uri: 'https://meet.example/board' } },
  };
  const incoming = {
    uid: 'u1', title: 'Board meeting (moved)', start: '2026-10-09T10:00:00',
    organizerCalendarAddress: 'mailto:alice@example.com',
    locations: { l: { name: 'Lobby\u202e' } },
    virtualLocations: { v: { uri: 'https://meet-board.example' } },
  };

  it('takes every shown field from the stored event once it is in the calendar', () => {
    for (const method of ['request', 'counter', 'reply', 'refresh'] as const) {
      const d = invitationBannerDetails(stored, incoming, method);
      expect(d.source).toBe(stored);
      expect(d.location).toBe('Room 4');
      expect(d.videoUri).toBe('https://meet.example/board');
    }
  });

  it('never offers an attendee message\'s own link, and cleans its location', () => {
    for (const method of ['counter', 'reply', 'refresh'] as const) {
      const d = invitationBannerDetails(null, incoming, method);
      expect(d.source).toBe(incoming);
      expect(d.videoUri).toBeNull();
      expect(d.location).toBe('Lobby');
    }
  });

  it('shows an organizer message\'s own details when nothing is stored', () => {
    const d = invitationBannerDetails(null, incoming, 'request');
    expect(d.videoUri).toBe('https://meet-board.example');
  });
});
