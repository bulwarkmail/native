import { describe, it, expect } from 'vitest';
import {
  sanitizeSignatureHtml,
  getPlainTextSignature,
  appendPlainTextSignature,
  plainTextBodyHasSignature,
  plainTextBodyWithoutSignature,
  buildEmbeddedSignatureHtml,
  containsEmbeddedSignature,
  spliceSignature,
  stripEmbeddedSignature,
  insertSignatureAboveQuote,
  signatureIdentityFor,
  signPlainTextReply,
  signatureHasOwnDelimiter,
} from '../signature-utils';

describe('sanitizeSignatureHtml', () => {
  it('keeps formatting, links and https images', () => {
    const out = sanitizeSignatureHtml('<p><b>Jane</b> <a href="https://x.y">site</a> <img src="https://x.y/l.png" alt="l"></p>');
    expect(out).toBe('<p><b>Jane</b> <a href="https://x.y">site</a> <img src="https://x.y/l.png" alt="l"></p>');
  });

  it('drops scripts, event handlers, javascript: links and http images', () => {
    const out = sanitizeSignatureHtml('<p onclick="x()">a<script>b()</script><a href="javascript:1">l</a><img src="http://x/l.png"></p>');
    expect(out).toBe('<p>a<a>l</a></p>');
  });

  it('drops disallowed tags but keeps their text', () => {
    expect(sanitizeSignatureHtml('<h1>Hi</h1><ul><li>x</li></ul>')).toBe('Hix');
  });
});

describe('plain-text signature helpers', () => {
  const sig = { textSignature: 'Jane\r\nACME  \n' };

  it('normalizes line breaks', () => {
    expect(getPlainTextSignature(sig)).toBe('Jane\nACME');
    expect(getPlainTextSignature({ htmlSignature: '<p>Jane</p><p>ACME</p>' })).toBe('Jane\n\nACME');
  });

  it('appends with and without separator', () => {
    expect(appendPlainTextSignature('hi', sig)).toBe('hi\n\n-- \nJane\nACME');
    expect(appendPlainTextSignature('hi', sig, { separator: false })).toBe('hi\n\nJane\nACME');
    expect(appendPlainTextSignature('hi', null)).toBe('hi');
  });

  it('detects and strips a trailing signature', () => {
    const body = 'hello\n\n-- \nJane\nACME';
    expect(plainTextBodyHasSignature(body, sig)).toBe(true);
    expect(plainTextBodyWithoutSignature(body, sig)).toBe('hello');
    expect(plainTextBodyWithoutSignature('other', sig)).toBe('other');
  });
});

describe('embedded signature range', () => {
  const identity = { textSignature: 'Jane <jane@x.y>' };

  it('builds a marked range with the separator', () => {
    const html = buildEmbeddedSignatureHtml(identity, { separator: true });
    expect(html).toContain('data-signature-block="separator">-- </p>');
    expect(html).toContain('Jane &lt;jane@x.y&gt;');
    expect(html).toContain('data-signature-block="end"');
    expect(containsEmbeddedSignature(html)).toBe(true);
    expect(buildEmbeddedSignatureHtml({}, { separator: true })).toBe('');
  });

  it('swaps the range on identity change and strips it', () => {
    const a = buildEmbeddedSignatureHtml({ textSignature: 'A' }, { separator: true });
    const b = buildEmbeddedSignatureHtml({ htmlSignature: '<b>B</b>' }, { separator: false });
    const body = `<p>hello</p>${a}<div data-quoted-html="true">q</div>`;
    const swapped = spliceSignature(body, b);
    expect(swapped).toBe(`<p>hello</p>${b}<div data-quoted-html="true">q</div>`);
    expect(stripEmbeddedSignature(swapped)).toBe('<p>hello</p><div data-quoted-html="true">q</div>');
    expect(spliceSignature('<p>x</p>', a)).toBe(`<p>x</p>${a}`);
  });

  it('swaps the signature after the user typed into the line under it, keeping the text', () => {
    const a = buildEmbeddedSignatureHtml({ textSignature: 'A' }, { separator: true });
    const b = buildEmbeddedSignatureHtml({ textSignature: 'B' }, { separator: true });
    const typed = a.replace('data-signature-block="end"><br></p>', 'data-signature-block="end">PS: call me</p>');
    expect(typed).not.toBe(a);
    const body = `<p>hello</p>${typed}<div data-quoted-html="true">q</div>`;
    expect(containsEmbeddedSignature(body)).toBe(true);
    const swapped = spliceSignature(body, b);
    expect(swapped).toBe(`<p>hello</p>${b}<p>PS: call me</p><div data-quoted-html="true">q</div>`);
    // One signature, never two.
    expect(swapped.match(/data-signature-block="body"/g)).toHaveLength(1);
    expect(stripEmbeddedSignature(body)).toBe('<p>hello</p><p>PS: call me</p><div data-quoted-html="true">q</div>');
  });

  it('inserts above the quote marker', () => {
    const sig = buildEmbeddedSignatureHtml({ textSignature: 'S' }, { separator: true });
    const marker = '<div data-quoted-html="true">';
    expect(insertSignatureAboveQuote(`<p><br></p>${marker}q</div>`, sig, marker)).toBe(`<p><br></p>${sig}${marker}q</div>`);
    expect(insertSignatureAboveQuote('<p>x</p>', sig, marker)).toBe(`<p>x</p>${sig}`);
  });
});

describe('signatureIdentityFor', () => {
  const primary = { id: 'p', mayDelete: false, textSignature: 'Primary sig' };
  const alias = { id: 'a', mayDelete: true };
  const signedAlias = { id: 's', mayDelete: true, htmlSignature: '<b>Alias</b>' };

  it('uses the identity\'s own signature, else the primary\'s', () => {
    expect(signatureIdentityFor(signedAlias, [alias, primary, signedAlias])).toBe(signedAlias);
    expect(signatureIdentityFor(alias, [alias, primary, signedAlias])).toBe(primary);
  });

  it("keeps a hand-picked identity's own empty signature", () => {
    expect(signatureIdentityFor(alias, [alias, primary], { pickedByUser: true })).toBeNull();
    expect(signatureIdentityFor(signedAlias, [alias, primary, signedAlias], { pickedByUser: true })).toBe(signedAlias);
  });

  it('returns null when neither has one', () => {
    expect(signatureIdentityFor(alias, [alias, { id: 'p', mayDelete: false }])).toBeNull();
    expect(signatureIdentityFor(null, [primary])).toBeNull();
  });
});

describe('signPlainTextReply', () => {
  const sig = { textSignature: 'Jane' };

  it('puts the signature between the reply and the quote above the quote', () => {
    expect(signPlainTextReply('Thanks', 'Bob wrote:\n> hi', sig, { position: 'above_quote', separator: true }))
      .toBe('Thanks\n\n-- \nJane\n\nBob wrote:\n> hi');
  });

  it('puts it at the very end below the quote', () => {
    expect(signPlainTextReply('Thanks', 'Bob wrote:\n> hi', sig, { position: 'below_quote', separator: false }))
      .toBe('Thanks\n\nBob wrote:\n> hi\n\nJane');
  });

  it('leaves the reply alone without a signature', () => {
    expect(signPlainTextReply('Thanks', 'q', null, { position: 'above_quote', separator: true })).toBe('Thanks\n\nq');
  });
});

describe('a signature with its own "-- " line', () => {
  const own = { textSignature: '-- \nUser A\nstw-test' };
  const plain = { textSignature: 'User A\nstw-test' };

  it('is detected, also with a bare "--" or a leading blank line', () => {
    expect(signatureHasOwnDelimiter(own)).toBe(true);
    expect(signatureHasOwnDelimiter({ textSignature: '\n--\nUser A' })).toBe(true);
    expect(signatureHasOwnDelimiter(plain)).toBe(false);
    expect(signatureHasOwnDelimiter({ htmlSignature: '<p>-- </p><p>User A</p>' })).toBe(true);
  });

  it('gets no second separator in plain text or HTML', () => {
    const delimiters = (text: string) => text.split('\n').filter((line) => /^--\s*$/.test(line)).length;
    expect(delimiters(appendPlainTextSignature('Hi', own, { separator: true }))).toBe(1);
    expect(appendPlainTextSignature('Hi', plain, { separator: true })).toBe('Hi\n\n-- \nUser A\nstw-test');
    expect(buildEmbeddedSignatureHtml(own, { separator: true })).not.toContain('="separator"');
    expect(buildEmbeddedSignatureHtml(plain, { separator: true })).toContain('="separator"');
  });
});
