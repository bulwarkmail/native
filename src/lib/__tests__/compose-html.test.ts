import { describe, it, expect } from 'vitest';
import {
  buildInitialHtml, htmlToPlainText, rewriteInlineImages, extractUserAuthoredText,
  rewriteCidImagesForEditor, replaceInlineImagePlaceholders,
} from '../compose-html';

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
    // Header shows the full sender incl. address, escaped (webmail #482).
    expect(html).toMatch(/On .+, Alice &lt;a@b.com&gt; wrote:/);
    expect(html).toContain('data-quoted-html');
    expect(html).toContain('<blockquote');
    expect(html).toContain('line one<br>line two');
  });

  it('falls back to the email address when the sender has no name', () => {
    const html = buildInitialHtml('reply', {
      from: { email: 'a@b.com' },
      body: 'hi',
      receivedAt: '2026-04-27T10:00:00Z',
    });
    expect(html).toContain('a@b.com wrote:');
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

  it('keeps the "-- " signature delimiter', () => {
    expect(htmlToPlainText('<p>Thanks</p><p data-signature-block="separator">-- </p><p>Jane</p>')).toBe('Thanks\n\n-- \n\nJane');
    expect(htmlToPlainText('<p>Thanks</p><p>--&nbsp;</p><p>Jane</p>')).toBe('Thanks\n\n-- \n\nJane');
  });
});

describe('htmlToPlainText with mail markup (the sent text part)', () => {
  const mail = (html: string) => htmlToPlainText(html, { mailMarkup: true });

  it('marks quoted text with "> ", nested quotes twice', () => {
    expect(mail('<p>My reply</p><div data-quoted-html="true">On Monday, Ann wrote:<br><blockquote style="x">Hello<br>there<blockquote>older</blockquote></blockquote></div>'))
      .toBe('My reply\n\nOn Monday, Ann wrote:\n\n> Hello\n> there\n>\n> > older');
  });

  it('numbers ordered lists from their start and dashes bullet lists', () => {
    expect(mail('<ol><li>one</li><li>two</li></ol><ul><li>a</li></ul><ol start="4"><li>four</li></ol>'))
      .toBe('1. one\n2. two\n- a\n4. four');
  });

  it('numbers a list nested in a bullet item on its own', () => {
    expect(mail('<ul><li>a<ol><li>x</li><li>y</li></ol></li><li>b</li></ul>')).toBe('- a\n1. x\n2. y\n\n- b');
  });

  it('keeps the signature delimiter', () => {
    expect(mail('<p>Hi</p><p data-signature-block="separator">-- </p><p>Jane</p>')).toBe('Hi\n\n-- \n\nJane');
  });

  it('writes a described image as its description and leaves decorative and undescribed ones out', () => {
    const withAlt = (html: string) => htmlToPlainText(html, { mailMarkup: true, imageAlt: (alt) => `[Image: ${alt}]` });
    expect(withAlt('<p>Look <img src="cid:a" alt="a red &amp; blue bike"> here</p>')).toBe('Look [Image: a red & blue bike] here');
    expect(withAlt('<p>A<img src="cid:b" alt="">B<img src="cid:c">C</p>')).toBe('ABC');
    expect(withAlt('<p><img alt="x <y>" src="cid:d"></p>')).toBe('[Image: x <y>]');
    // Without the option images stay out, as before.
    expect(mail('<p>A<img src="cid:a" alt="bike">B</p>')).toBe('AB');
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

describe('htmlToPlainText links', () => {
  it('renders a link as text <href>', () => {
    expect(htmlToPlainText('<p>see <a href="https://x.y/z">docs</a></p>')).toBe('see docs <https://x.y/z>');
  });

  it('keeps a bare URL link as the URL only', () => {
    expect(htmlToPlainText('<a href="https://x.y">https://x.y</a>')).toBe('https://x.y');
  });

  it('drops the mailto: prefix when the text is the address', () => {
    expect(htmlToPlainText('<a href="mailto:a@b.c">a@b.c</a>')).toBe('a@b.c');
  });

  it('writes an @mention as the name alone, as the webmail does', () => {
    expect(htmlToPlainText('<p>Hi <a href="mailto:max@x.de" class="mention">@Max</a>&nbsp;how</p>', { mailMarkup: true }))
      .toBe('Hi @Max how');
  });
});

describe('extractUserAuthoredText', () => {
  it('drops the quoted island and blockquotes', () => {
    const html = buildInitialHtml('reply', {
      from: { name: 'Alice', email: 'a@b.com' },
      body: 'please find attached the invoice',
      receivedAt: '2026-04-27T10:00:00Z',
    });
    const text = extractUserAuthoredText('<p>thanks</p>' + html);
    expect(text).toBe('thanks');
  });

  it('cuts everything from the forwarded separator', () => {
    const text = extractUserAuthoredText(
      '<p>fyi</p><div>---------- Forwarded message ----------<br>From: x</div><p>attached</p>',
      { forwardedSeparator: '---------- Forwarded message ----------' },
    );
    expect(text.trim()).toBe('fyi');
  });

  it('drops quoted lines in plain-text mode', () => {
    expect(extractUserAuthoredText('mine\n> theirs attached', { plainTextMode: true })).toBe('mine');
  });
});

describe('cid image hydration', () => {
  it('rewrites cid: images to placeholders with data-cid and back to data URLs', () => {
    const { html, cids } = rewriteCidImagesForEditor('<p><img src="cid:pic@x" alt="p"></p>');
    expect(cids).toEqual(['pic@x']);
    expect(html).toContain('data-cid="pic@x"');
    expect(html).not.toContain('cid:pic@x');
    const hydrated = replaceInlineImagePlaceholders(html, new Map([['pic@x', 'data:image/png;base64,AAA']]));
    expect(hydrated).toContain('src="data:image/png;base64,AAA"');
    expect(hydrated).toContain('data-cid="pic@x"');
    expect(rewriteInlineImages(hydrated).html).toContain('src="cid:pic@x"');
  });

  // The composer builds the URI from the part's type, which the server
  // returns verbatim.
  it('leaves the placeholder when the data URL is not an image type plus base64', () => {
    const { html } = rewriteCidImagesForEditor('<p><img src="cid:pic@x"></p>');
    const hostile = 'data:image/x"><meta http-equiv=refresh content=0,url=https://evil.example/>;base64,QUJD';
    const hydrated = replaceInlineImagePlaceholders(html, new Map([['pic@x', hostile]]));
    expect(hydrated).toBe(html);
    expect(hydrated).not.toContain('<meta');
  });
});
