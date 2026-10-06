import { describe, it, expect } from 'vitest';
import {
  isValidEmail,
  splitRecipients,
  parseRecipient,
  parseRecipientList,
  formatRecipient,
  expandRecipients,
  splitPastedRecipients,
  parseMailtoUrl,
} from '../recipients';

describe('isValidEmail', () => {
  it('accepts an address on an internationalized domain', () => {
    expect(isValidEmail('user@bücher.de')).toBe(true);
    expect(isValidEmail('user@ノード.com')).toBe(true);
    expect(isValidEmail('user@xn--bcher-kva.de')).toBe(true);
  });

  it('still rejects a bad internationalized address', () => {
    expect(isValidEmail('user@bü cher.de')).toBe(false);
    expect(isValidEmail('user@bücher..de')).toBe(false);
    expect(isValidEmail('user@.bücher.de')).toBe(false);
    expect(isValidEmail('üser@bücher.de')).toBe(false);
  });

  it('accepts ordinary addresses', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('first.last+tag@sub.example.org')).toBe(true);
  });

  it('rejects injection and malformed input', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('a@b')).toBe(true);
    expect(isValidEmail('a@b..c')).toBe(false);
    expect(isValidEmail('a@b.c\r\nBcc: x@y.z')).toBe(false);
    expect(isValidEmail('<a@b.c>')).toBe(false);
    expect(isValidEmail('noat')).toBe(false);
  });
});

describe('splitRecipients', () => {
  it('splits on commas outside quotes and angle brackets', () => {
    expect(splitRecipients('"Doe, John" <j@x.com>, b@y.com')).toEqual(['"Doe, John" <j@x.com>', 'b@y.com']);
  });

  it('recovers from an unclosed angle bracket', () => {
    expect(splitRecipients('John <j@x.com, b@y.com')).toEqual(['John <j@x.com', 'b@y.com']);
  });

  it('keeps RFC 5322 groups as one entry', () => {
    expect(splitRecipients('Team: a@x.com, b@y.com;, c@z.com')).toEqual(['Team: a@x.com, b@y.com;', 'c@z.com']);
  });

  it('keeps an escaped quote inside the display name (no extra recipient)', () => {
    const input = '"Support\\", ceo@corp.example, \\"x" <support@shop.example>';
    expect(splitRecipients(input)).toEqual([input]);
  });

  it('round-trips a name containing quotes and commas', () => {
    const name = 'Support", ceo@corp.example, "x';
    const formatted = formatRecipient(name, 'support@shop.example');
    const parts = splitRecipients(`${formatted}, other@example.com`);
    expect(parts).toHaveLength(2);
    expect(parseRecipient(parts[0])).toEqual({ name, email: 'support@shop.example' });
  });
});

describe('parseRecipient', () => {
  it('parses Name <email> and unquotes the name', () => {
    expect(parseRecipient('"Doe, John" <j@x.com>')).toEqual({ name: 'Doe, John', email: 'j@x.com' });
    expect(parseRecipient('Jane <jane@x.com>')).toEqual({ name: 'Jane', email: 'jane@x.com' });
  });

  it('parses a bare address', () => {
    expect(parseRecipient(' a@b.com ')).toEqual({ email: 'a@b.com' });
  });

  it('parses a group into member chips', () => {
    const r = parseRecipient('Team: a@x.com, "B" <b@y.com>;');
    expect(r.email).toBe('');
    expect(r.name).toBe('Team');
    expect(r.group?.members.map((m) => m.email)).toEqual(['a@x.com', 'b@y.com']);
  });

  it('round-trips through formatRecipient / parseRecipientList', () => {
    const list = parseRecipientList([formatRecipient('Doe, John', 'j@x.com'), formatRecipient(undefined, 'b@y.com')].join(', '));
    expect(list).toEqual([{ name: 'Doe, John', email: 'j@x.com' }, { email: 'b@y.com' }]);
  });

  it('does not open a group on a colon after an escaped quote', () => {
    const r = parseRecipient('"a\\": b" <a@example.com>');
    expect(r.group).toBeUndefined();
    expect(r.email).toBe('a@example.com');
  });
});

describe('expandRecipients', () => {
  it('expands groups and dedupes case-insensitively', () => {
    const out = expandRecipients([
      { name: 'A', email: 'a@x.com' },
      { name: 'Team', email: '', group: { members: [{ email: 'A@x.com' }, { name: 'B', email: 'b@y.com' }] } },
    ]);
    expect(out).toEqual([{ name: 'A', email: 'a@x.com' }, { name: 'B', email: 'b@y.com' }]);
  });
});

describe('splitPastedRecipients', () => {
  it('keeps display names and splits bare dumps', () => {
    const { valid, invalid } = splitPastedRecipients('"Doe, John" <j@x.com>; b@y.com c@z.com\nnot-an-address');
    expect(valid).toEqual([{ name: 'Doe, John', email: 'j@x.com' }, { email: 'b@y.com' }, { email: 'c@z.com' }]);
    expect(invalid).toEqual(['not-an-address']);
  });

  it('recovers a name with a missing closing bracket', () => {
    const { valid } = splitPastedRecipients('Jane <jane@x.com');
    expect(valid).toEqual([{ name: 'Jane', email: 'jane@x.com' }]);
  });

  it('skips addresses already present', () => {
    const { valid } = splitPastedRecipients('a@x.com, b@y.com', ['A@x.com']);
    expect(valid).toEqual([{ email: 'b@y.com' }]);
  });

  it('unwraps a fully quoted recipient', () => {
    const { valid } = splitPastedRecipients('"Jane <jane@x.com>"');
    expect(valid).toEqual([{ name: 'Jane', email: 'jane@x.com' }]);
  });
});

describe('parseMailtoUrl', () => {
  it('parses recipients, subject and body', () => {
    expect(parseMailtoUrl('mailto:a@b.com,c@d.com?subject=Hi%20there&body=line1%0Aline2&cc=e@f.com')).toEqual({
      to: ['a@b.com', 'c@d.com'],
      cc: ['e@f.com'],
      bcc: undefined,
      subject: 'Hi there',
      body: 'line1\nline2',
    });
  });

  it('shares the strict parser: bidi and split-able addresses are refused, + stays literal', () => {
    expect(parseMailtoUrl('mailto:hr%E2%80%AE@corp.example')).toBeNull();
    expect(parseMailtoUrl('mailto:a%2Cb@x.com')).toBeNull();
    expect(parseMailtoUrl('mailto:a@b.co?subject=a+b')?.subject).toBe('a+b');
    expect(parseMailtoUrl('MAILTO:a@b.co')?.to).toEqual(['a@b.co']);
  });

  it('isValidEmail rejects bidi and control characters', () => {
    expect(isValidEmail('hr\u202E@corp.example')).toBe(false);
    expect(isValidEmail('a@b.co\u200B')).toBe(false);
    expect(isValidEmail('a,b@x.com')).toBe(false);
  });

  it('returns null for non-mailto or empty', () => {
    expect(parseMailtoUrl('https://x')).toBeNull();
    expect(parseMailtoUrl('mailto:')).toBeNull();
  });
});
