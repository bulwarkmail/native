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
} from '../calendar-invitation';
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
