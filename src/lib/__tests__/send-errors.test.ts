import { describe, it, expect } from 'vitest';
import { sendErrorAlert, withoutRefused } from '../send-errors';
import { RequestTimeoutError } from '../../api/jmap-client';
import { RecipientsRejectedError, SendUnconfirmedError, ScheduleTooLateError } from '../../api/jmap-result';

const t = (k: string, f?: string) => f ?? k;

describe('sendErrorAlert', () => {
  it('lists the refused recipients with their SMTP replies', () => {
    const e = new RecipientsRejectedError([{ email: 'gone@example.com', smtpReply: '550 5.1.1 No such user' }]);
    expect(sendErrorAlert(e, t)).toEqual({
      title: 'Not sent - the server rejected every recipient.',
      message: 'gone@example.com (550 5.1.1 No such user)',
    });
  });

  it('points at Sent for a timeout and for an unconfirmed send', () => {
    const expected = {
      title: 'No answer from the server',
      message: 'The message may already have gone out. Check your Sent folder before sending it again.',
    };
    expect(sendErrorAlert(new RequestTimeoutError(30_000), t)).toEqual(expected);
    expect(sendErrorAlert(new SendUnconfirmedError(), t)).toEqual(expected);
  });

  // M-2: a send stopped by an account switch says so, not "Superseded…".
  it('explains a send stopped by an account switch', () => {
    const stale = Object.assign(new Error('Superseded by a newer account load'), { name: 'StaleLoadError' });
    const ti = (k: string, f?: string, p?: Record<string, string | number>) =>
      (f ?? k).replace(/\{(\w+)\}/g, (_, n) => String(p?.[n] ?? ''));
    expect(sendErrorAlert(stale, ti, { account: 'alice@a.example.com' })).toEqual({
      title: 'Account changed',
      message: 'This message was started in alice@a.example.com. Switch back to it to send, save or attach files.',
    });
  });

  it('keeps the schedule-too-late copy and falls back to the error message', () => {
    expect(sendErrorAlert(new ScheduleTooLateError(), t)).toEqual({
      title: 'Too far ahead',
      message: 'That is later than this server allows. Pick an earlier time.',
    });
    expect(sendErrorAlert(new Error('boom'), t)).toEqual({ title: 'Send failed', message: 'boom' });
    expect(sendErrorAlert('x', t)).toEqual({ title: 'Send failed', message: 'Failed to send email' });
  });
});

describe('withoutRefused', () => {
  const to = [{ name: 'A', email: 'a@x.com' }, { email: 'Gone@Example.com' }];
  it('drops refused addresses, ignoring case', () => {
    expect(withoutRefused(to, [{ email: 'gone@example.com' }])).toEqual([{ name: 'A', email: 'a@x.com' }]);
  });
  it('keeps everyone when nothing was refused', () => {
    expect(withoutRefused(to, undefined)).toEqual(to);
  });
});
