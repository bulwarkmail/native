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
    const auth = getEmailAuthenticationResults(forged);
    expect(auth?.dmarc?.result).toBe('fail');
    expect(auth?.dkim?.result).not.toBe('pass');
    expect(getInvitationTrustAssessment(request, forged, 'request').level).toBe('warning');
  });

  it('does not let a lower header fill a mechanism the topmost one omits', () => {
    const forged = email({
      from: [{ email: 'alice@example.com' }],
      headers: [
        { name: 'Authentication-Results', value: 'mx.example; spf=none smtp.mailfrom=evil.example' },
        { name: 'Authentication-Results', value: 'evil.example; dkim=pass header.d=example.com; dmarc=pass header.from=example.com' },
      ],
    });
    const auth = getEmailAuthenticationResults(forged);
    expect(auth?.dkim?.result).not.toBe('pass');
    expect(auth?.dmarc?.result).not.toBe('pass');
    expect(getInvitationTrustAssessment(request, forged, 'request').reason).toBe('authentication_missing');
  });

  it('reads the Authentication-Results header from the email headers', () => {
    const e = email({ headers: [{ name: 'Authentication-Results', value: 'x; dmarc=fail header.from=evil.com' }] });
    expect(getEmailAuthenticationResults(e)?.dmarc?.result).toBe('fail');
    expect(getEmailAuthenticationResults(email({}))).toBeNull();
  });
});

describe('getInvitationTrustAssessment', () => {
  it('is trusted for an authenticated organizer', () => {
    const e = email({
      from: [{ email: 'alice@example.com' }],
      headers: [{ name: 'Authentication-Results', value: 'x; dkim=pass header.d=example.com' }],
    });
    expect(getInvitationTrustAssessment(request, e, 'request').level).toBe('trusted');
  });

  it('warns when the sender differs from the organizer and is unverified', () => {
    const e = email({ from: [{ email: 'mallory@evil.com' }] });
    const a = getInvitationTrustAssessment(request, e, 'request');
    expect(a.level).toBe('warning');
    expect(a.reason).toBe('sender_mismatch_unverified');
  });

  it('warns on authentication failure and cautions on a verified mismatch', () => {
    const failed = email({
      from: [{ email: 'alice@example.com' }],
      headers: [{ name: 'Authentication-Results', value: 'x; spf=fail smtp.mailfrom=example.com' }],
    });
    expect(getInvitationTrustAssessment(request, failed, 'request').reason).toBe('authentication_failed');
    const mismatch = email({
      from: [{ email: 'assistant@example.com' }],
      headers: [{ name: 'Authentication-Results', value: 'x; dmarc=pass header.from=example.com' }],
    });
    expect(getInvitationTrustAssessment(request, mismatch, 'request')).toMatchObject({ level: 'caution', reason: 'sender_mismatch' });
  });

  it('cautions when a scheduling message carries no authentication at all', () => {
    const e = email({ from: [{ email: 'alice@example.com' }] });
    expect(getInvitationTrustAssessment(request, e, 'request').reason).toBe('authentication_missing');
    expect(getInvitationTrustAssessment(request, e, 'unknown').level).toBe('trusted');
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
    const trust = getInvitationTrustAssessment(event, verifiedFrom('mallory@evil.example'), 'request');
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
    const fromBob = getInvitationTrustAssessment(reply, email({ from: [{ email: 'Bob@Example.com' }] }), 'reply');
    expect(invitationSentFrom(actor.email, fromBob.senderEmail)).toBeNull();
    const fromMallory = getInvitationTrustAssessment(reply, verifiedFrom('mallory@evil.example'), 'reply');
    expect(invitationSentFrom(actor.email, fromMallory.senderEmail)).toBe('mallory@evil.example');
    expect(invitationSentFrom(null, 'mallory@evil.example')).toBe('mallory@evil.example');
    expect(invitationSentFrom('bob@example.com', null)).toBeNull();
  });
});

describe('counter-proposal review', () => {
  it('patches only what the proposal changes', () => {
    expect(buildProposalPatch(
      { start: '2026-10-09T10:00:00', duration: 'PT1H', title: 'A' },
      { start: '2026-10-09T11:00:00', duration: 'PT1H', title: 'A' },
    )).toEqual({ start: '2026-10-09T11:00:00' });
  });

  it('patches a changed zone, all-day flag and location set', () => {
    expect(buildProposalPatch(
      { start: '2026-10-09T10:00:00', timeZone: 'Europe/Berlin', locations: { l: { name: 'Room 1' } } as CalendarEvent['locations'] },
      { start: '2026-10-09T10:00:00', timeZone: 'Europe/Paris', showWithoutTime: true, locations: { l: { name: 'Room 2' } } as CalendarEvent['locations'] },
    )).toEqual({ timeZone: 'Europe/Paris', showWithoutTime: true, locations: { l: { '@type': 'Location', name: 'Room 2' } } });
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
    const items = buildInvitationChangeItems(
      { title: 'Old', description: '' },
      { title: 'New\u202e title\nline two', description: 'Line one\r\nLine two' },
      iso,
    );
    expect(items).toEqual([
      { label: 'title', before: 'Old', after: 'New title line two' },
      { label: 'description', before: null, after: 'Line one Line two' },
    ]);
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
    const proposed = { virtualLocations: vl('https://evil.example.net/\u202ea', { name: 'Hidden name', description: 'x' }) };
    expect(buildInvitationChangeItems(current, proposed, iso)).toEqual([
      { label: 'virtual_location', before: 'https://meet.example.com/a', after: 'https://evil.example.net/a' },
    ]);
    expect(buildProposalPatch(current, proposed)).toEqual({
      virtualLocations: { v: { '@type': 'VirtualLocation', uri: 'https://evil.example.net/a' } },
    });
  });

  it('takes no meeting link that is not a web link', () => {
    const proposed = { virtualLocations: vl('javascript:alert(1)') };
    expect(buildProposalPatch({}, proposed)).toBeNull();
    expect(buildInvitationChangeItems({}, proposed, iso)).toEqual([]);
  });

  // The app's CalendarEvent type leaves descriptionContentType out; the server sends it.
  const typed = (e: Record<string, unknown>) => e as Partial<CalendarEvent>;

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
    const current = {
      title: 'A', description: 'd', start: '2026-10-09T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin',
      locations: { l: { name: 'Room 1', description: 'x' } } as CalendarEvent['locations'],
      virtualLocations: vl('https://meet.example.com/a'),
    };
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
    expect(patch.locations).toEqual({ l: { '@type': 'Location', name: 'Room 2' } });
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
