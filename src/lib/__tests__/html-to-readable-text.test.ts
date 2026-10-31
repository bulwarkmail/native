import { describe, expect, it } from 'vitest';
import { htmlToReadableText, plainTextReading } from '../html-to-readable-text';

// "Plain Text Only" promised plain-text reading, but the reader showed the
// HTML anyway. These are the webmail's cases for its converter
// (lib/__tests__/html-to-readable-text.test.ts) plus the HTML a DOM parser
// fixes up on its own.

describe('htmlToReadableText', () => {
  it('keeps paragraphs and line breaks', () => {
    expect(htmlToReadableText('<p>Hello <b>Ann</b>,</p><p>first line<br>second line</p>'))
      .toBe('Hello Ann,\n\nfirst line\nsecond line');
  });

  it('keeps link targets and image alt text', () => {
    expect(htmlToReadableText('<p>Read <a href="https://ex.com/a">the report</a> <img src="x.png" alt="Logo"></p>'))
      .toBe('Read the report (https://ex.com/a) [Logo]');
  });

  it('does not repeat a target that is the link text, and drops script and style', () => {
    expect(htmlToReadableText('<style>p{color:red}</style><a href="https://ex.com/">ex.com</a><script>x()</script>'))
      .toBe('ex.com');
    expect(htmlToReadableText('<a href="mailto:ann@ex.com?subject=Hi">Write to Ann</a>'))
      .toBe('Write to Ann (ann@ex.com)');
  });

  it('turns layout tables into lines and lists into bullets', () => {
    const html = '<table><tr><td>Name</td><td>Ann</td></tr><tr><td>City</td><td>Berlin</td></tr></table><ul><li>one</li><li>two</li></ul>';
    expect(htmlToReadableText(html)).toBe('Name Ann\nCity Berlin\n\n• one\n• two');
  });

  it('skips hidden preheaders and images without alt text', () => {
    expect(htmlToReadableText('<div style="display:none">preheader</div><img src="t.gif"><p>Body</p>')).toBe('Body');
  });

  it('reads a whole document: head, entities, comments and unclosed tags', () => {
    const html = '<!DOCTYPE html><html><head><title>T</title><style>a{}</style></head><body>'
      + '<!-- tracking --><p>Fish &amp; chips&nbsp;&#8364;5<p>Next <a href="https://ex.com/?a=1&amp;b=2">deal</a>'
      + '<ul><li>one<li>two</ul><script>if (a < b) document.write("<p>x</p>")</script></body></html>';
    expect(htmlToReadableText(html)).toBe('Fish & chips €5\n\nNext deal (https://ex.com/?a=1&b=2)\n\n• one\n• two');
  });

  it('keeps preformatted text and marks quotes', () => {
    expect(htmlToReadableText('<pre>a  b\n  c</pre>')).toBe('a  b\n  c');
    expect(htmlToReadableText('<p>On Monday Bob wrote:</p><blockquote>hi</blockquote>')).toBe('On Monday Bob wrote:\n\n> hi');
  });
});

describe('plainTextReading', () => {
  it("prefers the message's own text part, else converts the HTML, and leaves plain-text mail alone", () => {
    expect(plainTextReading({ html: '<p>Hi <b>there</b></p>', text: 'Hi there (text part)' })).toBe('Hi there (text part)');
    expect(plainTextReading({ html: '<p>Hi <b>there</b></p>', text: null })).toBe('Hi there');
    expect(plainTextReading({ html: '<p>Hi</p>', text: '   ' })).toBe('Hi');
    expect(plainTextReading({ html: null, text: 'just text' })).toBeNull();
  });
});
