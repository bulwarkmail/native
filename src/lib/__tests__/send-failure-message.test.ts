import { describe, it, expect } from 'vitest';
import { RequestTimeoutError } from '../../api/jmap-client';
import {
  JMAPMethodError, NoLongerScheduledError, RecipientsRefusedError, ScheduleTooLateError, SubmissionQuotaError,
  formatRefusedRecipients,
} from '../../api/jmap-result';
import { partlyRefusedWarning, rescheduleFailureNotice, sendFailureMessage } from '../send-failure-message';

// The English fallback stands in for the catalog.
const t = (key: string, fallback?: string, params?: Record<string, unknown>) =>
  (fallback ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`));

describe('sendFailureMessage', () => {
  it('explains a full submission quota instead of showing Stalwart 1.0\'s "please delete some"', () => {
    const quota = new SubmissionQuotaError(
      'There are too many email submissions, please delete some before adding a new one.',
      true,
    );
    expect(quota).toBeInstanceOf(JMAPMethodError);
    expect(quota.type).toBe('overQuota');
    expect(sendFailureMessage(quota, t)).toBe(
      'The server has too many sent-message records for this account. Bulwark removed the ones it could; if this keeps happening, ask your administrator to raise the email submission limit.',
    );
  });

  it('points at Sent after a timeout, and names the hold limit', () => {
    expect(sendFailureMessage(new RequestTimeoutError(30_000), t)).toMatch(/Check your Sent folder/);
    expect(sendFailureMessage(new ScheduleTooLateError(172_800), t)).toMatch(/later than this server allows/);
  });

  it("keeps the server's own words for anything else", () => {
    expect(sendFailureMessage(new Error('Not your address'), t)).toBe('Not your address');
    // A full mailbox is Email/set's overQuota, not the submission quota.
    expect(sendFailureMessage(new JMAPMethodError('overQuota', 'Account quota exceeded.'), t)).toBe('Account quota exceeded.');
    expect(sendFailureMessage('boom', t)).toBe('Failed to send email');
  });
});

describe('sendFailureMessage beyond Stalwart and around a reschedule', () => {
  it('gives another server\'s overQuota a generic sentence with its own words (no urn:stalwart:jmap)', () => {
    expect(sendFailureMessage(new SubmissionQuotaError('Daily sending limit reached', false), t))
      .toBe('The server refused to send the message because a limit was reached: Daily sending limit reached');
    expect(sendFailureMessage(new SubmissionQuotaError(undefined, false), t))
      .toBe('The server refused to send the message because a limit was reached: overQuota');
  });

  it('says a rescheduled message already went out, or is no longer scheduled', () => {
    expect(sendFailureMessage(new NoLongerScheduledError(true), t)).toBe('This message was already sent.');
    expect(sendFailureMessage(new NoLongerScheduledError(false), t)).toBe('This message is no longer scheduled.');
  });
});

// Stalwart 0.16 and 1.0 take the submission and refuse recipients at RCPT,
// each with its own reply.
describe('recipients the server refused', () => {
  const refused = new RecipientsRefusedError([
    { email: 'nobody@example.net', smtpReply: '550 5.1.2 Relay not allowed.' },
    { email: 'busy@example.org', smtpReply: '452 4.4.5 Rate limit exceeded, try again later.' },
  ]);

  it('says the message was not sent and names every refused recipient with its reply', () => {
    expect(sendFailureMessage(refused, t)).toBe(
      'Not sent: the server refused nobody@example.net (550 5.1.2 Relay not allowed.), busy@example.org (452 4.4.5 Rate limit exceeded, try again later.).',
    );
  });

  it('lists an address without its reply when the server gave none', () => {
    expect(formatRefusedRecipients([{ email: 'a@example.net' }, { email: 'b@example.net', smtpReply: '550 5.1.1 No such user' }]))
      .toBe('a@example.net, b@example.net (550 5.1.1 No such user)');
  });

  // The original is kept for all of its recipients, so the headline must not
  // read as "not sent", which invites sending the message a second time.
  it('leads with the kept schedule when the server refused recipients of the replacement (Stalwart 0.16 and 1.0)', () => {
    const error = new RecipientsRefusedError([{ email: 'bob@example.org', smtpReply: '452 4.4.5 Rate limit exceeded, try again later.' }]);
    expect(rescheduleFailureNotice(error, t, 'Reschedule failed', 'Sep 26, 10:00')).toEqual({
      title: 'The message is still scheduled for Sep 26, 10:00.',
      message: 'Nothing was changed: the server refused bob@example.org (452 4.4.5 Rate limit exceeded, try again later.).',
    });
    expect(rescheduleFailureNotice(error, t, 'Could not send now')).toEqual({
      title: 'The message is still scheduled.',
      message: 'Nothing was changed: the server refused bob@example.org (452 4.4.5 Rate limit exceeded, try again later.).',
    });
  });

  it('gives other reschedule failures their title and the send failure message', () => {
    expect(rescheduleFailureNotice(new NoLongerScheduledError(true), t, 'Reschedule failed', 'Sep 26, 10:00'))
      .toEqual({ title: 'Reschedule failed', message: 'This message was already sent.' });
    expect(rescheduleFailureNotice(new Error('Quota exceeded'), t, 'Could not send now'))
      .toEqual({ title: 'Could not send now', message: 'Quota exceeded' });
  });

  it('warns about the recipients refused while the others get the message', () => {
    expect(partlyRefusedWarning([{ email: 'nobody@example.net', smtpReply: '550 5.1.2 Relay not allowed.' }], t)).toEqual({
      title: 'Not sent to everyone',
      message: 'The server refused nobody@example.net (550 5.1.2 Relay not allowed.). The other recipients get the message.',
    });
  });
});
