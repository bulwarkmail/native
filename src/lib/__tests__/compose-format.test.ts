import { describe, it, expect } from 'vitest';
import {
  markdownToHtml,
  wrapSelection,
  toggleLinePrefix,
  formatReplyQuote,
} from '../compose-format';

describe('markdownToHtml', () => {
  it('escapes HTML in plain paragraphs', () => {
    expect(markdownToHtml('hi <script>alert(1)</script>')).toBe(
      '<p>hi &lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });

  it('renders bold and italic', () => {
    expect(markdownToHtml('see **this** and _that_')).toContain('<b>this</b>');
    expect(markdownToHtml('see **this** and _that_')).toContain('<i>that</i>');
  });

  it('renders bullet list', () => {
    const html = markdownToHtml('- one\n- two\n- three');
    expect(html).toBe('<ul><li>one</li><li>two</li><li>three</li></ul>');
  });

  it('renders ordered list', () => {
    const html = markdownToHtml('1. one\n2. two');
    expect(html).toBe('<ol><li>one</li><li>two</li></ol>');
  });

  it('renders blockquotes', () => {
    expect(markdownToHtml('> quoted\n> more')).toBe(
      '<blockquote>quoted<br />more</blockquote>',
    );
  });

  it('preserves multiple paragraphs separated by blank lines', () => {
    const html = markdownToHtml('first line\n\nsecond para');
    expect(html).toBe('<p>first line</p>\n<p>second para</p>');
  });

  it('preserves single line breaks within a paragraph as <br>', () => {
    const html = markdownToHtml('one\ntwo');
    expect(html).toBe('<p>one<br />two</p>');
  });

  it('renders markdown links', () => {
    const html = markdownToHtml('Click [here](https://example.com) please');
    expect(html).toContain('<a href="https://example.com" rel="noopener noreferrer">here</a>');
  });

  it('rejects javascript: links', () => {
    const html = markdownToHtml('[evil](javascript:alert(1))');
    expect(html).not.toContain('href="javascript:');
  });

  it('auto-links bare URLs', () => {
    const html = markdownToHtml('go to https://x.test now');
    expect(html).toContain('<a href="https://x.test"');
  });

  it('renders inline cid images', () => {
    const html = markdownToHtml('![pic.png](cid:abc@x)');
    expect(html).toContain('<img src="cid:abc@x" alt="pic.png" />');
  });
});

describe('wrapSelection', () => {
  it('wraps the selected range with markers', () => {
    const r = wrapSelection('hello world', { start: 6, end: 11 }, '**', '**');
    expect(r.text).toBe('hello **world**');
    expect(r.selection).toEqual({ start: 8, end: 13 });
  });

  it('inserts placeholder when nothing is selected', () => {
    const r = wrapSelection('hi ', { start: 3, end: 3 }, '**', '**', 'bold');
    expect(r.text).toBe('hi **bold**');
    expect(r.selection).toEqual({ start: 5, end: 9 });
  });

  it('handles reversed selection (end before start)', () => {
    const r = wrapSelection('abc', { start: 3, end: 0 }, '_', '_');
    expect(r.text).toBe('_abc_');
  });
});

describe('toggleLinePrefix', () => {
  it('adds prefix to a single line', () => {
    const r = toggleLinePrefix('hello', { start: 2, end: 2 }, '- ');
    expect(r.text).toBe('- hello');
  });

  it('adds prefix to every line in selection', () => {
    const r = toggleLinePrefix('one\ntwo\nthree', { start: 0, end: 13 }, '- ');
    expect(r.text).toBe('- one\n- two\n- three');
  });

  it('removes prefix when every line already has it (toggle)', () => {
    const r = toggleLinePrefix('- one\n- two', { start: 0, end: 11 }, '- ');
    expect(r.text).toBe('one\ntwo');
  });
});

describe('formatReplyQuote', () => {
  it('prefixes original body lines with "> "', () => {
    const out = formatReplyQuote('hello\nworld', {
      senderName: 'Alice',
      date: new Date('2026-04-27'),
    });
    expect(out).toContain('> hello');
    expect(out).toContain('> world');
    expect(out).toContain('Alice wrote:');
  });
});
