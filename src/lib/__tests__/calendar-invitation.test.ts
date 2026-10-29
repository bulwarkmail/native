import { describe, it, expect, afterEach } from 'vitest';
import { format } from 'date-fns';
import type { Email } from '../../api/types';
import { useSettingsStore } from '../../stores/settings-store';
import {
  calendarInvitationKey,
  extractMethodFromContentType,
  extractMethodFromRawIcs,
  findCalendarAttachment,
  getEmailAuthenticationResults,
  getInvitationDisplayRange,
  getInvitationMethod,
  getInvitationTrustAssessment,
  invitationZoneLabel,
  parseAuthenticationResults,
} from '../calendar-invitation';

describe('getInvitationDisplayRange (webmail #1252)', () => {
  afterEach(() => {
    useSettingsStore.setState({ calendarTimeZone: 'auto' });
  });
  const shown = (d: Date | null | undefined) => (d ? format(d, 'yyyy-MM-dd HH:mm') : null);

  it('shows an organizer\'s wall clock in the user\'s zone', () => {
    useSettingsStore.setState({ calendarTimeZone: 'Europe/Warsaw' });
    // As CalendarEvent/parse gives an Exchange invitation from London: no utcStart.
    const range = getInvitationDisplayRange({ start: '2026-10-20T15:00:00', timeZone: 'Europe/London', duration: 'PT25M' });
    expect(shown(range?.start)).toBe('2026-10-20 16:00');
    expect(shown(range?.end)).toBe('2026-10-20 16:25');
    expect(range?.instant?.toISOString()).toBe('2026-10-20T14:00:00.000Z');
    expect(invitationZoneLabel(range!.instant!, 'en')).toBeTruthy();
  });

  it('takes the server\'s UTC start when it has one', () => {
    useSettingsStore.setState({ calendarTimeZone: 'America/New_York' });
    const range = getInvitationDisplayRange({ start: '2026-10-20T15:00:00', timeZone: 'Europe/London', utcStart: '2026-10-20T14:00:00Z', utcEnd: '2026-10-20T15:00:00Z' });
    expect(shown(range?.start)).toBe('2026-10-20 10:00');
    expect(shown(range?.end)).toBe('2026-10-20 11:00');
  });

  it('leaves floating times and all-day dates as written', () => {
    useSettingsStore.setState({ calendarTimeZone: 'America/New_York' });
    const floating = getInvitationDisplayRange({ start: '2026-10-20T15:00:00', duration: 'PT1H' });
    expect(shown(floating?.start)).toBe('2026-10-20 15:00');
    expect(floating?.instant).toBeUndefined();
    const oneDay = getInvitationDisplayRange({ start: '2026-10-20T00:00:00', duration: 'P1D', showWithoutTime: true });
    expect(shown(oneDay?.start)).toBe('2026-10-20 00:00');
    expect(oneDay?.end).toBeNull();
    // The stored end is exclusive: three days end on the third.
    const threeDays = getInvitationDisplayRange({ start: '2026-10-20T00:00:00', duration: 'P3D', showWithoutTime: true });
    expect(shown(threeDays?.end)).toBe('2026-10-22 00:00');
  });
});

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
    expect(parsed.dkim).toMatchObject({ result: 'pass', domain: 'example.com', selector: 'sel' });
    expect(parsed.dmarc?.result).toBe('pass');
  });

  it('lets a HELO failure escalate but not a HELO none downgrade', () => {
    expect(parseAuthenticationResults('spf=pass smtp.mailfrom=a.com; spf=none smtp.helo=b.com').spf?.result).toBe('pass');
    expect(parseAuthenticationResults('spf=pass smtp.mailfrom=a.com; spf=fail smtp.helo=b.com').spf?.result).toBe('fail');
  });

  it('reads the Authentication-Results header from the email headers', () => {
    const e = email({ headers: [{ name: 'Authentication-Results', value: 'x; dmarc=fail header.from=evil.com' }] });
    expect(getEmailAuthenticationResults(e)?.dmarc?.result).toBe('fail');
    expect(getEmailAuthenticationResults(email({}))).toBeNull();
  });

  // A sender controls the envelope address, comments and every header below
  // the receiving server's own.
  it('takes no result a sender wrote into a property, a comment or a lower header', () => {
    const inEnvelope = parseAuthenticationResults(
      'mx.example.org; spf=none smtp.mailfrom="dkim=pass;dmarc=pass"@forger.example (dkim=pass header.d=example.com)',
    );
    expect(inEnvelope.dkim).toBeUndefined();
    expect(inEnvelope.dmarc).toBeUndefined();
    const lower = email({
      from: [{ email: 'alice@example.com' }],
      headers: [
        { name: 'Authentication-Results', value: 'mx.example.org; spf=none smtp.mailfrom=forger.example; dmarc=none' },
        { name: 'Authentication-Results', value: 'forged; dkim=pass header.d=example.com; dmarc=pass header.from=example.com' },
      ],
    });
    expect(getEmailAuthenticationResults(lower)).toMatchObject({ dmarc: { result: 'none' } });
    expect(getEmailAuthenticationResults(lower)?.dkim).toBeUndefined();
    expect(getInvitationTrustAssessment(request, lower, 'request').level).toBe('caution');
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

  // #1374: a forger passes SPF for an envelope domain of their own, or signs
  // with their own key, and writes the organizer's address in From.
  const forged = (results: string) => email({
    from: [{ email: 'alice@example.com' }],
    headers: [{ name: 'Authentication-Results', value: `mx.example.org; ${results}` }],
  });

  it('trusts only a pass aligned with the From domain', () => {
    expect(getInvitationTrustAssessment(request, forged('spf=pass smtp.mailfrom=bounce@forger.example; dmarc=none header.from=example.com'), 'request'))
      .toMatchObject({ level: 'caution', reason: 'authentication_missing' });
    expect(getInvitationTrustAssessment(request, forged('dkim=pass header.d=forger.example header.s=k1; dmarc=none'), 'request').level)
      .toBe('caution');
    // A HELO pass never vouches for the sender.
    expect(getInvitationTrustAssessment(request, forged('spf=pass smtp.helo=example.com'), 'request').level).toBe('caution');

    // Aligned: the same domain, or a parent or child of it.
    expect(getInvitationTrustAssessment(request, forged('spf=pass smtp.mailfrom=bounce@mail.example.com; dmarc=none'), 'request').level)
      .toBe('trusted');
    expect(getInvitationTrustAssessment(request, forged('dkim=pass header.d=forger.example; dkim=pass header.d=example.com'), 'request').level)
      .toBe('trusted');
  });

  // A mailing list or a forwarder that rewrote the message broke the first
  // signature; the sender's own one passed, and so did DMARC.
  it('trusts a DMARC pass of the receiving server over a broken signature listed first', () => {
    expect(getInvitationTrustAssessment(request, forged(
      'dkim=fail header.d=lists.example.net header.s=l1; dkim=pass header.d=example.com header.s=k1; spf=softfail smtp.mailfrom=lists.example.net; dmarc=pass header.from=example.com',
    ), 'request')).toMatchObject({ level: 'trusted', reason: null });
    // A pass only a lower header claims is the sender's word, not the server's.
    const below = email({
      from: [{ email: 'alice@example.com' }],
      headers: [
        { name: 'Authentication-Results', value: 'mx.example.org; dkim=fail header.d=example.com; dmarc=fail header.from=example.com' },
        { name: 'Authentication-Results', value: 'relay.example; dmarc=pass header.from=example.com' },
      ],
    });
    expect(getInvitationTrustAssessment(request, below, 'request').reason).toBe('authentication_failed');
  });

  it('warns about a forged organizer whose mail passes only for the forger\'s domain', () => {
    const e = email({
      from: [{ email: 'mallory@forger.example' }],
      headers: [{ name: 'Authentication-Results', value: 'mx.example.org; spf=pass smtp.mailfrom=forger.example; dmarc=none' }],
    });
    // Aligned with its own From, so only a caution about the mismatch.
    expect(getInvitationTrustAssessment(request, e, 'request')).toMatchObject({ level: 'caution', reason: 'sender_mismatch' });
    const unaligned = email({
      from: [{ email: 'mallory@forger.example' }],
      headers: [{ name: 'Authentication-Results', value: 'mx.example.org; spf=pass smtp.mailfrom=other.example; dmarc=none' }],
    });
    expect(getInvitationTrustAssessment(request, unaligned, 'request')).toMatchObject({ level: 'warning', reason: 'sender_mismatch_unverified' });
  });

  it('does not flag a colleague\'s invitation that never left the server', () => {
    const colleague = email({ from: [{ email: 'alice@example.com' }] });
    expect(getInvitationTrustAssessment(request, colleague, 'request', ['bob@example.com']).level).toBe('trusted');
    // From outside, or with a header saying it came in from outside: as before.
    expect(getInvitationTrustAssessment(request, colleague, 'request', ['bob@elsewhere.example']).reason).toBe('authentication_missing');
    expect(getInvitationTrustAssessment(request, forged('spf=none smtp.mailfrom=example.com'), 'request', ['bob@example.com']).reason)
      .toBe('authentication_missing');
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
