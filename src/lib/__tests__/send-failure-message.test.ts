import { describe, it, expect } from 'vitest';
import { RequestTimeoutError } from '../../api/jmap-client';
import { JMAPMethodError, ScheduleTooLateError, SubmissionQuotaError } from '../../api/jmap-result';
import { sendFailureMessage } from '../send-failure-message';

// The English fallback stands in for the catalog.
const t = (key: string, fallback?: string) => fallback ?? key;

describe('sendFailureMessage', () => {
  it('explains a full submission quota instead of showing Stalwart 1.0\'s "please delete some"', () => {
    const quota = new SubmissionQuotaError(
      'There are too many email submissions, please delete some before adding a new one.',
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
