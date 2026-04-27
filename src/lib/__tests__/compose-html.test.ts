import { describe, it, expect } from 'vitest';
import { buildInitialHtml, htmlToPlainText, rewriteInlineImages } from '../compose-html';

describe('buildInitialHtml', () => {
  it('returns empty paragraph for plain compose', () => {
    expect(buildInitialHtml('compose')).toBe('<p><br></p>');
  });

  it('returns empty paragraph when reply has no body', () => {
    expect(buildInitialHtml('reply', { from: { email: 'a@b.com' } })).toBe('<p><br></p>');
  });

  it('builds reply with quoted plain-text body and sender label', () => {
    const html = buildInitialHtml('reply', {
      from: { name: 'Alice', email: 'a@b.com' },
      subject: 'Hello',
      body: 'line one\nline two',
      receivedAt: '2026-04-27T10:00:00Z',
    });
    expect(html).toContain('<p><br></p>');
    expect(html).toContain('Alice &lt;a@b.com&gt; wrote:');
    expect(html).toContain('<blockquote');
    expect(html).toContain('line one<br>line two');
  });

  it('uses HTML body when present, stripping dangerous tags', () => {
    const html = buildInitialHtml('reply', {
      from: { email: 'x@y.com' },
      body: 'fallback',
      htmlBody: '<p>safe</p><script>alert(1)</script>',
    });
    expect(html).toContain('<p>safe</p>');
    expect(html).not.toContain('<script');
  });

  it('forward: includes "Forwarded message" header and From/Subject lines', () => {
    const html = buildInitialHtml('forward', {
      from: { name: 'Bob', email: 'b@c.com' },
      subject: 'Original Subject',
      body: 'forwarded body',
      receivedAt: '2026-04-27T10:00:00Z',
    });
    expect(html).toContain('Forwarded message');
    expect(html).toContain('From: Bob &lt;b@c.com&gt;');
    expect(html).toContain('Subject: Original Subject');
    expect(html).toContain('forwarded body');
  });

  it('escapes HTML in plain-text quoted body', () => {
    const html = buildInitialHtml('reply', {
      from: { email: 'a@b.com' },
      body: '<script>x</script>',
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});

describe('htmlToPlainText', () => {
  it('returns empty string for empty input', () => {
    expect(htmlToPlainText('')).toBe('');
  });

  it('strips tags and decodes entities', () => {
    expect(htmlToPlainText('<p>hello &amp; world</p>')).toBe('hello & world');
  });

  it('converts <br> to newline', () => {
    expect(htmlToPlainText('a<br>b<br/>c')).toBe('a\nb\nc');
  });

  it('treats block boundaries as newlines', () => {
    expect(htmlToPlainText('<p>a</p><p>b</p>')).toBe('a\n\nb');
  });

  it('renders list items with bullet prefix', () => {
    expect(htmlToPlainText('<ul><li>one</li><li>two</li></ul>')).toBe('• one\n• two');
  });

  it('collapses excessive blank lines', () => {
    expect(htmlToPlainText('<p>a</p><br><br><br><p>b</p>')).toBe('a\n\nb');
  });

  it('decodes &nbsp; to space', () => {
    expect(htmlToPlainText('hello&nbsp;world')).toBe('hello world');
  });
});

describe('rewriteInlineImages', () => {
  it('returns input unchanged when no data-cid is present', () => {
    const html = '<p>hi <img src="https://x"></p>';
    const out = rewriteInlineImages(html);
    expect(out.html).toBe(html);
    expect(out.usedCids).toEqual([]);
  });

  it('rewrites data-cid images to cid: src and reports the CID', () => {
    const html = '<p><img src="data:image/png;base64,xxx" data-cid="abc@x" alt="pic"></p>';
    const out = rewriteInlineImages(html);
    expect(out.html).toContain('src="cid:abc@x"');
    expect(out.html).not.toContain('data-cid');
    expect(out.html).not.toContain('data:image/png');
    expect(out.usedCids).toEqual(['abc@x']);
  });

  it('handles single-quoted attributes', () => {
    const html = `<img src='data:image/png' data-cid='zzz' alt='x'>`;
    const out = rewriteInlineImages(html);
    expect(out.html).toContain('src="cid:zzz"');
    expect(out.usedCids).toEqual(['zzz']);
  });

  it('preserves alt attribute on rewritten images', () => {
    const html = '<img src="data:" alt="my pic" data-cid="m1">';
    const out = rewriteInlineImages(html);
    expect(out.html).toContain('alt="my pic"');
  });

  it('reports each cid only once even if image referenced multiple times', () => {
    const html = '<img src="data:" data-cid="dup"><img src="data:" data-cid="dup">';
    const out = rewriteInlineImages(html);
    expect(out.usedCids).toEqual(['dup']);
  });
});
