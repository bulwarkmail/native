import { describe, expect, it } from 'vitest';
import { PLAIN_PASTE_MAX_CHARS, PLAIN_PASTE_MAX_DEPTH, plainTextPasteHtml } from '../plain-text-paste';

// Ported from webmail components/email/__tests__/plain-text-paste.test.ts.
// Webmail renders every line as a <p>, list items included. Here an item's
// lines are joined with <br> inside the <li>, so Enter at the end of a pasted
// item starts a new item in the contenteditable editor, as it does after
// typing a list. A blank line is <p><br></p>, since an empty <p> collapses.
describe('plainTextPasteHtml', () => {
  it('returns null when the text has no list, leaving the default paste', () => {
    expect(plainTextPasteHtml('Hi Joost,\n\nThanks for the write-up.\n\n\nPHASE 1')).toBeNull();
    expect(plainTextPasteHtml('')).toBeNull();
    expect(plainTextPasteHtml('big ')).toBeNull();
  });

  it('turns dash items into a bullet list, dropping the blank lines between them', () => {
    expect(plainTextPasteHtml('How it works:\n\n- One\n\n- Two\n\nAfter')).toBe(
      '<p>How it works:</p><p><br></p>' +
        '<ul><li>One</li><li>Two</li></ul>' +
        '<p><br></p><p>After</p>',
    );
  });

  it('treats CRLF and CR line endings like LF', () => {
    expect(plainTextPasteHtml('one\r\n\r\n- two\r- three')).toBe(
      '<p>one</p><p><br></p><ul><li>two</li><li>three</li></ul>',
    );
  });

  it('accepts * and • as bullet markers', () => {
    expect(plainTextPasteHtml('* One\n• Two')).toBe('<ul><li>One</li><li>Two</li></ul>');
  });

  it('accepts a tab after the marker', () => {
    expect(plainTextPasteHtml('-\tOne\n2)\tTwo')).toBe('<ul><li>One</li></ul><ol start="2"><li>Two</li></ol>');
  });

  it('turns numbered items into an ordered list that keeps its first number', () => {
    expect(plainTextPasteHtml('1. One\n2) Two\n\nText\n\n3. Three\n4. Four')).toBe(
      '<ol><li>One</li><li>Two</li></ol><p><br></p><p>Text</p><p><br></p>' +
        '<ol start="3"><li>Three</li><li>Four</li></ol>',
    );
  });

  it('starts a new list where a numbered list switches to dashes', () => {
    expect(plainTextPasteHtml('1. One\n\n- Dash')).toBe(
      '<ol><li>One</li></ol><p><br></p><ul><li>Dash</li></ul>',
    );
  });

  it('keeps indented lines inside the item above them', () => {
    expect(plainTextPasteHtml('- Both drafts:\n  filenode-14\n  blobext-01\n\nAfter')).toBe(
      '<ul><li>Both drafts:<br>filenode-14<br>blobext-01</li></ul><p><br></p><p>After</p>',
    );
  });

  it('nests indented items', () => {
    expect(plainTextPasteHtml('- Outer\n  - Inner\n- Next')).toBe(
      '<ul><li>Outer<ul><li>Inner</li></ul></li><li>Next</li></ul>',
    );
  });

  it('counts a tab as four columns of indent', () => {
    expect(plainTextPasteHtml('- Outer\n\t- Inner\n    - Same level\n- Next')).toBe(
      '<ul><li>Outer<ul><li>Inner</li><li>Same level</li></ul></li><li>Next</li></ul>',
    );
  });

  it('ends a list where the indent changes', () => {
    expect(plainTextPasteHtml('  - Indented\n- Outdented')).toBe(
      '<ul><li>Indented</li></ul><ul><li>Outdented</li></ul>',
    );
  });

  it('keeps a hard-wrapped item whole', () => {
    expect(plainTextPasteHtml('- A long item that the\nsender wrapped\n- Next')).toBe(
      '<ul><li>A long item that the<br>sender wrapped</li><li>Next</li></ul>',
    );
  });

  it('ends a lazy continuation at a blank line', () => {
    expect(plainTextPasteHtml('- Item\n\nAfter')).toBe('<ul><li>Item</li></ul><p><br></p><p>After</p>');
  });

  it('leaves a signature delimiter and a dash inside a sentence alone', () => {
    expect(plainTextPasteHtml('Costs - roughly\n-- \nLinus')).toBeNull();
    expect(plainTextPasteHtml('- \n-x\n1.5 litres\n1234. Too long')).toBeNull();
  });

  it('pastes untrusted text as text, never as markup', () => {
    const html = plainTextPasteHtml('<b>bold</b> & "q"\n- <script>alert(1)</script>\n- it\'s <img src=x onerror=alert(1)>');
    expect(html).toBe(
      '<p>&lt;b&gt;bold&lt;/b&gt; &amp; &quot;q&quot;</p>' +
        '<ul><li>&lt;script&gt;alert(1)&lt;/script&gt;</li>' +
        '<li>it&#39;s &lt;img src=x onerror=alert(1)&gt;</li></ul>',
    );
    expect(html).not.toMatch(/<(script|b|img)\b/);
  });

  it('converts a 200 KB paste quickly', () => {
    const lines: string[] = [];
    let size = 0;
    for (let i = 0; size < 200 * 1024; i++) {
      const line = `${'  '.repeat(i % 6)}- item ${i} with some words in it`;
      lines.push(line);
      if (i % 7 === 0) lines.push('a lazy continuation line');
      size += line.length + 1;
    }
    const text = lines.join('\n');
    expect(text.length).toBeLessThanOrEqual(PLAIN_PASTE_MAX_CHARS);
    const started = Date.now();
    const html = plainTextPasteHtml(text);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(html).toContain('<li>item 0 with some words in it');
  });

  it('converts lists nested up to the depth cap', () => {
    const text = Array.from({ length: PLAIN_PASTE_MAX_DEPTH }, (_, i) => `${'  '.repeat(i)}- x`).join('\n');
    const html = plainTextPasteHtml(text)!;
    expect(html.match(/<ul>/g)).toHaveLength(PLAIN_PASTE_MAX_DEPTH);
  });

  it('pastes a staircase of ever deeper items as text, quickly', () => {
    expect(plainTextPasteHtml(
      Array.from({ length: PLAIN_PASTE_MAX_DEPTH + 1 }, (_, i) => `${'  '.repeat(i)}- x`).join('\n'),
    )).toBeNull();
    const lines: string[] = [];
    for (let i = 0, size = 0; size < 200 * 1024; i++) {
      const line = `${' '.repeat(i)}- x`;
      lines.push(line);
      size += line.length + 1;
    }
    const started = Date.now();
    expect(plainTextPasteHtml(lines.join('\n'))).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('leaves a paste above the size cap to the default paste', () => {
    expect(plainTextPasteHtml(`- a\n${'x'.repeat(PLAIN_PASTE_MAX_CHARS)}`)).toBeNull();
  });
});
