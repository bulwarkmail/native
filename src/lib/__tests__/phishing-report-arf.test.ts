import { describe, expect, it } from 'vitest';
import type { Email } from '../../api/types';
import { assembleArfReport, buildArfParts, deliveryRecipient, rawEncoding } from '../phishing-report-arf';

// The ARF report (RFC 5965), ported with the webmail's tests: multipart/report
// with report-type feedback-report, a text part, message/feedback-report
// with Feedback-Type: fraud, User-Agent and Version: 1, and the original
// whole as message/rfc822.

const email = {
  id: 'e1', blobId: 'blob-1', size: 40, subject: 'Konto gesperrt – jetzt prüfen', receivedAt: '2026-10-01T10:00:00Z',
  from: [{ email: 'bad@phish.example' }], keywords: {}, mailboxIds: { inbox: true },
} as unknown as Email;
const reporter = { name: 'Alice', email: 'alice@example.org' };
const ORIGINAL = 'From: bad@phish.example\r\nSubject: x\r\n\r\nclick here\r\n';

describe('buildArfParts', () => {
  it('has the three parts and the required feedback fields', () => {
    const { head, tail } = buildArfParts({
      email, reporter, to: 'abuse@example.org', encoding: '7bit', appVersion: '0.1.95',
      recipient: 'alice@example.org', now: new Date('2026-11-01T08:00:00Z'),
    });
    expect(head).toMatch(/^Date: Sun, 01 Nov 2026 08:00:00 \+0000\r\n/);
    expect(head).toContain('From: Alice <alice@example.org>\r\n');
    expect(head).toContain('To: abuse@example.org\r\n');
    // Non-ASCII subject as an encoded word, after "Phishing:".
    const subject = /\r\nSubject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=\r\n/.exec(head)![1];
    expect(new TextDecoder().decode(Uint8Array.from(atob(subject), (c) => c.charCodeAt(0)))).toBe('Phishing: Konto gesperrt – jetzt prüfen');
    expect(head).toContain('Content-Type: multipart/report; report-type=feedback-report;');
    const boundary = /boundary="([^"]+)"/.exec(head)![1];
    expect(head.split(`--${boundary}\r\n`)).toHaveLength(4);
    expect(head).toContain('Content-Type: message/feedback-report\r\n');
    expect(head).toContain('\r\nFeedback-Type: fraud\r\n');
    expect(head).toContain('\r\nUser-Agent: Bulwark/0.1.95\r\n');
    expect(head).toContain('\r\nVersion: 1\r\n');
    expect(head).toContain('\r\nArrival-Date: Thu, 01 Oct 2026 10:00:00 +0000\r\n');
    expect(head).toContain('\r\nOriginal-Rcpt-To: alice@example.org\r\n');
    expect(head).toContain('\r\nReported-Domain: phish.example\r\n');
    expect(head).toMatch(/Content-Type: message\/rfc822\r\n[\s\S]*Content-Transfer-Encoding: 7bit\r\n\r\n$/);
    expect(tail).toBe(`\r\n--${boundary}--\r\n`);
  });

  it('leaves Original-Rcpt-To out when the delivery address is unknown', () => {
    const { head } = buildArfParts({ email, reporter, to: 'abuse@example.org', encoding: '7bit', appVersion: '1' });
    expect(head).not.toContain('Original-Rcpt-To');
  });

  it('keeps line breaks out of the header lines it builds', () => {
    const { head } = buildArfParts({
      email: { ...email, subject: 'Hi\r\nBcc: victim@example.org' },
      reporter: { name: 'Eve\r\nX-Evil: 1', email: 'alice@example.org' },
      to: 'abuse@example.org\r\nBcc: x@example.org',
      encoding: '7bit',
      appVersion: '1\r\nX-Evil: 2',
    });
    expect(head).not.toMatch(/\r\n(Bcc|X-Evil):/);
  });
});

describe('rawEncoding', () => {
  it('says binary for bare line breaks or long lines, 8bit for 8-bit bytes, never base64', () => {
    const enc = (text: string) => rawEncoding(new TextEncoder().encode(text));
    expect(enc('a\r\nb\r\n')).toBe('7bit');
    expect(enc('Grüße\r\n')).toBe('8bit');
    expect(enc('a\nb')).toBe('binary');
    expect(enc('a\rb')).toBe('binary');
    expect(enc(`${'x'.repeat(999)}\r\n`)).toBe('binary');
    expect(enc('a\u0000b')).toBe('binary');
  });
});

describe('assembleArfReport', () => {
  it('carries the original byte for byte, with one line break before the closing boundary', () => {
    const parts = buildArfParts({ email, reporter, to: 'abuse@example.org', encoding: '7bit', appVersion: '1' });
    const boundary = /boundary="([^"]+)"/.exec(parts.head)![1];
    const text = new TextDecoder().decode(assembleArfReport(parts, new TextEncoder().encode(ORIGINAL)));
    expect(text).toBe(`${parts.head}${ORIGINAL}--${boundary}--\r\n`);
    const unterminated = new TextDecoder().decode(assembleArfReport(parts, new TextEncoder().encode('x')));
    expect(unterminated.endsWith(`x\r\n--${boundary}--\r\n`)).toBe(true);
  });
});

describe('deliveryRecipient', () => {
  it('takes the topmost delivery header, else the To address that is the reporter', () => {
    expect(deliveryRecipient({
      headers: [
        { name: 'Received', value: 'from x' },
        { name: 'Delivered-To', value: ' alice+inbox@example.org' },
        { name: 'Delivered-To', value: 'list@example.org' },
      ],
      to: [{ email: 'alice@example.org' }],
    }, 'alice@example.org')).toBe('alice+inbox@example.org');
    expect(deliveryRecipient({ headers: [{ name: 'X-Original-To', value: '<a@example.org>' }] }, 'b@example.org')).toBe('a@example.org');
    expect(deliveryRecipient({ to: [{ email: 'bob@example.org' }, { email: 'Alice@example.org' }] }, 'alice@example.org')).toBe('Alice@example.org');
    expect(deliveryRecipient({ to: [{ email: 'bob@example.org' }] }, 'alice@example.org')).toBeUndefined();
  });
});
