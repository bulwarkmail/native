import { describe, expect, it } from 'vitest';
import { plainTextToSafeHtml, prepareEmailHtml, turnOffLinks, wrapPlainTextEmail } from '../email-html';
import { buildBodyDocument } from '../email-body-document';

// A message reported as phishing (`$phishing`, #124) has its links turned
// off, as in the webmail's lib/phishing-links: no address, a "turned off"
// title, and the look of text that was a link.

describe('turnOffLinks', () => {
  it('takes the address and its companions off every link and says so', () => {
    const out = turnOffLinks(
      '<p><a href="https://evil.example/login" target="_blank" rel="noopener" title="Sign in" tabindex="1" ping="https://t.example">Sign in</a></p>',
      'link turned off',
    );
    expect(out).not.toMatch(/href|target=|rel=|tabindex|ping=|Sign in"/);
    expect(out).toContain('data-link-off');
    expect(out).toContain('aria-disabled="true"');
    expect(out).toContain('title="link turned off"');
    expect(out).toContain('text-decoration:underline dotted !important');
    expect(out).toContain('>Sign in</a></p>');
  });

  it('keeps a link\'s own style ahead of the turned-off look, and turns off image-map areas', () => {
    const out = turnOffLinks('<a style="color:red" HREF="x">a</a><map><area href="https://evil.example" shape="rect"></map>', 'off');
    expect(out).toContain('style="color:red;color:inherit !important;');
    expect(out).toMatch(/<area shape="rect" data-link-off aria-disabled="true" title="off">/);
    expect(out).not.toMatch(/href/i);
  });

  it('escapes the title it writes and leaves markup without links alone', () => {
    expect(turnOffLinks('<a href="x">a</a>', 'A & "B"')).toContain('title="A &amp; &quot;B&quot;"');
    const plain = '<p>No links <b>here</b></p>';
    expect(turnOffLinks(plain, 'off')).toBe(plain);
  });
});

describe('a reported message\'s document', () => {
  it('has no link address in an HTML body', () => {
    const { html } = prepareEmailHtml('<a href="https://evil.example">Pay now</a>', { linksOff: 'off' });
    expect(html).not.toContain('evil.example');
    expect(prepareEmailHtml('<a href="https://evil.example">Pay now</a>').html).toContain('https://evil.example');
  });

  it('has no link address in a plain-text body either', () => {
    const body = plainTextToSafeHtml('Pay at https://evil.example/pay now');
    expect(wrapPlainTextEmail(body, { linksOff: 'off' })).not.toContain('href="https://evil.example');
    expect(wrapPlainTextEmail(body)).toContain('href="https://evil.example/pay"');
  });

  it('is built apart from the same message before it was reported', () => {
    const input = {
      key: 'acc|e1', rawHtml: null, text: 'https://evil.example', emptyLabel: '', blockRemoteImages: true, cidMap: {},
      isDark: false, messageSpacing: 'auto' as const, plainTextFont: 'sans' as const, quoteLabels: { show: '', hide: '' },
    };
    expect(buildBodyDocument(input).html).toContain('href=');
    expect(buildBodyDocument({ ...input, linksOff: 'off' }).html).not.toContain('href=');
  });
});
