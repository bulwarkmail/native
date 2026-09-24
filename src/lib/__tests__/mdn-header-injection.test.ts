import { describe, it, expect } from 'vitest';
import { buildMdnMessage } from '../mdn';

// GHSA-w38p-hpqv-g89c: every value that lands in a header of the read receipt
// originates with the sender of the message being answered, and Stalwart hands
// it back already RFC 2047-decoded. A bare CRLF smuggled inside an encoded-word
// used to be interpolated verbatim into the Subject: line, letting the sender
// append From/Reply-To/Content-Type headers and a body to a message the
// user's own account files into Sent and submits.

const base = {
  to: 'sender@other.com',
  fromEmail: 'me@example.com',
  originalMessageId: 'orig@other.com',
};

// The decoded subject from the advisory's proof of concept.
const INJECTED_SUBJECT =
  'Invoice\r\nFrom: IT Helpdesk <helpdesk@corp.example>\r\nReply-To: attacker@evil.test\r\n'
  + 'Content-Type: text/html; charset=utf-8\r\n\r\n<html><body><h1>Forged</h1></body></html><!--';

/** Decode a single RFC 2047 B encoded-word the way the server does before handing it to us. */
function decodeEncodedWord(word: string): string {
  const m = word.match(/^=\?UTF-8\?B\?([^?]*)\?=$/i);
  if (!m) throw new Error(`not an encoded-word: ${word}`);
  return Buffer.from(m[1], 'base64').toString('utf8');
}

/** Header block (everything before the first blank line) split into lines. */
function headerLines(msg: string): string[] {
  const end = msg.indexOf('\r\n\r\n');
  return msg.slice(0, end).split('\r\n');
}

/** Everything after the top-level header block. */
function body(msg: string): string {
  return msg.slice(msg.indexOf('\r\n\r\n') + 4);
}

function countHeader(lines: string[], name: string): number {
  const re = new RegExp(`^${name}:`, 'i');
  return lines.filter((l) => re.test(l)).length;
}

describe('buildMdnMessage - header injection (GHSA-w38p-hpqv-g89c)', () => {
  it('a CRLF inside the localized subject cannot terminate the Subject: header', () => {
    const msg = buildMdnMessage({ ...base, subject: `Read: ${INJECTED_SUBJECT}` });
    const lines = headerLines(msg);

    expect(countHeader(lines, 'Subject')).toBe(1);
    expect(countHeader(lines, 'From')).toBe(1);
    expect(countHeader(lines, 'Reply-To')).toBe(0);
    expect(lines.find((l) => /^From:/.test(l))).toBe('From: me@example.com');
    // The only Content-Type in the header block is our multipart/report.
    expect(lines.filter((l) => /^Content-Type:/i.test(l))).toEqual([
      'Content-Type: multipart/report; report-type=disposition-notification;',
    ]);
    // The attacker's HTML never becomes a body part (it stays inert text on the Subject line).
    expect(body(msg)).not.toContain('<h1>Forged</h1>');
    // The subject text survives on one line with the breaks collapsed.
    expect(lines.find((l) => /^Subject:/.test(l))).toBe(
      'Subject: Read: Invoice From: IT Helpdesk <helpdesk@corp.example>'
        + ' Reply-To: attacker@evil.test Content-Type: text/html; charset=utf-8'
        + ' <html><body><h1>Forged</h1></body></html><!--',
    );
  });

  it('the default "Read: <originalSubject>" path is protected the same way', () => {
    const msg = buildMdnMessage({ ...base, originalSubject: INJECTED_SUBJECT });
    const lines = headerLines(msg);
    expect(countHeader(lines, 'Subject')).toBe(1);
    expect(countHeader(lines, 'From')).toBe(1);
    expect(countHeader(lines, 'Reply-To')).toBe(0);
    expect(body(msg)).not.toContain('<h1>Forged</h1>');
  });

  it('an encoded-word subject that decodes to CRLF (the audit repro) stays one header line', () => {
    const payload = 'Contract update\r\nX-Injected: yes\r\nReply-To: attacker@evil.example';
    const encoded = `=?UTF-8?B?${Buffer.from(payload, 'utf8').toString('base64')}?=`;
    const decoded = decodeEncodedWord(encoded);
    expect(decoded).toBe(payload);

    // Both the localized subject (what the banner passes) and the raw original.
    for (const msg of [
      buildMdnMessage({ ...base, subject: `Read: ${decoded}` }),
      buildMdnMessage({ ...base, originalSubject: decoded }),
    ]) {
      expect(msg).not.toMatch(/^X-Injected:/m);
      expect(msg).not.toMatch(/^Reply-To:/m);
      expect(headerLines(msg).find((l) => /^Subject:/.test(l))).toBe(
        'Subject: Read: Contract update X-Injected: yes Reply-To: attacker@evil.example',
      );
    }
  });

  it('bare LF and a blank line cannot start extra headers or a body', () => {
    const msg = buildMdnMessage({
      ...base,
      subject: 'Hello\nBcc: leak@evil.test\n\nForged body',
      originalSubject: 'Hello\n\nForged body',
    });
    const lines = headerLines(msg);
    expect(countHeader(lines, 'Bcc')).toBe(0);
    expect(lines.find((l) => /^Subject:/.test(l))).toBe('Subject: Hello Bcc: leak@evil.test Forged body');
    // Our own header block is intact up to the multipart boundary parameter.
    expect(lines[lines.length - 1]).toMatch(/^\tboundary="/);
    expect(body(msg)).not.toContain('Forged body');
  });

  it('a subject that is non-ASCII *and* carries CRLF is stripped before encoding', () => {
    const msg = buildMdnMessage({ ...base, subject: 'Über\r\nReply-To: x@evil.test\r\n' });
    const lines = headerLines(msg);
    expect(countHeader(lines, 'Reply-To')).toBe(0);
    const subject = lines.find((l) => /^Subject:/.test(l))!;
    expect(subject).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const decoded = decodeEncodedWord(subject.slice('Subject: '.length));
    expect(decoded).toBe('Über Reply-To: x@evil.test');
    expect(decoded).not.toMatch(/[\r\n]/);
  });

  it('other C0 controls (NUL, lone CR, lone LF, VT, FF) are removed too', () => {
    const msg = buildMdnMessage({ ...base, subject: 'a\0b\rc\nd\x0be\x0cf\x7fg' });
    expect(headerLines(msg).find((l) => /^Subject:/.test(l))).toBe('Subject: a b c d e f g');
  });

  it('From display name cannot inject headers and is quoted when it uses specials', () => {
    const injected = buildMdnMessage({ ...base, fromName: 'Me\r\nReply-To: x@evil.test' });
    const lines = headerLines(injected);
    expect(countHeader(lines, 'Reply-To')).toBe(0);
    expect(lines.find((l) => /^From:/.test(l))).toBe('From: "Me Reply-To: x@evil.test" <me@example.com>');

    const quoted = buildMdnMessage({ ...base, fromName: 'Rath, Linus' });
    expect(quoted).toMatch(/^From: "Rath, Linus" <me@example\.com>$/m);

    const plain = buildMdnMessage({ ...base, fromName: 'Linus Rath' });
    expect(plain).toMatch(/^From: Linus Rath <me@example\.com>$/m);
  });

  it('address atoms (to, fromEmail, originalRecipient) drop controls and whitespace', () => {
    const msg = buildMdnMessage({
      ...base,
      to: 'sender@other.com\r\nBcc: leak@evil.test',
      fromEmail: 'me@example.com\r\nX-Injected: 1',
      originalRecipient: 'alias@example.com\nX-Also: 2',
    });
    const lines = headerLines(msg);
    expect(countHeader(lines, 'Bcc')).toBe(0);
    expect(msg).not.toMatch(/^X-Injected:/m);
    expect(msg).not.toMatch(/^X-Also:/m);
    expect(lines.find((l) => /^To:/.test(l))).toBe('To: sender@other.comBcc:leak@evil.test');
    expect(lines.find((l) => /^From:/.test(l))).toBe('From: me@example.comX-Injected:1');
    expect(msg).toContain('Original-Recipient: rfc822;alias@example.comX-Also:2');
    expect(msg).toContain('Final-Recipient: rfc822;alias@example.comX-Also:2');
  });

  it('a Disposition-Notification-To with a blank line cannot append a body', () => {
    const msg = buildMdnMessage({ ...base, to: 'sender@other.com\r\n\r\nForged body' });
    expect(headerLines(msg).find((l) => /^To:/.test(l))).toBe('To: sender@other.comForgedbody');
    expect(body(msg)).not.toContain('Forged');
  });

  it('Message-ID from the original cannot inject into In-Reply-To / Original-Message-ID', () => {
    const msg = buildMdnMessage({
      ...base,
      originalMessageId: ['<orig@other.com>\r\nReply-To: x@evil.test'],
    });
    expect(msg).not.toMatch(/^Reply-To:/m);
    expect(msg).toMatch(/^In-Reply-To: <orig@other\.com>Reply-To:x@evil\.test$/m);
    expect(msg).toMatch(/^Original-Message-ID: <orig@other\.com>Reply-To:x@evil\.test$/m);
  });

  it('Reporting-UA cannot inject into the disposition-notification part', () => {
    const msg = buildMdnMessage({ ...base, reportingUa: 'ua\r\nDisposition: deleted' });
    expect(msg.match(/^Disposition:/gm)).toHaveLength(1);
    expect(msg).toMatch(/^Reporting-UA: ua Disposition: deleted$/m);
  });

  it('never emits a header line containing a bare CR or LF for any input', () => {
    const nasty = 'x\r\ny\rz\nw\r\n\r\nv';
    const msg = buildMdnMessage({
      to: nasty,
      fromEmail: nasty,
      fromName: nasty,
      originalMessageId: nasty,
      originalSubject: nasty,
      originalRecipient: nasty,
      reportingUa: nasty,
      subject: nasty,
    });
    // Every line of the message is terminated by CRLF only; no stray CR/LF inside.
    for (const line of msg.split('\r\n')) {
      expect(line).not.toMatch(/[\r\n]/);
    }
    const lines = headerLines(msg);
    expect(countHeader(lines, 'From')).toBe(1);
    expect(countHeader(lines, 'To')).toBe(1);
    expect(countHeader(lines, 'Subject')).toBe(1);
  });
});
