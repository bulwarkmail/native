import { describe, expect, it } from 'vitest';
import {
  htmlComposeBodyToPlainText, initialPlainTextMode, plainComposeBodyToHtml, plainTextToComposerHtml,
} from '../compose-format';
import { QUOTED_BLOCK_START } from '../compose-html';
import {
  appendPlainTextSignature, buildEmbeddedSignatureHtml, containsEmbeddedSignature, plainTextBodyHasSignature,
} from '../signature-utils';

const identity = { textSignature: 'Jane Doe\nACME' };
const opts = { separator: true };

describe('initialPlainTextMode', () => {
  it('keeps a reopened draft in the format it was written in', () => {
    expect(initialPlainTextMode({ htmlBody: '<p>Hi</p>', textBody: 'Hi' }, true)).toBe(false);
    expect(initialPlainTextMode({ textBody: 'Hi' }, false)).toBe(true);
  });

  it('follows the setting for an empty draft and a new message', () => {
    expect(initialPlainTextMode({}, true)).toBe(true);
    expect(initialPlainTextMode(undefined, false)).toBe(false);
  });
});

describe('plainTextToComposerHtml', () => {
  it('makes paragraphs and line breaks and escapes markup', () => {
    expect(plainTextToComposerHtml('a <b>\nline\n\nnext')).toBe('<p>a &lt;b&gt;<br>line</p><p>next</p>');
    expect(plainTextToComposerHtml('')).toBe('');
  });
});

describe('htmlComposeBodyToPlainText', () => {
  it('drops formatting', () => {
    expect(htmlComposeBodyToPlainText('<p><b>Hello</b> there</p>', identity, opts)).toBe('Hello there');
  });

  it('turns a trailing embedded signature into the plain-text signature', () => {
    const html = `<p>Hello</p>${buildEmbeddedSignatureHtml(identity, opts)}`;
    const text = htmlComposeBodyToPlainText(html, identity, opts);
    expect(text).toBe(appendPlainTextSignature('Hello', identity, opts));
    expect(plainTextBodyHasSignature(text, identity)).toBe(true);
  });

  it('keeps a signature placed above the quote above the quote', () => {
    const html = `<p>Hello</p>${buildEmbeddedSignatureHtml(identity, opts)}${QUOTED_BLOCK_START}<p>On Monday, Bob wrote:</p><blockquote>Old</blockquote></div>`;
    expect(htmlComposeBodyToPlainText(html, identity, opts))
      .toBe('Hello\n\n-- \nJane Doe\nACME\n\nOn Monday, Bob wrote:\n\nOld');
  });
});

describe('plainComposeBodyToHtml', () => {
  it('turns a trailing plain-text signature into the embedded one', () => {
    const html = plainComposeBodyToHtml(appendPlainTextSignature('Hello', identity, opts), identity, opts);
    expect(html).toBe(`<p>Hello</p>${buildEmbeddedSignatureHtml(identity, opts)}`);
    expect(containsEmbeddedSignature(html)).toBe(true);
  });

  it('keeps a signature above the quote in place', () => {
    const text = 'Hello\n\n-- \nJane Doe\nACME\n\nOn Monday, Bob wrote:\n> Old';
    expect(plainComposeBodyToHtml(text, identity, opts))
      .toBe(`<p>Hello</p>${buildEmbeddedSignatureHtml(identity, opts)}<p>On Monday, Bob wrote:<br>&gt; Old</p>`);
  });

  it('gives a signature-only body an empty first paragraph to type into', () => {
    const html = plainComposeBodyToHtml(appendPlainTextSignature('', identity, opts), identity, opts);
    expect(html).toBe(`<p><br></p>${buildEmbeddedSignatureHtml(identity, opts)}`);
  });

  it('converts a body without a signature as plain paragraphs', () => {
    expect(plainComposeBodyToHtml('Hi', null, opts)).toBe('<p>Hi</p>');
    expect(plainComposeBodyToHtml('', identity, opts)).toBe('<p><br></p>');
  });

  it('round-trips the signature without doubling it', () => {
    const start = `<p>Hello</p>${buildEmbeddedSignatureHtml(identity, opts)}`;
    const back = plainComposeBodyToHtml(htmlComposeBodyToPlainText(start, identity, opts), identity, opts);
    expect(back).toBe(start);
  });
});
